<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "../api";
import { accountOf, onReviewChange, store } from "../store";
import { cancelReview, itemName, publishReview, startReview } from "../actions";
import { BLOCKING, clock, dur, reviewTone, roleLabel, sha7, stamp } from "../format";
import type { Finding, LogEvent, Output, Review, ReviewResult, Run } from "../types";
import TBtn from "./TBtn.vue";
import Menu from "./Menu.vue";
import MenuItem from "./MenuItem.vue";
import { toast } from "./toast";

const props = defineProps<{ reviewId: number; drawer?: boolean }>();
const data = ref<{ review: Review; result: ReviewResult | null; events: LogEvent[]; runs: Run[]; outputs: Output[]; purged: boolean } | null>(null);
const loading = ref(false);
const posting = ref(false);
const output = ref<"pr-comment" | "pr-review">("pr-comment");
const tab = ref<"findings" | "runs" | "log" | "compare">("findings");
const compareWith = ref<number | "">("");
const comparison = ref<{ onlyA: Finding[]; onlyB: Finding[]; both: Finding[] } | null>(null);

async function load(id: number) {
  loading.value = true;
  try {
    data.value = await api.get(`/reviews/${id}`);
  } catch (e) {
    data.value = null;
    toast((e as Error).message, true);
  } finally {
    loading.value = false;
  }
}
watch(() => props.reviewId, (id) => {
  comparison.value = null;
  compareWith.value = "";
  tab.value = "findings";
  void load(id);
}, { immediate: true });
onReviewChange((r, prev) => {
  if (r.id === props.reviewId && (prev?.status !== r.status || prev?.comment_url !== r.comment_url)) void load(r.id);
});

const live = computed(() => (data.value ? { ...data.value.review, ...(store.reviews.get(data.value.review.id) ?? {}) } : null));
const item = computed(() => (live.value?.item_id ? store.items.get(live.value.item_id) : undefined));
const account = computed(() => accountOf(live.value?.account_id));
const isPr = computed(() => !item.value || item.value.kind === "pr");
const name = computed(() => (live.value ? itemName({ ...live.value, kind: item.value?.kind }) : ""));
const tone = computed(() => reviewTone(live.value, live.value ? store.stages[live.value.id] : null));
const busy = computed(() => (item.value ? [...store.reviews.values()].some((r) => r.item_id === item.value!.id && (r.status === "queued" || r.status === "running")) : false));
const moved = computed(() => !!item.value?.headSha && !!live.value && item.value.headSha !== live.value.head_sha);
const siblings = computed(() =>
  live.value ? [...store.reviews.values()].filter((o) => o.id !== live.value!.id && o.item_id === live.value!.item_id && o.status === "done").sort((a, b) => b.id - a.id) : [],
);

const groups = computed(() => {
  const res = data.value?.result;
  if (!res) return [];
  const confirmed = new Set(res.confirmedMarkers);
  const blockingSet = res.blocking ?? BLOCKING;
  const isConfirmed = (f: Finding) => (f.marker ? confirmed.has(f.marker) : [...confirmed].some((m) => m.includes(`:${f.category}:${f.file}:`)));
  const open = res.findings.filter((f) => !f.dismissed);
  const blocking = open.filter((f) => blockingSet.includes(f.category) && f.evidenceCheck !== "not_found");
  return [
    { title: "Blocking", list: blocking.filter(isConfirmed), tone: "danger" },
    { title: "Blocking, not confirmed by a second run", list: blocking.filter((f) => !isConfirmed(f)), tone: "warn" },
    { title: "Notes", list: open.filter((f) => !blockingSet.includes(f.category) && f.evidenceCheck !== "not_found"), tone: "accent" },
    { title: "Low confidence — the quoted code is not in the diff", list: open.filter((f) => f.evidenceCheck === "not_found"), tone: "faint" },
    { title: "Fixed since the last review", list: res.incremental?.fixed ?? [], tone: "ok" },
    { title: "Dismissed", list: res.findings.filter((f) => f.dismissed), tone: "faint" },
  ].filter((g) => g.list.length);
});
const findingCount = computed(() => data.value?.result?.findings.filter((f) => !f.dismissed).length ?? 0);
const TONE: Record<string, string> = { danger: "#ff9c86", warn: "#f2b880", accent: "#b4a6ff", faint: "#7e7e8a", ok: "#8bd3a3" };
const prettyCategory = (c: string) => c.charAt(0) + c.slice(1).toLowerCase().replace(/-/g, " ");

function lineLink(f: Finding) {
  const r = live.value!;
  const anchor = f.line_start === f.line_end ? `L${f.line_start}` : `L${f.line_start}-L${f.line_end}`;
  return `https://github.com/${r.repo}/blob/${r.head_sha}/${f.file}#${anchor}`;
}
async function post() {
  posting.value = true;
  if (await publishReview(live.value!.id, output.value)) void load(live.value!.id);
  posting.value = false;
}
async function dismiss(f: Finding, undo = false) {
  if (!f.marker) return;
  try {
    const path = `/reviews/${live.value!.id}/dismissals`;
    const r = undo
      ? await fetch(`/api/v1${path}`, { method: "DELETE", headers: { "content-type": "application/json", "x-requested-with": "fetch" }, body: JSON.stringify({ marker: f.marker }) }).then((x) => x.json())
      : await api.post<{ result: ReviewResult }>(path, { marker: f.marker });
    if (data.value) data.value.result = r.result;
    toast(undo ? "Finding restored" : "Finding dismissed: it no longer blocks or shows in the comment");
  } catch (e) {
    toast((e as Error).message, true);
  }
}
async function runCompare() {
  if (!compareWith.value) return;
  try {
    comparison.value = await api.get(`/reviews/${live.value!.id}/compare/${compareWith.value}`);
  } catch (e) {
    toast((e as Error).message, true);
  }
}
async function copy(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied");
  } catch {
    toast("Could not copy the link", true);
  }
}
const again = (incremental = false) => item.value && startReview(item.value.id, live.value!.model ?? undefined, live.value!.profile_id ?? undefined, incremental);
</script>

<template>
  <div v-if="!live" class="p-8 text-tertiary">{{ loading ? "Loading…" : "Review not found." }}</div>
  <div v-else class="flex min-h-full flex-col">
    <div class="flex flex-wrap items-center gap-2 border-b border-subtle py-3.5 pl-8" :class="drawer ? 'pr-14' : 'pr-8'">
      <span class="text-[13px] text-tertiary">{{ name }} · as {{ account?.label ?? live.account }} · review #{{ live.id }}</span>
      <span class="ml-auto" />
      <slot name="actions" />
      <a v-if="live.url" :href="live.url" target="_blank" rel="noopener" class="rounded-md border border-strong px-3 py-1.5 text-[13px] text-bright hover:bg-hover">Open on GitHub</a>
      <Menu v-if="data?.result" width="200px">
        <template #trigger="{ toggle }"><TBtn @click="toggle">Export ▾</TBtn></template>
        <MenuItem :href="`/api/v1/reviews/${live.id}/export.md`" hint="for a ticket or a chat">Markdown</MenuItem>
        <MenuItem :href="`/api/v1/reviews/${live.id}/export.json`" hint="everything, machine-readable">JSON</MenuItem>
      </Menu>
      <TBtn v-if="live.status === 'queued' || live.status === 'running'" tone="danger" :confirm="live.status === 'running' ? 'Stop the model run?' : undefined" @click="cancelReview(live.id)">Cancel</TBtn>
      <Menu v-else-if="item && item.state === 'open'" width="260px">
        <template #trigger="{ toggle }"><TBtn :disabled="busy" @click="toggle">Review again ▾</TBtn></template>
        <template #default="{ close }">
          <MenuItem :hint="`${(live.profile_name ?? 'Triage')} with ${live.model ?? 'the default model'}`" @click="(close(), again())">The whole pull request</MenuItem>
          <MenuItem v-if="isPr && live.status === 'done' && moved" :hint="`only the commits after ${sha7(live.head_sha)}`" @click="(close(), again(true))">New commits only</MenuItem>
        </template>
      </Menu>
      <span v-if="live.status === 'done' && isPr && data?.result" class="inline-flex">
        <TBtn tone="primary" :busy="posting" class="rounded-r-none" :confirm="`Post as @${account?.login ?? '?'}?`" @click="post">
          {{ output === "pr-review" ? "Post as review" : live.comment_url ? "Update comment" : "Post to PR" }}
        </TBtn>
        <Menu width="290px">
          <template #trigger="{ toggle }">
            <button class="cursor-pointer rounded-r-md border-l border-[#7e6fe0] bg-accent px-2 text-on-accent hover:bg-[#ae9fff]" aria-label="How to post" @click="toggle">▾</button>
          </template>
          <template #default="{ close }">
            <MenuItem hint="edited in place on every re-post" @click="(output = 'pr-comment', close())">{{ output === "pr-comment" ? "✓ " : "" }}As one comment</MenuItem>
            <MenuItem hint="inline comments on the lines; a new review each time" @click="(output = 'pr-review', close())">{{ output === "pr-review" ? "✓ " : "" }}As a review with inline comments</MenuItem>
          </template>
        </Menu>
      </span>
    </div>

    <div class="grid max-w-[880px] gap-5 px-8 py-6">
      <h2 class="m-0 text-[22px] font-semibold leading-snug tracking-tight text-bright">{{ live.title }}</h2>
      <div class="-mt-2 flex flex-wrap gap-1.5">
        <span class="chip" :style="{ color: tone.fg, background: tone.bg }">{{ live.status === "done" ? live.verdict_title || tone.label : tone.label }}</span>
        <span v-if="live.status === 'done' && isPr" class="chip">{{ live.comment_url ? "posted" : "not posted" }}</span>
        <span class="chip font-mono">{{ sha7(live.head_sha) }}</span>
        <span v-if="live.model" class="chip">{{ live.model }}</span>
        <span class="chip">{{ live.profile_name ?? "Triage" }}</span>
        <span v-if="live.finished_at && live.started_at" class="chip">{{ dur(live.finished_at - live.started_at) }}{{ live.cached ? " · cached" : live.runs ? ` · ${live.runs} run${live.runs > 1 ? "s" : ""}` : "" }}</span>
        <span v-else-if="live.started_at" class="chip">{{ dur(store.now - live.started_at) }}</span>
        <span v-if="live.kind === 'incremental'" class="chip">new commits only</span>
        <span v-if="live.auto_post" class="chip text-danger">auto-post</span>
        <span class="chip">{{ roleLabel(live.role) }}</span>
      </div>

      <div v-if="live.status === 'error'" class="rounded-xl bg-warn-bg px-4 py-3 text-warn">Failed: {{ live.error ?? "unknown error" }}</div>
      <div v-if="output === 'pr-review' && live.status === 'done' && isPr" class="rounded-xl bg-warn-bg px-4 py-3 text-[13px] text-warn">
        A GitHub review cannot be edited: every post adds a new one. Inline comments go only on quoted lines the diff still has.
        <template v-if="live.role.includes('review')"> Posting it as a requested reviewer clears your review request.</template>
      </div>
      <p v-if="live.status === 'done' && isPr && !live.comment_url && moved" class="hint">The pull request moved on to {{ sha7(item?.headSha) }}; this review covers {{ sha7(live.head_sha) }}.</p>
      <p v-if="data?.purged" class="hint">The findings were removed by retention; the verdict and numbers stay.</p>
      <p v-if="live.kind === 'incremental' && data?.result?.incremental" class="hint">Only the commits after {{ sha7(data.result.incremental.baseSha) }} went to the model; earlier findings were checked against the whole pull request.</p>
      <p v-if="!isPr && live.status === 'done'" class="hint">A {{ item?.kind === "patch" ? "pasted patch" : "compare range" }} has no pull request to post to; export it instead.</p>
      <div v-if="live.comment_url" class="flex flex-wrap items-center gap-2 text-[13px]">
        <a :href="live.comment_url" target="_blank" rel="noopener" class="link">Open the comment ↗</a>
        <button class="cursor-pointer text-tertiary hover:text-bright" @click="copy(live.comment_url)">Copy link</button>
      </div>

      <div role="tablist" class="flex gap-5 border-b border-subtle">
        <button role="tab" class="tab" :aria-selected="tab === 'findings'" @click="tab = 'findings'">Findings{{ findingCount ? ` ${findingCount}` : "" }}</button>
        <button role="tab" class="tab" :aria-selected="tab === 'runs'" @click="tab = 'runs'">Runs{{ data?.runs.length ? ` ${data.runs.length}` : "" }}</button>
        <button role="tab" class="tab" :aria-selected="tab === 'log'" @click="tab = 'log'">Log</button>
        <button v-if="siblings.length && data?.result" role="tab" class="tab" :aria-selected="tab === 'compare'" @click="tab = 'compare'">Compare</button>
      </div>

      <template v-if="tab === 'findings'">
        <section v-if="data?.result?.summary" class="card grid gap-3 px-5 py-4">
          <div class="text-xs text-tertiary">Pull request description draft</div>
          <div class="font-medium text-bright">{{ data.result.summary.title }}</div>
          <p class="m-0 text-secondary">{{ data.result.summary.summary }}</p>
          <div v-for="[label, list] in ([['Changes', data.result.summary.changes], ['Risks', data.result.summary.risks], ['How to test', data.result.summary.testing]] as const)" :key="label">
            <template v-if="list.length"><div class="text-xs text-tertiary">{{ label }}</div><ul class="m-0 pl-5 text-secondary"><li v-for="(x, i) in list" :key="i">{{ x }}</li></ul></template>
          </div>
        </section>
        <section v-for="g in groups" :key="g.title" class="grid gap-2.5">
          <h3 class="m-0 text-[13px] font-medium" :style="{ color: TONE[g.tone] }">{{ g.title }} <span class="text-tertiary">{{ g.list.length }}</span></h3>
          <article v-for="(f, i) in g.list" :key="i" class="grid gap-2 rounded-xl px-4 py-3.5" :class="g.tone === 'danger' ? 'bg-surface' : 'border border-subtle'">
            <div class="flex flex-wrap items-center gap-2.5 text-[12.5px]">
              <span :style="{ color: TONE[g.tone] }">{{ prettyCategory(f.category) }}</span>
              <a v-if="isPr" :href="lineLink(f)" target="_blank" rel="noopener" class="link font-mono text-xs">{{ f.file }}:{{ f.line_start }}{{ f.line_end !== f.line_start ? `-${f.line_end}` : "" }}</a>
              <span v-else class="font-mono text-xs text-tertiary">{{ f.file }}:{{ f.line_start }}</span>
              <span v-if="f.state === 'new' && live.kind === 'incremental'" class="chip text-ok">new</span>
              <span v-if="f.state === 'still_open'" class="chip">still open</span>
              <span v-if="f.dismissNote" class="text-faint">{{ f.dismissNote }}</span>
              <TBtn v-if="f.marker && g.tone !== 'ok' && live.item_id" class="ml-auto" size="sm" :tone="f.dismissed ? 'default' : 'ghost'" @click="dismiss(f, f.dismissed)">{{ f.dismissed ? "Restore" : "Dismiss" }}</TBtn>
            </div>
            <div class="text-bright">{{ f.claim }}</div>
            <div class="text-[13px] text-secondary">{{ f.detail }}</div>
            <pre v-if="f.evidence" class="m-0 overflow-x-auto rounded-lg bg-base px-3 py-2.5 text-xs" :style="{ color: g.tone === 'danger' ? '#ffb1a1' : '#c3c3cb' }">{{ f.evidence }}</pre>
          </article>
        </section>
        <p v-if="data?.result && !data.result.findings.length && !data.result.summary && !groups.length" class="hint">No findings in this diff.</p>
        <section v-if="data?.result?.skippedFiles?.length" class="grid gap-1 text-[13px]">
          <h3 class="m-0 text-[13px] font-medium text-tertiary">Not reviewed {{ data.result.skippedFiles.length }}</h3>
          <div v-for="s in data.result.skippedFiles" :key="s.path" class="text-tertiary"><span class="font-mono text-xs">{{ s.path }}</span> <span class="text-faint">{{ s.reason.replace("_", " ") }}</span></div>
        </section>
      </template>

      <div v-else-if="tab === 'runs'" class="panel overflow-hidden">
        <div v-for="r in data?.runs ?? []" :key="r.id" class="grid grid-cols-[140px_70px_minmax(0,1fr)_auto] gap-3 border-t border-subtle px-4 py-2.5 text-[13px] first:border-t-0">
          <span class="text-secondary">{{ r.purpose === "confirm" ? "Confirmation" : "Review" }}{{ r.chunks > 1 ? ` ${r.chunk + 1}/${r.chunks}` : "" }}</span>
          <span class="text-tertiary">{{ dur(r.finished_at - r.started_at) }}</span>
          <span :class="r.outcome === 'error' || r.outcome === 'didnt_look' ? 'text-warn' : 'text-secondary'">{{ r.outcome.replace("_", " ") }}{{ r.error ? `: ${r.error}` : "" }}</span>
          <span class="text-faint">{{ (r.tokens_in ?? 0).toLocaleString("en") }} / {{ (r.tokens_out ?? 0).toLocaleString("en") }} tokens</span>
        </div>
        <p v-if="!data?.runs?.length" class="hint px-4 py-3">{{ live.cached ? "The verdict came from the cache; no model runs." : "No model runs yet." }}</p>
      </div>

      <div v-else-if="tab === 'log'" class="grid gap-4">
        <div v-if="data?.outputs?.length" class="panel overflow-hidden text-[13px]">
          <div v-for="(o, i) in data.outputs" :key="i" class="flex flex-wrap gap-3 border-t border-subtle px-4 py-2.5 first:border-t-0">
            <span class="w-36 text-tertiary">{{ stamp(o.created_at) }}</span>
            <span :class="o.status === 'sent' ? 'text-secondary' : 'text-warn'">{{ o.type === "pr-review" ? "Review" : "Comment" }} {{ o.status }}{{ o.error ? `: ${o.error}` : "" }}</span>
            <a v-if="o.external_url" :href="o.external_url" target="_blank" rel="noopener" class="link ml-auto">Open ↗</a>
          </div>
        </div>
        <div class="grid gap-0.5 text-[13px]">
          <div v-for="e in data?.events ?? []" :key="e.id" class="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
            <span class="text-faint">{{ clock(e.ts) }}</span>
            <span class="break-words" :class="e.level === 'error' ? 'text-danger' : e.level === 'warn' ? 'text-warn' : 'text-secondary'">{{ e.msg }}</span>
          </div>
          <p v-if="!data?.events?.length" class="hint">Nothing logged.</p>
        </div>
      </div>

      <div v-else class="grid gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <select v-model="compareWith" class="field w-auto" aria-label="Review to compare with">
            <option value="">Pick a review</option>
            <option v-for="o in siblings" :key="o.id" :value="o.id">#{{ o.id }} · {{ sha7(o.head_sha) }} · {{ o.model }} · {{ o.profile_name ?? "Triage" }}</option>
          </select>
          <TBtn :disabled="!compareWith" @click="runCompare">Compare</TBtn>
        </div>
        <div v-if="comparison" class="grid gap-3 text-[13px]">
          <div v-for="[label, list, color] in ([['Only in this review', comparison.onlyA, '#b4a6ff'], [`Only in #${compareWith}`, comparison.onlyB, '#f2b880'], ['In both', comparison.both, '#7e7e8a']] as const)" :key="label">
            <div :style="{ color }">{{ label }} {{ list.length }}</div>
            <div v-for="(f, i) in list" :key="i" class="pl-4 text-secondary">{{ prettyCategory(f.category) }} · <span class="font-mono text-xs">{{ f.file }}:{{ f.line_start }}</span> — {{ f.claim }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
