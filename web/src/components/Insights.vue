<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "../api";
import { dur } from "../format";
import TBar from "./TBar.vue";
import { toast } from "./toast";

interface Data {
  days: number;
  byModel: { model: string; reviews: number; runs: number; avg_ms: number; tokens_in: number; tokens_out: number; cost_usd: number; blocking_reviews: number }[];
  byProfile: { profile: string; reviews: number; avg_ms: number; cost_usd: number }[];
  byDay: { day: string; reviews: number; failed: number; cost_usd: number }[];
  categories: Record<string, number>;
  posted: number;
  confirmation: { confirmations: number; agreed: number | null };
}
const days = ref(7);
const data = ref<Data | null>(null);
watch(days, async (d) => {
  try {
    data.value = await api.get<Data>(`/insights?days=${d}`);
  } catch (e) {
    toast((e as Error).message, true);
  }
}, { immediate: true });
const cats = computed(() => Object.entries(data.value?.categories ?? {}).sort((a, b) => b[1] - a[1]));
const catMax = computed(() => Math.max(1, ...cats.value.map(([, n]) => n)));
const dayMax = computed(() => Math.max(1, ...(data.value?.byDay ?? []).map((d) => d.reviews)));
const total = computed(() => (data.value?.byModel ?? []).reduce((t, m) => ({ reviews: t.reviews + m.reviews, cost: t.cost + m.cost_usd }), { reviews: 0, cost: 0 }));
</script>

<template>
  <div class="grid gap-6">
    <div class="flex flex-wrap items-center gap-3">
      <div class="flex rounded-md border border-subtle bg-elevated p-0.5" role="group" aria-label="range">
        <button v-for="d in [7, 30, 90]" :key="d" class="rounded-sm px-2 py-0.5" :class="days === d ? 'bg-active text-bright' : 'text-tertiary'" :aria-pressed="days === d" @click="days = d">{{ d }}d</button>
      </div>
      <span v-if="data" class="text-tertiary"><span class="text-bright">{{ total.reviews }}</span> reviews · <span class="text-bright">{{ data.posted }}</span> posted ·
        ~<span class="text-bright">${{ total.cost.toFixed(2) }}</span> at api prices
        <template v-if="data.confirmation.confirmations"> · second run agreed on <span class="text-bright">{{ Math.round(((data.confirmation.agreed ?? 0) / data.confirmation.confirmations) * 100) }}%</span> of reviews with blocking candidates</template></span>
    </div>
    <div v-if="data" class="grid gap-6 xl:grid-cols-2">
      <section class="grid gap-2 rounded-lg border border-subtle bg-surface px-4 py-3">
        <h3 class="m-0 text-sm font-medium text-bright"><span class="text-ok">#</span> by model</h3>
        <div class="grid grid-cols-[1fr_repeat(4,auto)] gap-x-5 gap-y-1 text-[13px]">
          <span class="text-faint">model</span><span class="text-faint">reviews</span><span class="text-faint">avg</span><span class="text-faint">tokens</span><span class="text-faint">blocking</span>
          <template v-for="m in data.byModel" :key="m.model">
            <span class="text-accent2">{{ m.model }}</span><span class="text-bright">{{ m.reviews }}</span><span class="text-secondary">{{ dur(m.avg_ms) }}</span>
            <span class="text-secondary">{{ Math.round((m.tokens_in + m.tokens_out) / 1000) }}k</span><span class="text-danger">{{ m.blocking_reviews }}</span>
          </template>
        </div>
        <div v-if="!data.byModel.length" class="text-tertiary">// no finished reviews in this range</div>
      </section>
      <section class="grid gap-2 rounded-lg border border-subtle bg-surface px-4 py-3">
        <h3 class="m-0 text-sm font-medium text-bright"><span class="text-ok">#</span> by profile</h3>
        <div class="grid grid-cols-[1fr_repeat(3,auto)] gap-x-5 gap-y-1 text-[13px]">
          <span class="text-faint">profile</span><span class="text-faint">reviews</span><span class="text-faint">avg</span><span class="text-faint">api price</span>
          <template v-for="p in data.byProfile" :key="p.profile">
            <span class="text-secondary">{{ p.profile.toLowerCase() }}</span><span class="text-bright">{{ p.reviews }}</span><span class="text-secondary">{{ dur(p.avg_ms) }}</span><span class="text-secondary">${{ p.cost_usd.toFixed(2) }}</span>
          </template>
        </div>
      </section>
      <section class="grid gap-2 rounded-lg border border-subtle bg-surface px-4 py-3">
        <h3 class="m-0 text-sm font-medium text-bright"><span class="text-ok">#</span> findings by category</h3>
        <div v-for="[c, n] in cats" :key="c" class="flex items-center gap-3 text-[13px]">
          <span class="w-36 text-secondary">{{ c }}</span><TBar :pct="(n / catMax) * 100" :width="24" hide-label /><span class="text-bright">{{ n }}</span>
        </div>
        <div v-if="!cats.length" class="text-tertiary">// no findings in this range</div>
      </section>
      <section class="grid gap-2 rounded-lg border border-subtle bg-surface px-4 py-3">
        <h3 class="m-0 text-sm font-medium text-bright"><span class="text-ok">#</span> per day</h3>
        <div v-for="d in data.byDay" :key="d.day" class="flex items-center gap-3 text-[13px]">
          <span class="w-24 text-tertiary">{{ d.day.slice(5) }}</span><TBar :pct="(d.reviews / dayMax) * 100" :width="24" hide-label />
          <span class="text-bright">{{ d.reviews }}</span><span v-if="d.failed" class="text-warn">{{ d.failed }} failed</span>
        </div>
        <div v-if="!data.byDay.length" class="text-tertiary">// nothing yet</div>
      </section>
    </div>
  </div>
</template>
