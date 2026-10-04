<script setup lang="ts">
import { computed } from "vue";
import { dur } from "../format";
import TBar from "./TBar.vue";

export interface InsightsData {
  days: number;
  byModel: { model: string; reviews: number; runs: number; avg_ms: number; tokens_in: number; tokens_out: number; cost_usd: number; blocking_reviews: number }[];
  byProfile: { profile: string; reviews: number; avg_ms: number; cost_usd: number }[];
  byDay: { day: string; reviews: number; failed: number; cost_usd: number }[];
  categories: Record<string, number>;
  posted: number;
  confirmation: { confirmations: number; agreed: number | null };
}
const props = defineProps<{ data: InsightsData }>();
const cats = computed(() => Object.entries(props.data.categories).sort((a, b) => b[1] - a[1]));
const catMax = computed(() => Math.max(1, ...cats.value.map(([, n]) => n)));
const dayMax = computed(() => Math.max(1, ...props.data.byDay.map((d) => d.reviews)));
</script>

<template>
  <div class="grid gap-3 xl:grid-cols-2">
    <section class="card grid content-start gap-3 px-5 py-4">
      <h3 class="m-0 text-[13px] font-medium text-secondary">By model</h3>
      <div class="grid grid-cols-[minmax(0,1fr)_repeat(4,auto)] gap-x-6 gap-y-1.5 text-[13px]">
        <span class="text-tertiary">Model</span><span class="text-tertiary">Reviews</span><span class="text-tertiary">Average</span><span class="text-tertiary">Tokens</span><span class="text-tertiary">Blocking</span>
        <template v-for="m in data.byModel" :key="m.model">
          <span class="text-bright">{{ m.model }}</span><span>{{ m.reviews }}</span><span class="text-secondary">{{ dur(m.avg_ms) }}</span>
          <span class="text-secondary">{{ Math.round((m.tokens_in + m.tokens_out) / 1000) }}k</span><span class="text-danger">{{ m.blocking_reviews }}</span>
        </template>
      </div>
      <p v-if="!data.byModel.length" class="hint">No finished reviews in this period.</p>
    </section>
    <section class="card grid content-start gap-3 px-5 py-4">
      <h3 class="m-0 text-[13px] font-medium text-secondary">By profile</h3>
      <div class="grid grid-cols-[minmax(0,1fr)_repeat(3,auto)] gap-x-6 gap-y-1.5 text-[13px]">
        <span class="text-tertiary">Profile</span><span class="text-tertiary">Reviews</span><span class="text-tertiary">Average</span><span class="text-tertiary">At API prices</span>
        <template v-for="p in data.byProfile" :key="p.profile">
          <span class="text-bright">{{ p.profile }}</span><span>{{ p.reviews }}</span><span class="text-secondary">{{ dur(p.avg_ms) }}</span><span class="text-secondary">${{ p.cost_usd.toFixed(2) }}</span>
        </template>
      </div>
    </section>
    <section class="card grid content-start gap-2.5 px-5 py-4">
      <h3 class="m-0 text-[13px] font-medium text-secondary">Findings by category</h3>
      <div v-for="[c, n] in cats" :key="c" class="grid grid-cols-[150px_minmax(0,1fr)_32px] items-center gap-3 text-[13px]">
        <span class="font-mono text-xs text-secondary">{{ c }}</span><TBar :pct="(n / catMax) * 100" relative /><span class="text-right text-bright">{{ n }}</span>
      </div>
      <p v-if="!cats.length" class="hint">No findings in this period.</p>
    </section>
    <section class="card grid content-start gap-2.5 px-5 py-4">
      <h3 class="m-0 text-[13px] font-medium text-secondary">Per day</h3>
      <div v-for="d in data.byDay" :key="d.day" class="grid grid-cols-[60px_minmax(0,1fr)_90px] items-center gap-3 text-[13px]">
        <span class="text-tertiary">{{ d.day.slice(5) }}</span><TBar :pct="(d.reviews / dayMax) * 100" color="#7ccbea" relative />
        <span class="text-right">{{ d.reviews }}<span v-if="d.failed" class="text-warn"> · {{ d.failed }} failed</span></span>
      </div>
      <p v-if="!data.byDay.length" class="hint">Nothing yet.</p>
    </section>
  </div>
</template>
