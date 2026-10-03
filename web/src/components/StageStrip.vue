<script setup lang="ts">
import { computed } from "vue";
import { store } from "../store";
import { dur } from "../format";
import type { Review } from "../types";
import { openReview } from "../router";
// The running review: fetch diff ▸ review ▸ confirm, with a blinking block after the current step.
const props = defineProps<{ review: Review }>();
const steps = [["diff", "fetch diff"], ["review", "review"], ["confirm", "confirm"]] as const;
const idx = computed(() => Math.max(0, steps.findIndex(([k]) => k === (store.stages[props.review.id] ?? "diff"))));
const lines = computed(() => store.events.filter((e) => e.job_id === props.review.id).slice(-3));
</script>

<template>
  <div class="grid gap-3 rounded-lg border border-accent/40 bg-surface px-4 py-4">
    <div class="flex flex-wrap items-start gap-3">
      <div class="min-w-0">
        <div class="text-tertiary"><span class="text-accent2">{{ review.repo }} #{{ review.number }}</span> as {{ review.account }}</div>
        <button class="text-left font-medium text-bright hover:underline" @click="openReview(review.id)">{{ review.title }}</button>
      </div>
      <div class="ml-auto flex items-center gap-4">
        <span class="text-accent2">{{ review.model }}</span>
        <span class="text-xl text-bright tabular-nums">{{ dur(store.now - (review.started_at ?? store.now)) }}</span>
      </div>
    </div>
    <ol class="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 p-0" aria-label="progress">
      <template v-for="([key, label], i) in steps" :key="key">
        <li class="list-none" :class="i < idx ? 'text-ok' : i === idx ? 'text-accent' : 'text-faint'" :aria-current="i === idx ? 'step' : undefined">
          {{ i < idx ? "✓" : i === idx ? "◐" : "○" }} {{ label }}<span v-if="i === idx" class="cursor-blink ml-1">█</span>
          <span v-if="key === 'confirm' && i > idx" class="text-faint"> (only if blocking)</span>
        </li>
        <li v-if="i < steps.length - 1" class="list-none text-faint" aria-hidden="true">▸</li>
      </template>
    </ol>
    <div v-if="lines.length" class="grid gap-0.5 rounded-sm bg-base px-3 py-2 text-[13px] text-tertiary">
      <div v-for="e in lines" :key="e.id"><span class="text-faint">$ </span>{{ e.msg }}</div>
    </div>
  </div>
</template>
