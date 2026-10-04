<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api";
import { store } from "../store";
import { startReview } from "../actions";
import TBtn from "./TBtn.vue";
import { palette } from "./palette";
import { toast } from "./toast";

const router = useRouter();
const kind = ref<"pr" | "compare" | "patch">("pr");
const url = ref("");
const cmp = ref({ repo: "", base: "", head: "" });
const patch = ref({ title: "", text: "", repo: "" });
const accountId = ref("");
const reviewNow = ref(true);
const profileId = ref("");
const model = ref("");
const busy = ref(false);
const first = ref<HTMLInputElement | null>(null);

const account = computed(() => store.accounts.find((a) => a.id === accountId.value));
watch(() => palette.addOpen, async (open) => {
  if (!open) return;
  accountId.value ||= store.accounts.find((a) => a.credentialId)?.id ?? store.accounts[0]?.id ?? "";
  profileId.value ||= account.value?.profileId ?? store.profiles.find((p) => p.isDefault)?.id ?? "";
  model.value ||= account.value?.model ?? store.models[0] ?? "";
  await nextTick();
  first.value?.focus();
});
const close = () => (palette.addOpen = false);

async function submit() {
  busy.value = true;
  try {
    const body = kind.value === "pr" ? { url: url.value }
      : kind.value === "compare" ? { kind: "compare", ...cmp.value }
      : { kind: "patch", title: patch.value.title, patch: patch.value.text, ...(patch.value.repo ? { repo: patch.value.repo } : {}) };
    const { item } = await api.post<{ item: { id: string } }>("/items", { accountId: accountId.value, ...body });
    url.value = "";
    patch.value = { title: "", text: "", repo: "" };
    close();
    await router.push({ path: "/", query: { item: item.id } });
    // The SSE row may arrive after the response; give it a moment before reviewing.
    if (reviewNow.value && account.value?.credentialId) setTimeout(() => void startReview(item.id, model.value || undefined, profileId.value || undefined), 300);
    else toast("Added to the inbox");
  } catch (e) {
    toast((e as Error).message, true);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="palette.addOpen" class="fixed inset-0 z-50 bg-black/60" @click="close" />
    <div v-if="palette.addOpen" role="dialog" aria-modal="true" aria-labelledby="add-title" class="fixed left-1/2 top-[10vh] z-[51] w-[min(600px,calc(100%-32px))] -translate-x-1/2 rounded-2xl border border-[#30313a] bg-surface shadow-2xl shadow-black/50" @keydown.esc="close">
      <form @submit.prevent="submit">
        <div class="flex items-center gap-2 px-6 pt-5">
          <h2 id="add-title" class="m-0 text-[17px] font-semibold text-bright">Add to inbox</h2>
          <button type="button" class="ml-auto grid size-8 cursor-pointer place-items-center rounded-lg text-lg text-secondary hover:bg-hover" aria-label="Close" @click="close">×</button>
        </div>
        <div role="tablist" class="flex gap-5 border-b border-[#2a2b32] px-6 pt-3">
          <button type="button" role="tab" class="tab" :aria-selected="kind === 'pr'" @click="kind = 'pr'">Pull request</button>
          <button type="button" role="tab" class="tab" :aria-selected="kind === 'compare'" @click="kind = 'compare'">Compare two refs</button>
          <button type="button" role="tab" class="tab" :aria-selected="kind === 'patch'" @click="kind = 'patch'">Paste a patch</button>
        </div>
        <div class="grid gap-4 px-6 py-5">
          <label v-if="kind === 'pr'"><span class="label">Link or owner/repo#number</span>
            <input ref="first" v-model="url" class="field font-mono text-[13px]" placeholder="https://github.com/owner/repo/pull/123" required></label>
          <div v-else-if="kind === 'compare'" class="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
            <label><span class="label">Repository</span><input ref="first" v-model="cmp.repo" class="field" placeholder="owner/repo" required></label>
            <label><span class="label">Base</span><input v-model="cmp.base" class="field" placeholder="main" required></label>
            <label><span class="label">Head</span><input v-model="cmp.head" class="field" placeholder="feature" required></label>
          </div>
          <template v-else>
            <div class="grid gap-3 sm:grid-cols-2">
              <label><span class="label">Title</span><input ref="first" v-model="patch.title" class="field" placeholder="What the change does" required></label>
              <label><span class="label">Repository (optional, shown to the model)</span><input v-model="patch.repo" class="field" placeholder="owner/repo"></label>
            </div>
            <label><span class="label">Unified diff (git diff output). Kept for the retention window, never posted.</span>
              <textarea v-model="patch.text" class="field min-h-40 font-mono text-xs" placeholder="diff --git a/… b/…" required /></label>
          </template>
          <label><span class="label">{{ kind === "patch" ? "Review it with" : "Read it as" }}</span>
            <select v-model="accountId" class="field" required><option v-for="a in store.accounts" :key="a.id" :value="a.id">{{ a.label }} · @{{ a.login }}</option></select></label>
          <div class="panel grid gap-2.5 px-4 py-3.5">
            <label class="flex items-center gap-2.5"><input v-model="reviewNow" type="checkbox" class="accent-accent" :disabled="!account?.credentialId"> Start a review right away</label>
            <div v-if="reviewNow" class="grid gap-2.5 sm:grid-cols-2">
              <label><span class="label">Profile</span><select v-model="profileId" class="field"><option v-for="p in store.profiles" :key="p.id" :value="p.id">{{ p.name }}</option></select></label>
              <label><span class="label">Model</span><select v-model="model" class="field"><option v-for="m in store.models" :key="m" :value="m">{{ m }}</option></select></label>
            </div>
            <span class="text-xs text-tertiary">{{ account?.credentialId ? "The result stays here until you press Post." : "This account has no Claude credential yet; add one on Accounts to review." }}</span>
          </div>
        </div>
        <div class="flex justify-end gap-2 border-t border-[#2a2b32] px-6 py-4">
          <TBtn @click="close">Cancel</TBtn>
          <TBtn type="submit" tone="primary" :busy="busy">{{ reviewNow && account?.credentialId ? "Add and review" : "Add" }}</TBtn>
        </div>
      </form>
    </div>
  </Teleport>
</template>
