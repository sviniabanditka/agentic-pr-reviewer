<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { store } from "../store";
import { openReview } from "../router";
import { clock } from "../format";
import TPrompt from "../components/TPrompt.vue";

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
      <span class="text-tertiary">// tail -f of everything the reviewer does for you</span>
      <div class="ml-auto flex flex-wrap items-center gap-2">
        <input v-model="q" class="field w-56 py-1" placeholder="grep…" aria-label="filter log">
        <div class="flex rounded-md border border-subtle bg-elevated p-0.5" role="group" aria-label="level">
          <button v-for="l in (['info', 'warn', 'error'] as const)" :key="l" class="rounded-sm px-2 py-0.5" :class="level === l ? 'bg-active text-bright' : 'text-tertiary'" :aria-pressed="level === l" @click="level = l">{{ l === "info" ? "all" : l + "+" }}</button>
        </div>
        <button class="rounded-sm px-1 hover:bg-hover" :class="follow ? 'text-ok' : 'text-tertiary'" @click="follow = !follow"><span class="text-tertiary">[</span> {{ follow ? "following" : "paused" }} <span class="text-tertiary">]</span></button>
      </div>
    </div>
    <div ref="pane" class="h-[70vh] overflow-y-auto rounded-lg border border-subtle bg-surface py-2 text-[13px]" @scroll="onScroll">
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
