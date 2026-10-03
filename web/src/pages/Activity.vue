<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { store } from "../store";
import { openReview } from "../router";
import { clock, stamp } from "../format";
import { api } from "../api";
import type { AuditRow } from "../types";
import TPrompt from "../components/TPrompt.vue";
import Insights from "../components/Insights.vue";

const tab = ref<"log" | "insights" | "audit">("audit");
const audit = ref<AuditRow[] | null>(null);
watch(tab, async (t) => {
  if (t === "audit") audit.value = (await api.get<{ audit: AuditRow[] }>("/audit")).audit;
}, { immediate: true });
const auditText: Record<string, string> = {
  post_comment: "posted a comment", post_review: "posted a review", auto_post: "auto-posted", account_added: "added account", account_removed: "removed account",
  token_replaced: "replaced token", credential_added: "added credential", credential_removed: "removed credential", target_auto_post_enabled: "turned on auto-post",
  channel_added: "added notification channel", channel_removed: "removed notification channel",
};

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
  <div class="grid gap-4">
    <div class="flex flex-wrap items-center gap-3">
      <TPrompt :level="1">activity</TPrompt>
      <div class="flex rounded-md border border-subtle bg-elevated p-0.5" role="tablist">
        <button v-for="t in (['audit', 'log', 'insights'] as const)" :key="t" role="tab" class="rounded-sm px-2 py-0.5" :class="tab === t ? 'bg-active text-bright' : 'text-tertiary'" :aria-selected="tab === t" @click="tab = t">{{ t }}</button>
      </div>
      <div v-if="tab === 'log'" class="ml-auto flex flex-wrap items-center gap-2">
        <input v-model="q" class="field w-56 py-1" placeholder="grep…" aria-label="filter log">
        <div class="flex rounded-md border border-subtle bg-elevated p-0.5" role="group" aria-label="level">
          <button v-for="l in (['info', 'warn', 'error'] as const)" :key="l" class="rounded-sm px-2 py-0.5" :class="level === l ? 'bg-active text-bright' : 'text-tertiary'" :aria-pressed="level === l" @click="level = l">{{ l === "info" ? "all" : l + "+" }}</button>
        </div>
        <button class="rounded-sm px-1 hover:bg-hover" :class="follow ? 'text-ok' : 'text-tertiary'" @click="follow = !follow"><span class="text-tertiary">[</span> {{ follow ? "following" : "paused" }} <span class="text-tertiary">]</span></button>
      </div>
    </div>
    <Insights v-if="tab === 'insights'" />
    <div v-else-if="tab === 'audit'" class="grid gap-0.5 rounded-lg border border-subtle bg-surface py-2 text-[13px]">
      <p class="m-0 px-4 pb-1 text-tertiary">// every write to github and every change to stored credentials. tokens are never recorded.</p>
      <div v-for="a in audit ?? []" :key="a.id" class="grid grid-cols-[150px_1fr] gap-3 px-4 py-px hover:bg-hover">
        <span class="text-faint">{{ stamp(a.created_at) }}</span>
        <span class="break-words"><span :class="a.action.includes('post') ? 'text-warn' : 'text-secondary'">{{ auditText[a.action] ?? a.action }}</span>
          <span class="text-accent2"> {{ a.subject }}</span>
          <a v-if="typeof a.details.url === 'string'" :href="a.details.url" target="_blank" rel="noopener" class="ml-2 text-accent hover:underline">↗</a>
          <button v-if="typeof a.details.review === 'number'" class="ml-2 text-accent2 hover:underline" @click="openReview(a.details.review)">#{{ a.details.review }}</button></span>
      </div>
      <div v-if="audit && !audit.length" class="px-4 py-6 text-tertiary">// nothing yet</div>
    </div>
    <div v-else ref="pane" class="h-[70vh] overflow-y-auto rounded-lg border border-subtle bg-surface py-2 text-[13px]" @scroll="onScroll">
      <div v-for="e in lines" :key="e.id" class="grid grid-cols-[72px_auto_1fr] items-baseline gap-3 px-4 py-px hover:bg-hover">
        <span class="text-faint">{{ clock(e.ts) }}</span>
        <span class="flex gap-2"><span v-if="e.account" class="text-accent">{{ e.account }}</span>
          <button v-if="e.job_id" class="text-accent2 hover:underline" @click="openReview(e.job_id)">#{{ e.job_id }}</button></span>
        <span class="whitespace-pre-wrap break-words" :class="e.level === 'error' ? 'text-danger' : e.level === 'warn' ? 'text-warn' : 'text-secondary'">{{ e.msg }}</span>
      </div>
      <div v-if="!lines.length" class="px-4 py-6 text-tertiary">// nothing logged at this level</div>
    </div>
  </div>
</template>
