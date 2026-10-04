<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { store } from "../store";
import { openReview } from "../router";
import { clock, dur, stamp } from "../format";
import { api } from "../api";
import type { AuditRow } from "../types";
import Insights, { type InsightsData } from "../components/Insights.vue";
import { toast } from "../components/toast";

const tab = ref<"audit" | "log" | "insights">("audit");
const days = ref(7);
const insights = ref<InsightsData | null>(null);
const audit = ref<AuditRow[] | null>(null);
watch(days, async (d) => {
  try {
    insights.value = await api.get<InsightsData>(`/insights?days=${d}`);
  } catch (e) {
    toast((e as Error).message, true);
  }
}, { immediate: true });
watch(tab, async (t) => {
  if (t === "audit" && audit.value === null) audit.value = (await api.get<{ audit: AuditRow[] }>("/audit")).audit;
}, { immediate: true });

const stats = computed(() => {
  const d = insights.value;
  if (!d) return [];
  const reviews = d.byModel.reduce((t, m) => t + m.reviews, 0);
  const failed = d.byDay.reduce((t, x) => t + x.failed, 0);
  const avg = reviews ? d.byModel.reduce((t, m) => t + m.avg_ms * m.reviews, 0) / reviews : 0;
  return [
    { label: "Reviews", value: String(reviews), sub: failed ? `${failed} failed` : "none failed" },
    { label: "Posted", value: String(d.posted), sub: "to pull requests" },
    { label: "Average time", value: reviews ? dur(avg) : "—", sub: d.byModel.slice(0, 2).map((m) => `${m.model} ${dur(m.avg_ms)}`).join(" · ") || "no reviews" },
    { label: "Second runs agreed", value: d.confirmation.confirmations ? `${d.confirmation.agreed ?? 0} of ${d.confirmation.confirmations}` : "—", sub: "blocking findings confirmed" },
  ];
});

type Kind = "post" | "key" | "auto" | "user";
const AUDIT: Record<string, { text: string; kind: Kind }> = {
  post_comment: { text: "Posted a comment to", kind: "post" }, post_review: { text: "Posted a review to", kind: "post" }, auto_post: { text: "Auto-posted to", kind: "post" },
  account_added: { text: "Added GitHub account", kind: "key" }, account_removed: { text: "Removed GitHub account", kind: "key" }, token_replaced: { text: "Replaced the token of", kind: "key" },
  credential_added: { text: "Added Claude credential", kind: "key" }, credential_removed: { text: "Removed Claude credential", kind: "key" },
  target_auto_post_enabled: { text: "Turned on auto-post for", kind: "auto" }, channel_added: { text: "Added notification channel", kind: "key" }, channel_removed: { text: "Removed notification channel", kind: "key" },
  user_invited: { text: "Invited", kind: "user" }, user_disabled: { text: "Disabled", kind: "user" }, user_enabled: { text: "Enabled", kind: "user" }, role_changed: { text: "Changed the role of", kind: "user" },
  totp_reset: { text: "Reset two-factor of", kind: "user" }, api_token_created: { text: "Created API token", kind: "key" }, api_token_revoked: { text: "Revoked API token", kind: "key" },
};
const DOT: Record<Kind, string> = { post: "#9d8cff", key: "#7ccbea", auto: "#ff9c86", user: "#8bd3a3" };
const auditFilter = ref<"" | Kind>("");
const auditQ = ref("");
const auditRows = computed(() => (audit.value ?? [])
  .map((a) => ({ ...a, meta: AUDIT[a.action] ?? { text: a.action, kind: "key" as Kind } }))
  .filter((a) => !auditFilter.value || a.meta.kind === auditFilter.value || (auditFilter.value === "auto" && a.action === "auto_post"))
  .filter((a) => !auditQ.value || `${a.meta.text} ${a.subject}`.toLowerCase().includes(auditQ.value.toLowerCase())));

const level = ref<"info" | "warn" | "error">("info");
const q = ref("");
const follow = ref(true);
const pane = ref<HTMLElement | null>(null);
const rank = { info: 0, warn: 1, error: 2 };
const lines = computed(() => store.events.filter((e) => rank[e.level] >= rank[level.value] && (!q.value || e.msg.toLowerCase().includes(q.value.toLowerCase()))).slice(-800));
watch(() => lines.value.length, async () => {
  if (!follow.value) return;
  await nextTick();
  pane.value?.scrollTo({ top: pane.value.scrollHeight });
}, { immediate: true });
function onScroll() {
  const el = pane.value!;
  follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
}
</script>

<template>
  <div class="grid gap-5 px-10 pb-12 pt-[22px]">
    <div class="flex flex-wrap items-center gap-3.5">
      <h1 class="m-0 text-base font-semibold text-bright">Activity</h1>
      <div class="seg" role="tablist">
        <button role="tab" :aria-selected="tab === 'audit'" @click="tab = 'audit'">Audit</button>
        <button role="tab" :aria-selected="tab === 'log'" @click="tab = 'log'">Live log</button>
        <button role="tab" :aria-selected="tab === 'insights'" @click="tab = 'insights'">Insights</button>
      </div>
      <select v-if="tab !== 'log'" v-model.number="days" class="field ml-auto w-auto" aria-label="Period"><option :value="7">Last 7 days</option><option :value="30">Last 30 days</option><option :value="90">Last 90 days</option></select>
    </div>

    <div v-if="tab !== 'log'" class="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
      <div v-for="s in stats" :key="s.label" class="card px-4 py-3.5">
        <div class="text-[12.5px] text-tertiary">{{ s.label }}</div>
        <div class="text-[22px] font-semibold tracking-tight text-bright">{{ s.value }}</div>
        <div class="truncate text-xs text-tertiary">{{ s.sub }}</div>
      </div>
    </div>

    <template v-if="tab === 'audit'">
      <div class="flex flex-wrap items-center gap-1">
        <button class="pill" :aria-pressed="auditFilter === ''" @click="auditFilter = ''">All</button>
        <button class="pill" :aria-pressed="auditFilter === 'post'" @click="auditFilter = 'post'">Posts to GitHub</button>
        <button class="pill" :aria-pressed="auditFilter === 'key'" @click="auditFilter = 'key'">Tokens and keys</button>
        <button class="pill" :aria-pressed="auditFilter === 'auto'" @click="auditFilter = 'auto'">Automation</button>
        <button v-if="store.user?.role === 'admin'" class="pill" :aria-pressed="auditFilter === 'user'" @click="auditFilter = 'user'">People</button>
        <input v-model="auditQ" class="field ml-auto w-56" placeholder="Search…" aria-label="Search the audit log">
      </div>
      <div class="panel overflow-hidden">
        <div v-for="a in auditRows" :key="a.id" class="grid grid-cols-[150px_8px_minmax(0,1fr)_auto] items-center gap-3 border-t border-subtle px-4 py-2.5 first:border-t-0">
          <span class="text-[12.5px] text-tertiary">{{ stamp(a.created_at) }}</span>
          <span class="size-2 rounded-full" :style="{ background: DOT[a.meta.kind] }" aria-hidden="true" />
          <span class="truncate">{{ a.meta.text }} <span class="text-secondary">{{ a.subject }}</span></span>
          <span class="flex gap-3 text-[12.5px]">
            <button v-if="typeof a.details.review === 'number'" class="link cursor-pointer" @click="openReview(a.details.review)">Review #{{ a.details.review }}</button>
            <a v-if="typeof a.details.url === 'string'" :href="a.details.url" target="_blank" rel="noopener" class="link">Open ↗</a>
          </span>
        </div>
        <p v-if="audit && !auditRows.length" class="hint px-4 py-6 text-center">{{ audit.length ? "Nothing matches." : "Every write to GitHub and every change to stored credentials shows up here. Tokens are never recorded." }}</p>
      </div>
    </template>

    <template v-else-if="tab === 'log'">
      <div class="flex flex-wrap items-center gap-2">
        <input v-model="q" class="field w-64" placeholder="Filter the log…" aria-label="Filter the log">
        <div class="seg" role="group" aria-label="Level">
          <button :aria-pressed="level === 'info'" @click="level = 'info'">All</button>
          <button :aria-pressed="level === 'warn'" @click="level = 'warn'">Warnings</button>
          <button :aria-pressed="level === 'error'" @click="level = 'error'">Errors</button>
        </div>
        <button class="pill ml-auto" :aria-pressed="follow" @click="follow = !follow">{{ follow ? "Following" : "Paused" }}</button>
      </div>
      <div ref="pane" class="panel h-[70vh] overflow-y-auto py-2 text-[13px]" @scroll="onScroll">
        <div v-for="e in lines" :key="e.id" class="grid grid-cols-[72px_auto_minmax(0,1fr)] items-baseline gap-3 px-4 py-0.5 hover:bg-hover">
          <span class="font-mono text-xs text-faint">{{ clock(e.ts) }}</span>
          <span class="flex gap-2"><span v-if="e.account" class="text-secondary">{{ e.account }}</span>
            <button v-if="e.job_id" class="link cursor-pointer" @click="openReview(e.job_id)">#{{ e.job_id }}</button></span>
          <span class="whitespace-pre-wrap break-words" :class="e.level === 'error' ? 'text-danger' : e.level === 'warn' ? 'text-warn' : 'text-text'">{{ e.msg }}</span>
        </div>
        <p v-if="!lines.length" class="hint px-4 py-6">Nothing logged at this level.</p>
      </div>
    </template>

    <Insights v-else-if="insights" :data="insights" />
  </div>
</template>
