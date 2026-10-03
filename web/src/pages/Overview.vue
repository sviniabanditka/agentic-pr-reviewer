<script setup lang="ts">
import { computed } from "vue";
import { store } from "../store";
import { cancelReview } from "../actions";
import { openReview } from "../router";
import { short, verdictWord } from "../format";
import AccountCard from "../components/AccountCard.vue";
import StageStrip from "../components/StageStrip.vue";
import TPrompt from "../components/TPrompt.vue";
import TGlyph from "../components/TGlyph.vue";
import Rel from "../components/Rel.vue";

const reviews = computed(() => [...store.reviews.values()].sort((a, b) => b.id - a.id));
const running = computed(() => reviews.value.filter((r) => r.status === "running"));
const queued = computed(() => reviews.value.filter((r) => r.status === "queued").reverse());
const recent = computed(() => reviews.value.filter((r) => r.status !== "queued" && r.status !== "running").slice(0, 8));
const waiting = computed(() => [...store.items.values()].filter((i) => i.state === "open" && !i.lastReview).length);
const unposted = computed(() => reviews.value.filter((r) => r.status === "done" && !r.comment_url && store.items.get(r.item_id ?? "")?.lastReview?.id === r.id).length);
</script>

<template>
  <div class="grid gap-8">
    <section v-if="!store.accounts.length" class="rounded-lg border border-subtle bg-surface px-5 py-6">
      <TPrompt :level="1" sigil="$">welcome</TPrompt>
      <p class="mb-0 mt-3 text-secondary">// start by adding a github account and a claude credential on
        <RouterLink to="/accounts" class="text-accent hover:underline">accounts</RouterLink>, then tell it what to watch on
        <RouterLink to="/targets" class="text-accent hover:underline">targets</RouterLink>.</p>
    </section>

    <section v-else class="grid gap-3">
      <TPrompt>accounts</TPrompt>
      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3"><AccountCard v-for="a in store.accounts" :key="a.id" :account="a" /></div>
    </section>

    <section class="grid gap-3">
      <TPrompt>now</TPrompt>
      <StageStrip v-for="r in running" :key="r.id" :review="r" />
      <div v-if="queued.length" class="flex flex-wrap items-center gap-2 text-tertiary">
        <span>up next</span>
        <span v-for="q in queued" :key="q.id" class="inline-flex items-center gap-2 rounded-sm border border-subtle bg-elevated px-2 py-0.5">
          <span class="text-accent2">{{ short(q.repo) }} #{{ q.number }}</span><span class="text-faint">{{ q.model }}</span>
          <button class="text-faint hover:text-danger" :aria-label="`cancel review of ${q.repo} #${q.number}`" @click="cancelReview(q.id)">✕</button>
        </span>
      </div>
      <div v-if="!running.length && !queued.length" class="rounded-lg border border-subtle bg-surface px-4 py-3 text-tertiary">
        // idle. <span v-if="waiting">{{ waiting }} open pull request{{ waiting === 1 ? "" : "s" }} never reviewed — see <RouterLink to="/inbox" class="text-accent hover:underline">inbox</RouterLink>.</span>
        <span v-if="unposted"> {{ unposted }} finished review{{ unposted === 1 ? "" : "s" }} not posted yet.</span>
      </div>
    </section>

    <section class="grid gap-3">
      <div class="flex flex-wrap items-baseline gap-4">
        <TPrompt>recent reviews</TPrompt>
        <span v-if="store.totals" class="text-tertiary">last 24h: <span class="text-bright">{{ store.totals.reviews }}</span> reviews ·
          <span class="text-bright">{{ store.totals.runs }}</span> runs · <span class="text-bright">{{ Math.round((store.totals.tokens_in + store.totals.tokens_out) / 1000) }}k</span> tokens ·
          ~<span class="text-bright">${{ store.totals.cost_usd.toFixed(2) }}</span> at api prices</span>
      </div>
      <ul class="m-0 grid gap-0.5 rounded-lg border border-subtle bg-surface p-1.5">
        <li v-for="r in recent" :key="r.id" class="grid cursor-pointer grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-3 rounded-md px-3 py-2 hover:bg-hover" @click="openReview(r.id)">
          <TGlyph :review="r" class="text-center" />
          <div class="min-w-0"><div class="truncate text-bright">{{ r.title }}</div>
            <div class="text-[13px] text-tertiary"><span class="text-accent2">{{ short(r.repo) }} #{{ r.number }}</span> · {{ verdictWord(r) }} · {{ r.model }}{{ r.comment_url ? " · posted" : "" }}</div></div>
          <Rel :ts="r.created_at" class="text-tertiary" />
        </li>
        <li v-if="!recent.length" class="list-none px-3 py-4 text-tertiary">// no reviews yet</li>
      </ul>
    </section>
  </div>
</template>
