<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { accountOf, onReviewChange, store } from "../store";
import { cancelReview, publishReview, startReview } from "../actions";
import { BLOCKING, clock, dur, roleLabel, sha7, stamp } from "../format";
import type { Finding, LogEvent, Review, ReviewResult, Run } from "../types";
import Drawer from "./Drawer.vue";
import TBtn from "./TBtn.vue";
import TGlyph from "./TGlyph.vue";
import { toast } from "./toast";

const route = useRoute();
const router = useRouter();
const id = computed(() => (route.query.review ? Number(route.query.review) : null));
const data = ref<{ review: Review; result: ReviewResult | null; events: LogEvent[]; runs: Run[] } | null>(null);
const loading = ref(false);
const posting = ref(false);

async function load(reviewId: number) {
  loading.value = true;
  try {
    data.value = await api.get(`/reviews/${reviewId}`);
  } catch (e) {
    data.value = null;
    toast((e as Error).message, true);
  } finally {
    loading.value = false;
  }
}
watch(id, (v) => (v ? load(v) : (data.value = null)), { immediate: true });
onReviewChange((r, prev) => {
  if (r.id === id.value && (prev?.status !== r.status || prev?.comment_url !== r.comment_url)) void load(r.id);
});

function close() {
  const { review: _r, ...rest } = route.query;
  void router.push({ query: rest });
}

const live = computed(() => (data.value ? { ...data.value.review, ...(store.reviews.get(data.value.review.id) ?? {}) } : null));
const item = computed(() => (live.value?.item_id ? store.items.get(live.value.item_id) : undefined));
const account = computed(() => accountOf(live.value?.account_id));
const otherPosted = computed(() =>
  live.value ? [...store.reviews.values()].some((o) => o.id !== live.value!.id && o.item_id === live.value!.item_id && o.comment_url) : false,
);
const busy = computed(() => (item.value ? [...store.reviews.values()].some((r) => r.item_id === item.value!.id && (r.status === "queued" || r.status === "running")) : false));

const groups = computed(() => {
  const res = data.value?.result;
  if (!res) return [];
  const confirmed = new Set(res.confirmedMarkers);
  const blockingSet = res.blocking ?? BLOCKING;
  const isConfirmed = (f: Finding) => [...confirmed].some((m) => m.includes(`:${f.category}:${f.file}:`));
  const blocking = res.findings.filter((f) => blockingSet.includes(f.category) && f.evidenceCheck !== "not_found");
  return [
    { title: "blocking", list: blocking.filter(isConfirmed), tone: "danger" },
    { title: "blocking, not confirmed by a second run", list: blocking.filter((f) => !isConfirmed(f)), tone: "warn" },
    { title: "notes", list: res.findings.filter((f) => !blockingSet.includes(f.category) && f.evidenceCheck !== "not_found"), tone: "accent" },
    { title: "low confidence — quoted code not found in the diff", list: res.findings.filter((f) => f.evidenceCheck === "not_found"), tone: "faint" },
  ].filter((g) => g.list.length);
});

const verdict = computed(() => {
  const r = live.value;
  if (!r) return { text: "", cls: "" };
  if (r.status === "done") return { text: r.verdict_title ?? "", cls: r.conclusion === "success" ? "border-ok/40 text-ok" : "border-danger/40 text-danger" };
  if (r.status === "error") return { text: `failed: ${r.error ?? "unknown error"}`, cls: "border-warn/40 text-warn" };
  if (r.status === "skipped") return { text: r.error === "cancelled" ? "cancelled before it started" : `skipped: ${r.error ?? ""}`, cls: "border-subtle text-tertiary" };
  return { text: r.status === "running" ? `reviewing now — ${store.stages[r.id] ?? "starting"}` : "waiting in the queue", cls: "border-accent/40 text-accent" };
});

function lineLink(f: Finding) {
  const r = live.value!;
  const anchor = f.line_start === f.line_end ? `L${f.line_start}` : `L${f.line_start}-L${f.line_end}`;
  return `https://github.com/${r.repo}/blob/${r.head_sha}/${f.file}#${anchor}`;
}

async function post() {
  posting.value = true;
  await publishReview(live.value!.id);
  posting.value = false;
}
async function copy(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast("comment link copied");
  } catch {
    toast("could not copy the link", true);
  }
}
const toneText: Record<string, string> = { danger: "text-danger", warn: "text-warn", accent: "text-accent", faint: "text-faint" };
const toneBorder: Record<string, string> = { danger: "border-l-danger", warn: "border-l-warn", accent: "border-l-accent", faint: "border-l-faint" };
</script>

<template>
  <Drawer :open="id !== null" :title="live?.title" @close="close">
    <template #header>
      <div v-if="live" class="grid gap-2">
        <div class="text-tertiary">
          <span class="text-accent2">{{ live.repo }} #{{ live.number }}</span>
          <span class="ml-2">as {{ account?.label ?? live.account }}</span>
          <span class="ml-2">review <span class="text-accent2">#{{ live.id }}</span></span>
        </div>
        <h2 class="m-0 text-base font-medium leading-snug text-bright"><TGlyph :review="live" class="mr-2" />{{ live.title }}</h2>
        <div class="flex flex-wrap items-center gap-1">
          <a :href="live.url" target="_blank" rel="noopener" class="rounded-sm px-1 py-0.5 text-secondary hover:bg-hover"><span class="text-tertiary">[</span> open pr ↗ <span class="text-tertiary">]</span></a>
          <a v-if="live.comment_url" :href="live.comment_url" target="_blank" rel="noopener" class="rounded-sm px-1 py-0.5 text-secondary hover:bg-hover"><span class="text-tertiary">[</span> open comment ↗ <span class="text-tertiary">]</span></a>
          <TBtn v-if="live.comment_url" @click="copy(live.comment_url)">copy link</TBtn>
          <TBtn v-if="live.status === 'done' && !live.comment_url" tone="primary" :busy="posting"
            :confirm="`post as @${account?.login ?? '?'} → ${live.repo.split('/')[1]} #${live.number}`" @click="post">
            {{ otherPosted ? "replace pr comment" : "post to pr" }}
          </TBtn>
          <TBtn v-if="live.status === 'queued'" tone="danger" @click="cancelReview(live.id)">cancel</TBtn>
          <TBtn v-if="item && !busy && item.state === 'open'" @click="startReview(item.id, live.model ?? undefined, live.profile_id ?? undefined)">review again</TBtn>
        </div>
      </div>
      <div v-else class="text-tertiary">{{ loading ? "loading…" : "review not found" }}</div>
    </template>

    <div v-if="live" class="grid gap-6">
      <div class="rounded-md border px-4 py-3" :class="verdict.cls">{{ verdict.text }}</div>

      <div v-if="live.status === 'done' && !live.comment_url" class="rounded-md border border-subtle bg-elevated px-4 py-3 text-secondary">
        <span class="text-tertiary">//</span> not posted. only this panel shows it until you press
        <span class="text-accent">[ {{ otherPosted ? "replace pr comment" : "post to pr" }} ]</span>{{ otherPosted ? ", which rewrites the comment an earlier review left" : "" }}.
        <template v-if="item && item.headSha && item.headSha !== live.head_sha">
          the pr has moved on to <span class="text-accent2">{{ sha7(item.headSha) }}</span>; this review covers <span class="text-accent2">{{ sha7(live.head_sha) }}</span>.
        </template>
      </div>

      <dl class="m-0 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <div><dt class="text-tertiary">commit</dt><dd class="m-0 text-accent2">{{ sha7(live.head_sha) }}</dd></div>
        <div><dt class="text-tertiary">model</dt><dd class="m-0 text-accent2">{{ live.model ?? "--" }}</dd></div>
        <div><dt class="text-tertiary">took</dt><dd class="m-0 text-bright">{{ live.finished_at && live.started_at ? dur(live.finished_at - live.started_at) : live.started_at ? dur(store.now - live.started_at) : "--" }}</dd></div>
        <div><dt class="text-tertiary">started</dt><dd class="m-0 text-bright">{{ stamp(live.created_at) }}</dd></div>
        <div><dt class="text-tertiary">model runs</dt><dd class="m-0 text-bright">{{ live.cached ? "cached verdict" : live.runs ?? "--" }}</dd></div>
        <div><dt class="text-tertiary">tokens in/out</dt><dd class="m-0 text-bright">{{ (live.tokens_in ?? 0).toLocaleString("en") }} / {{ (live.tokens_out ?? 0).toLocaleString("en") }}</dd></div>
        <div><dt class="text-tertiary">at api prices</dt><dd class="m-0 text-bright">${{ (live.cost_usd ?? 0).toFixed(3) }}</dd></div>
        <div><dt class="text-tertiary">your role</dt><dd class="m-0 text-bright">{{ roleLabel(live.role) }}</dd></div>
        <div><dt class="text-tertiary">profile</dt><dd class="m-0 text-bright">{{ (live.profile_name ?? "triage").toLowerCase() }}</dd></div>
        <div><dt class="text-tertiary">parts</dt><dd class="m-0 text-bright">{{ live.chunks ?? 1 }}</dd></div>
      </dl>

      <section v-if="data?.result?.summary" class="grid gap-3">
        <h3 class="m-0 text-sm font-medium text-bright"><span class="text-ok">#</span> pr description draft</h3>
        <div class="grid gap-3 rounded-md border border-subtle bg-elevated px-4 py-3">
          <div class="font-medium text-bright">{{ data.result.summary.title }}</div>
          <p class="m-0 text-secondary">{{ data.result.summary.summary }}</p>
          <div v-for="[label, list] in ([['changes', data.result.summary.changes], ['risks', data.result.summary.risks], ['how to test', data.result.summary.testing]] as const)" :key="label">
            <template v-if="list.length"><div class="text-tertiary">{{ label }}</div><ul class="m-0 pl-5 text-secondary"><li v-for="(x, i) in list" :key="i">{{ x }}</li></ul></template>
          </div>
        </div>
      </section>

      <section v-for="g in groups" :key="g.title" class="grid gap-3">
        <h3 class="m-0 text-sm font-medium lowercase" :class="toneText[g.tone]"># {{ g.title }} <span class="text-tertiary">({{ g.list.length }})</span></h3>
        <article v-for="(f, i) in g.list" :key="i" class="grid gap-1.5 rounded-md border border-subtle border-l-[3px] bg-elevated px-4 py-3" :class="toneBorder[g.tone]">
          <div class="flex flex-wrap items-center gap-2">
            <span :class="toneText[g.tone]">{{ f.category }}</span>
            <a :href="lineLink(f)" target="_blank" rel="noopener" class="text-tertiary hover:text-accent hover:underline">{{ f.file }}:{{ f.line_start }}{{ f.line_end !== f.line_start ? `-${f.line_end}` : "" }}</a>
          </div>
          <div class="text-bright">{{ f.claim }}</div>
          <div class="text-secondary">{{ f.detail }}</div>
          <details v-if="f.evidence" class="text-tertiary">
            <summary class="cursor-pointer select-none">quoted code</summary>
            <pre class="mt-2 overflow-x-auto rounded-sm bg-base px-3 py-2 text-text">{{ f.evidence }}</pre>
          </details>
        </article>
      </section>
      <div v-if="data?.result && !data.result.findings.length" class="text-tertiary">// no findings in this diff</div>

      <section v-if="data?.result?.skippedFiles?.length" class="grid gap-2">
        <h3 class="m-0 text-sm font-medium text-tertiary"># not reviewed ({{ data.result.skippedFiles.length }})</h3>
        <div class="text-tertiary"><div v-for="s in data.result.skippedFiles" :key="s.path">{{ s.path }} <span class="text-faint">({{ s.reason.replace("_", " ") }})</span></div></div>
      </section>

      <section v-if="data?.runs?.length" class="grid gap-2">
        <h3 class="m-0 text-sm font-medium text-bright"><span class="text-ok">#</span> model runs</h3>
        <div class="grid gap-0.5 text-[13px]">
          <div v-for="r in data.runs" :key="r.id" class="grid grid-cols-[130px_70px_1fr_auto] gap-3">
            <span class="text-secondary">{{ r.purpose }}{{ r.chunks > 1 ? ` ${r.chunk + 1}/${r.chunks}` : "" }}</span>
            <span class="text-tertiary">{{ dur(r.finished_at - r.started_at) }}</span>
            <span :class="r.outcome === 'error' || r.outcome === 'didnt_look' ? 'text-warn' : 'text-secondary'">{{ r.outcome.replace("_", " ") }}{{ r.error ? `: ${r.error}` : "" }}</span>
            <span class="text-faint">{{ (r.tokens_in ?? 0).toLocaleString("en") }}/{{ (r.tokens_out ?? 0).toLocaleString("en") }} tok</span>
          </div>
        </div>
      </section>

      <section class="grid gap-2">
        <h3 class="m-0 text-sm font-medium text-bright"><span class="text-ok">#</span> what happened</h3>
        <div class="grid gap-0.5 text-[13px]">
          <div v-for="e in data?.events ?? []" :key="e.id" class="grid grid-cols-[72px_1fr] gap-2">
            <span class="text-faint">{{ clock(e.ts) }}</span>
            <span :class="e.level === 'error' ? 'text-danger' : e.level === 'warn' ? 'text-warn' : 'text-secondary'">{{ e.msg }}</span>
          </div>
          <div v-if="!data?.events?.length" class="text-tertiary">// no events</div>
        </div>
      </section>
    </div>
  </Drawer>
</template>
