<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { accountOf, store } from "../store";
import { itemName } from "../actions";
import { NEW_COMMITS, reviewTone, roleLabel, sha7, stamp } from "../format";
import type { Item } from "../types";
import ReviewPanel from "../components/ReviewPanel.vue";
import ItemStart from "../components/ItemStart.vue";
import AddDialog from "../components/AddDialog.vue";
import Welcome from "../components/Welcome.vue";
import Menu from "../components/Menu.vue";
import MenuItem from "../components/MenuItem.vue";
import TBtn from "../components/TBtn.vue";
import Rel from "../components/Rel.vue";
import { openAdd, openPalette } from "../components/palette";
import { toast } from "../components/toast";

const route = useRoute();
const router = useRouter();
type View = "needs" | "running" | "done" | "all";
const view = ref<View>((route.query.view as View) ?? "needs");
const accountId = ref(String(route.query.account ?? ""));
const role = ref(String(route.query.role ?? ""));
const repo = ref(String(route.query.repo ?? ""));
watch([view, accountId, role, repo], () => router.replace({ query: {
  ...route.query, view: view.value === "needs" ? undefined : view.value, account: accountId.value || undefined, role: role.value || undefined, repo: repo.value || undefined,
} }));

const moved = (i: Item) => i.lastReview?.status === "done" && !!i.headSha && i.lastReview.head_sha !== i.headSha;
function bucket(i: Item): Exclude<View, "all"> {
  const r = i.lastReview;
  if (r && (r.status === "queued" || r.status === "running")) return "running";
  if (i.state !== "open") return "done";
  if (!r || r.status === "error" || moved(i) || (r.status === "done" && !r.comment_url && i.kind === "pr")) return "needs";
  return "done";
}
const base = computed(() => [...store.items.values()]
  .filter((i) => i.state !== "archived" || view.value === "all")
  .filter((i) => !accountId.value || i.accountId === accountId.value)
  .filter((i) => !role.value || (role.value === "review" ? i.role.includes("review") : role.value === "mine" ? i.role.startsWith("author") : i.role === "watching"))
  .filter((i) => !repo.value || i.repo === repo.value));
const counts = computed(() => {
  const c = { needs: 0, running: 0, done: 0, all: base.value.length };
  for (const i of base.value) c[bucket(i)]++;
  return c;
});
const items = computed(() => base.value
  .filter((i) => view.value === "all" || bucket(i) === view.value)
  .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")));
const repos = computed(() => [...new Set([...store.items.values()].map((i) => i.repo))].sort());

const selected = computed<Item | undefined>(() => {
  if (route.query.item) return store.items.get(String(route.query.item));
  if (route.query.review) {
    const r = store.reviews.get(Number(route.query.review));
    if (r?.item_id) return store.items.get(r.item_id);
  }
  return items.value[0];
});
const reviewId = computed(() => (route.query.review ? Number(route.query.review) : selected.value?.lastReview?.id ?? null));
const history = computed(() => (selected.value ? [...store.reviews.values()].filter((r) => r.item_id === selected.value!.id).sort((a, b) => b.id - a.id) : []));
const select = (i: Item) => router.push({ query: { ...route.query, item: i.id, review: undefined } });
const showReview = (id: number) => router.push({ query: { ...route.query, review: String(id) } });
const newReview = () => selected.value && router.push({ query: { ...route.query, item: selected.value.id, review: undefined, fresh: "1" } });

function rowTone(i: Item) {
  return moved(i) ? NEW_COMMITS : reviewTone(i.lastReview, i.lastReview ? store.stages[i.lastReview.id] : null);
}
const SEG = (on: boolean, color: string) => ({ background: on ? color : "#33343c" });

const refreshing = ref(false);
async function refresh() {
  refreshing.value = true;
  await api.post("/poll").catch((e) => toast((e as Error).message, true));
  refreshing.value = false;
}
async function archive(i: Item, back = false) {
  try {
    await api.post(`/items/${i.id}/${back ? "unarchive" : "archive"}`);
    toast(back ? "Back in the inbox" : "Archived");
  } catch (e) {
    toast((e as Error).message, true);
  }
}
const chips: { id: View; label: string }[] = [{ id: "needs", label: "Needs me" }, { id: "running", label: "Running" }, { id: "done", label: "Done" }, { id: "all", label: "All" }];
</script>

<template>
  <div v-if="!store.items.size && (!store.targets.length || !store.accounts.some((a) => a.credentialId))">
    <Welcome />
    <AddDialog />
  </div>
  <div v-else class="flex min-h-screen flex-wrap">
    <section aria-label="Pull requests" class="flex min-w-0 max-w-[520px] flex-[1_1_420px] flex-col border-r border-subtle">
      <div class="flex items-center gap-2 px-[18px] pb-3 pt-[18px]">
        <h1 class="m-0 text-base font-semibold text-bright">Inbox</h1>
        <button class="ml-auto flex cursor-pointer items-center gap-2 rounded-lg border border-strong px-2.5 py-1.5 text-[12.5px] text-tertiary hover:text-bright" @click="openPalette">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="M20 20l-4-4" /></svg>Search <kbd class="font-mono text-[11px]">⌘K</kbd>
        </button>
        <TBtn tone="primary" size="sm" @click="openAdd">+ Add</TBtn>
      </div>
      <div role="group" aria-label="Status" class="flex gap-1 overflow-x-auto px-[18px] pb-2.5">
        <button v-for="c in chips" :key="c.id" class="pill" :aria-pressed="view === c.id" @click="view = c.id">{{ c.label }} <span class="text-tertiary">{{ counts[c.id] }}</span></button>
      </div>
      <div class="flex flex-wrap items-center gap-1.5 border-b border-subtle px-[18px] pb-3.5">
        <select v-if="store.accounts.length > 1" v-model="accountId" class="field w-auto py-1 text-[12.5px]" aria-label="Account"><option value="">All accounts</option><option v-for="a in store.accounts" :key="a.id" :value="a.id">{{ a.label }}</option></select>
        <select v-model="role" class="field w-auto py-1 text-[12.5px]" aria-label="Role"><option value="">Any role</option><option value="review">To review</option><option value="mine">Mine</option><option value="watching">Watching</option></select>
        <select v-model="repo" class="field w-auto max-w-44 py-1 text-[12.5px]" aria-label="Repository"><option value="">All repositories</option><option v-for="r in repos" :key="r" :value="r">{{ r.split("/")[1] }}</option></select>
        <TBtn class="ml-auto" tone="ghost" size="sm" :busy="refreshing" @click="refresh">Refresh</TBtn>
      </div>
      <ul class="m-0 flex-1 list-none p-0 py-2">
        <li v-for="i in items" :key="i.id">
          <button class="mx-2 mb-0.5 block w-[calc(100%-16px)] cursor-pointer rounded-[10px] px-3.5 py-2.5 text-left" :class="selected?.id === i.id ? 'bg-hover' : 'hover:bg-[#1b1c21]'" @click="select(i)">
            <span class="flex items-center gap-2.5">
              <span class="min-w-0 flex-1 truncate text-bright">{{ i.title }}</span>
              <span class="chip" :style="{ color: rowTone(i).fg, background: rowTone(i).bg }">{{ rowTone(i).label }}</span>
            </span>
            <span class="mt-1 flex items-center gap-2 text-xs text-tertiary">
              <span>{{ itemName(i) }}</span><span class="text-faint">·</span><span>{{ roleLabel(i.role) }}</span>
              <span v-if="store.accounts.length > 1" class="text-faint">· {{ accountOf(i.accountId)?.label }}</span>
              <span class="ml-auto flex gap-[3px]" aria-hidden="true">
                <span v-for="n in 3" :key="n" class="h-1 w-3 rounded-sm" :style="SEG(n <= rowTone(i).step, rowTone(i).fg)" />
              </span>
            </span>
          </button>
        </li>
        <li v-if="!items.length" class="px-6 py-10 text-center text-[13px] text-tertiary">
          <template v-if="!store.accounts.length">Start on <RouterLink to="/accounts" class="link">Accounts</RouterLink>: add a GitHub account and a Claude credential.</template>
          <template v-else-if="!store.targets.length">Nothing here yet. Add a <RouterLink to="/targets" class="link">target</RouterLink> that finds pull requests, or press + Add.</template>
          <template v-else-if="view === 'needs'">Nothing needs you. <button class="link cursor-pointer" @click="view = 'all'">Show all</button></template>
          <template v-else>Nothing matches these filters.</template>
        </li>
      </ul>
    </section>

    <div class="min-w-0 flex-[999_1_560px]">
      <template v-if="selected">
        <ReviewPanel v-if="reviewId && !route.query.fresh" :review-id="reviewId">
          <template #actions>
            <Menu width="300px">
              <template #trigger="{ toggle }"><TBtn tone="ghost" @click="toggle">History{{ history.length > 1 ? ` ${history.length}` : "" }} ▾</TBtn></template>
              <template #default="{ close }">
                <MenuItem v-for="r in history.slice(0, 12)" :key="r.id" :hint="`${stamp(r.created_at)} · ${r.model ?? ''} · ${r.profile_name ?? 'Triage'}`" @click="(close(), showReview(r.id))">
                  {{ r.id === reviewId ? "✓ " : "" }}#{{ r.id }} {{ sha7(r.head_sha) }} — {{ reviewTone(r).label }}
                </MenuItem>
                <MenuItem hint="pick a profile and model" @click="(close(), newReview())">New review…</MenuItem>
                <MenuItem v-if="selected.state !== 'archived'" @click="(close(), archive(selected))">Archive</MenuItem>
                <MenuItem v-else @click="(close(), archive(selected, true))">Back to the inbox</MenuItem>
              </template>
            </Menu>
          </template>
        </ReviewPanel>
        <ItemStart v-else :item="selected" @started="(id) => router.push({ query: { ...route.query, fresh: undefined, review: String(id) } })">
          <template #actions>
            <TBtn v-if="route.query.fresh && selected.lastReview" tone="ghost" @click="router.push({ query: { ...route.query, fresh: undefined } })">Back to the review</TBtn>
            <TBtn v-if="selected.state !== 'archived'" tone="ghost" @click="archive(selected)">Archive</TBtn>
          </template>
        </ItemStart>
      </template>
      <div v-else class="grid h-full place-items-center p-10 text-tertiary">Pick a pull request on the left.</div>
      <p v-if="selected && selected.updatedAt" class="sr-only">Updated <Rel :ts="Date.parse(selected.updatedAt)" /></p>
    </div>
    <AddDialog />
  </div>
</template>
