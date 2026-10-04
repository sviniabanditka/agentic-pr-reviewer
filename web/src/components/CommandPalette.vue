<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api";
import { accountOf, store } from "../store";
import { itemName, publishReview, startReview, preferredModel, preferredProfile } from "../actions";
import { palette, openAdd } from "./palette";
import { toast } from "./toast";

interface Entry { id: string; group: "Actions" | "Pull requests" | "Pages"; label: string; hint?: string; confirm?: string; run: () => unknown }

const router = useRouter();
const q = ref("");
const index = ref(0);
const armed = ref<string | null>(null);
const input = ref<HTMLInputElement | null>(null);

const entries = computed<Entry[]>(() => {
  const out: Entry[] = [];
  for (const i of [...store.items.values()].filter((x) => x.state === "open")) {
    const r = i.lastReview;
    const account = accountOf(i.accountId);
    const name = itemName(i);
    if (r?.status === "done" && !r.comment_url && i.kind === "pr") {
      out.push({ id: `post-${i.id}`, group: "Actions", label: `Post review to ${name}`, hint: `as @${account?.login ?? "?"}`, confirm: `Press Enter again to post as @${account?.login ?? "?"}`, run: () => publishReview(r.id) });
    }
    const busy = r?.status === "queued" || r?.status === "running";
    if (!busy && account?.credentialId && (!r || r.head_sha !== i.headSha || r.status === "error")) {
      out.push({ id: `review-${i.id}`, group: "Actions", label: `Review ${name}`, hint: r ? "new commits" : "not reviewed yet", run: () => startReview(i.id, preferredModel(i.id, account.model), preferredProfile(i.id, account.profileId)) });
    }
    out.push({ id: `open-${i.id}`, group: "Pull requests", label: i.title, hint: name, run: () => router.push({ path: "/", query: { item: i.id } }) });
  }
  out.push({ id: "add", group: "Actions", label: "Add a pull request, compare or patch", run: () => (router.push("/"), openAdd()) });
  out.push({ id: "poll", group: "Actions", label: "Check all targets for new pull requests", run: async () => (await api.post("/poll"), toast("checking targets")) });
  const pages = [["Inbox", "/"], ["Targets", "/targets"], ["Profiles", "/profiles"], ["Accounts", "/accounts"], ["Activity", "/activity"], ["Settings", "/settings"], ...(store.user?.role === "admin" ? [["Admin", "/admin"]] : [])];
  for (const [label, to] of pages) out.push({ id: `page-${to}`, group: "Pages", label: `Go to ${label}`, run: () => router.push(to!) });
  return out;
});

const shown = computed(() => {
  const term = q.value.trim().toLowerCase();
  const list = term ? entries.value.filter((e) => `${e.label} ${e.hint ?? ""}`.toLowerCase().includes(term)) : entries.value.filter((e) => e.group !== "Pull requests");
  return list.slice(0, 40);
});
const groups = computed(() => {
  const g: { name: string; items: { e: Entry; n: number }[] }[] = [];
  shown.value.forEach((e, n) => {
    let last = g[g.length - 1];
    if (!last || last.name !== e.group) g.push((last = { name: e.group, items: [] }));
    last.items.push({ e, n });
  });
  return g;
});

watch(() => palette.open, async (open) => {
  if (!open) return;
  q.value = "";
  index.value = 0;
  armed.value = null;
  await nextTick();
  input.value?.focus();
});
watch(q, () => ((index.value = 0), (armed.value = null)));

async function run(e: Entry | undefined) {
  if (!e) return;
  if (e.confirm && armed.value !== e.id) {
    armed.value = e.id;
    return;
  }
  palette.open = false;
  await e.run();
}
function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    palette.open = !palette.open;
    return;
  }
  if (!palette.open) return;
  if (e.key === "Escape") palette.open = false;
  else if (e.key === "ArrowDown") ((index.value = Math.min(index.value + 1, shown.value.length - 1)), e.preventDefault());
  else if (e.key === "ArrowUp") ((index.value = Math.max(index.value - 1, 0)), e.preventDefault());
  else if (e.key === "Enter") (e.preventDefault(), void run(shown.value[index.value]));
}
window.addEventListener("keydown", onKey);
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <Teleport to="body">
    <div v-if="palette.open" class="fixed inset-0 z-[55] bg-black/55" @click="palette.open = false" />
    <div v-if="palette.open" role="dialog" aria-modal="true" aria-label="Search and commands"
      class="fixed left-1/2 top-[14vh] z-[56] w-[min(640px,calc(100%-32px))] -translate-x-1/2 overflow-hidden rounded-[14px] border border-[#30313a] bg-[#1e1f25] shadow-2xl shadow-black/50">
      <label class="flex items-center gap-2.5 border-b border-[#2a2b33] px-4 py-3.5">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7e7e8a" stroke-width="1.6" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="M20 20l-4-4" /></svg>
        <input ref="input" v-model="q" class="flex-1 bg-transparent text-[15px] text-bright outline-none placeholder:text-tertiary" placeholder="Search pull requests, actions and pages" aria-label="Search">
        <kbd class="rounded border border-[#30313a] px-1.5 font-mono text-[11px] text-tertiary">esc</kbd>
      </label>
      <div class="max-h-[60vh] overflow-y-auto p-2">
        <div v-for="g in groups" :key="g.name">
          <div class="px-2.5 pb-1 pt-2 text-xs text-tertiary">{{ g.name }}</div>
          <button v-for="{ e, n } in g.items" :key="e.id" class="flex w-full cursor-pointer items-center gap-3 rounded-[9px] px-3 py-2.5 text-left"
            :class="n === index ? 'bg-[#2a2836]' : 'hover:bg-hover'" @mouseenter="index = n" @click="run(e)">
            <span class="min-w-0 flex-1 truncate" :class="armed === e.id ? 'text-warn' : 'text-bright'">{{ armed === e.id ? e.confirm : e.label }}</span>
            <span v-if="e.hint && armed !== e.id" class="shrink-0 text-xs text-tertiary">{{ e.hint }}</span>
            <kbd v-if="n === index" class="font-mono text-[11px] text-tertiary">↵</kbd>
          </button>
        </div>
        <p v-if="!shown.length" class="px-3 py-6 text-center text-tertiary">Nothing matches “{{ q }}”.</p>
      </div>
    </div>
  </Teleport>
</template>
