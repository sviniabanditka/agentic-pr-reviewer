<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { store } from "../store";
import ItemRow from "../components/ItemRow.vue";
import TBtn from "../components/TBtn.vue";
import TPrompt from "../components/TPrompt.vue";
import { toast } from "../components/toast";

const route = useRoute();
const router = useRouter();
const q = ref(String(route.query.q ?? ""));
const role = ref(String(route.query.role ?? "all"));
const state = ref(String(route.query.state ?? "open"));
const accountId = ref(String(route.query.account ?? ""));
const needs = ref(String(route.query.needs ?? ""));
const search = ref<HTMLInputElement | null>(null);
watch([q, role, state, accountId, needs], () =>
  router.replace({ query: { ...(q.value ? { q: q.value } : {}), ...(role.value !== "all" ? { role: role.value } : {}), ...(state.value !== "open" ? { state: state.value } : {}),
    ...(accountId.value ? { account: accountId.value } : {}), ...(needs.value ? { needs: needs.value } : {}), ...(route.query.review ? { review: route.query.review } : {}) } }),
);

const items = computed(() => {
  const term = q.value.trim().toLowerCase();
  return [...store.items.values()]
    .filter((i) => (state.value === "all" ? true : state.value === "open" ? i.state === "open" : i.state !== "open"))
    .filter((i) => role.value === "all" || (role.value === "review" ? i.role.includes("review") : role.value === "mine" ? i.role.startsWith("author") : i.role === "watching"))
    .filter((i) => !accountId.value || i.accountId === accountId.value)
    .filter((i) => {
      const r = i.lastReview;
      if (needs.value === "review") return !r || (r.status === "done" && r.head_sha !== i.headSha) || r.status === "error";
      if (needs.value === "post") return r?.status === "done" && !r.comment_url;
      return true;
    })
    .filter((i) => !term || `${i.repo} ${i.number} ${i.title} ${i.author}`.toLowerCase().includes(term))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
});

const addOpen = ref(false);
const addKind = ref<"pr" | "compare" | "patch">("pr");
const addUrl = ref("");
const cmp = ref({ repo: "", base: "", head: "" });
const patch = ref({ title: "", text: "", repo: "" });
const addAccount = ref(store.accounts[0]?.id ?? "");
const adding = ref(false);
async function addPr() {
  adding.value = true;
  try {
    const body = addKind.value === "pr" ? { url: addUrl.value }
      : addKind.value === "compare" ? { kind: "compare", ...cmp.value }
      : { kind: "patch", title: patch.value.title, patch: patch.value.text, ...(patch.value.repo ? { repo: patch.value.repo } : {}) };
    const { item } = await api.post<{ item: { id: string } }>("/items", { accountId: addAccount.value, ...body });
    addUrl.value = "";
    patch.value = { title: "", text: "", repo: "" };
    addOpen.value = false;
    toast(addKind.value === "pr" ? "pull request added" : addKind.value === "compare" ? "compare range added" : "patch added");
    await router.push(`/items/${item.id}`);
  } catch (e) {
    toast((e as Error).message, true);
  } finally {
    adding.value = false;
  }
}
const refreshing = ref(false);
async function refresh() {
  refreshing.value = true;
  await api.post("/poll").catch((e) => toast((e as Error).message, true));
  refreshing.value = false;
}

function onKey(e: KeyboardEvent) {
  if (e.key === "/" && !["INPUT", "SELECT", "TEXTAREA"].includes((document.activeElement as HTMLElement)?.tagName)) {
    e.preventDefault();
    search.value?.focus();
  }
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
const roles = [["all", "all"], ["review", "to review"], ["mine", "mine"], ["watching", "watching"]];
</script>

<template>
  <div class="grid gap-4">
    <div class="flex flex-wrap items-center gap-3">
      <TPrompt :level="1">inbox</TPrompt>
      <span class="text-tertiary">{{ items.length }} item{{ items.length === 1 ? "" : "s" }}</span>
      <div class="ml-auto flex items-center gap-1">
        <TBtn :busy="refreshing" @click="refresh">refresh</TBtn>
        <TBtn tone="primary" @click="addOpen = !addOpen">add</TBtn>
      </div>
    </div>

    <form v-if="addOpen" class="flex flex-wrap items-end gap-3 rounded-lg border border-subtle bg-surface px-4 py-3" @submit.prevent="addPr">
      <div class="flex w-full rounded-md border border-subtle bg-elevated p-0.5 sm:w-auto" role="group" aria-label="what to add">
        <button v-for="[v, l] in ([['pr', 'pull request'], ['compare', 'compare range'], ['patch', 'paste a patch']] as const)" :key="v" type="button" class="rounded-sm px-2 py-0.5"
          :class="addKind === v ? 'bg-active text-bright' : 'text-tertiary hover:text-secondary'" :aria-pressed="addKind === v" @click="addKind = v">{{ l }}</button>
      </div>
      <label v-if="addKind === 'pr'" class="min-w-64 flex-1"><span class="label">pull request url or owner/repo#number</span>
        <input v-model="addUrl" class="field" placeholder="https://github.com/owner/repo/pull/123" required autofocus></label>
      <template v-else-if="addKind === 'compare'">
        <label class="min-w-48 flex-1"><span class="label">repository</span><input v-model="cmp.repo" class="field" placeholder="owner/repo" required></label>
        <label><span class="label">base</span><input v-model="cmp.base" class="field" placeholder="main or a sha" required></label>
        <label><span class="label">head</span><input v-model="cmp.head" class="field" placeholder="feature or a sha" required></label>
      </template>
      <template v-else>
        <label class="min-w-48 flex-1"><span class="label">title</span><input v-model="patch.title" class="field" placeholder="what the change does" required></label>
        <label><span class="label">repository (optional, shown to the model)</span><input v-model="patch.repo" class="field" placeholder="owner/repo"></label>
        <label class="w-full"><span class="label">unified diff — git diff output; it is kept for the retention window, never posted</span>
          <textarea v-model="patch.text" class="field min-h-40 font-mono text-[12.5px]" placeholder="diff --git a/… b/…" required /></label>
      </template>
      <label><span class="label">as account</span>
        <select v-model="addAccount" class="field w-auto"><option v-for="a in store.accounts" :key="a.id" :value="a.id">{{ a.label }} (@{{ a.login }})</option></select></label>
      <TBtn type="submit" tone="primary" :busy="adding">add</TBtn>
    </form>

    <div class="flex flex-wrap items-center gap-3">
      <label class="flex min-w-64 flex-1 items-center gap-2 rounded-md border border-subtle bg-elevated px-3 py-1.5">
        <span class="text-ok">$</span>
        <input ref="search" v-model="q" class="w-full bg-transparent text-bright outline-none" placeholder="grep pull requests…" aria-label="filter pull requests">
        <kbd class="rounded-sm border border-subtle px-1 text-[11px] text-faint">/</kbd>
      </label>
      <div class="flex rounded-md border border-subtle bg-elevated p-0.5" role="group" aria-label="role">
        <button v-for="[v, l] in roles" :key="v" class="rounded-sm px-2 py-0.5" :class="role === v ? 'bg-active text-bright' : 'text-tertiary hover:text-secondary'" :aria-pressed="role === v" @click="role = v">{{ l }}</button>
      </div>
      <select v-model="needs" class="field w-auto" aria-label="needs"><option value="">any</option><option value="review">needs review</option><option value="post">unposted review</option></select>
      <select v-model="state" class="field w-auto" aria-label="state"><option value="open">open</option><option value="closed">closed / merged / unmatched</option><option value="all">all</option></select>
      <select v-if="store.accounts.length > 1" v-model="accountId" class="field w-auto" aria-label="account"><option value="">all accounts</option><option v-for="a in store.accounts" :key="a.id" :value="a.id">{{ a.label }}</option></select>
    </div>

    <ul class="m-0 grid gap-0.5 rounded-lg border border-subtle bg-surface p-1.5">
      <ItemRow v-for="i in items" :key="i.id" :item="i" :show-account="store.accounts.length > 1" />
      <li v-if="!items.length" class="list-none px-3 py-8 text-center text-tertiary">
        <template v-if="!store.targets.length">// no targets yet — add one on <RouterLink to="/targets" class="text-accent hover:underline">targets</RouterLink></template>
        <template v-else>// nothing matches. clear the filters, or press [ refresh ]</template>
      </li>
    </ul>
  </div>
</template>
