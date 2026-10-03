<script setup lang="ts">
import { computed } from "vue";
import { store } from "../store";
import { rel } from "../format";
import type { Account } from "../types";
import TBar from "./TBar.vue";
const props = defineProps<{ account: Account }>();
const credential = computed(() => store.credentials.find((c) => c.id === props.account.credentialId));
const core = computed(() => props.account.github?.core);
const ghPct = computed(() => (core.value ? 100 - (core.value.remaining / Math.max(1, core.value.limit)) * 100 : null));
const health = computed(() => {
  if (props.account.status !== "ok") return { text: props.account.status === "invalid" ? "token rejected" : "github error", cls: "text-danger" };
  if (!credential.value) return { text: "reviews off", cls: "text-warn" };
  if (credential.value.status !== "ok") return { text: "claude " + credential.value.status, cls: "text-warn" };
  return { text: "ready", cls: "text-ok" };
});
</script>

<template>
  <article class="grid gap-3 rounded-lg border border-subtle bg-surface px-4 py-4">
    <div class="flex items-center gap-3">
      <span class="grid h-8 w-8 place-items-center rounded-sm bg-active font-bold uppercase text-accent">{{ account.label[0] }}</span>
      <div class="min-w-0">
        <div class="truncate font-medium text-bright">{{ account.label }}</div>
        <div class="text-tertiary">@{{ account.login }}</div>
      </div>
      <span class="ml-auto" :class="health.cls">● {{ health.text }}</span>
    </div>
    <div class="grid gap-1.5">
      <div class="flex items-center justify-between gap-3"><span class="text-tertiary">claude 5h</span>
        <span class="flex items-center gap-2"><TBar :pct="credential?.limits?.fiveHour ? credential.limits.fiveHour.utilization * 100 : null" />
          <span class="w-24 whitespace-nowrap text-right text-faint">{{ credential?.limits?.fiveHour ? rel(credential.limits.fiveHour.resetsAt, store.now) : "" }}</span></span></div>
      <div class="flex items-center justify-between gap-3"><span class="text-tertiary">claude 7d</span>
        <span class="flex items-center gap-2"><TBar :pct="credential?.limits?.sevenDay ? credential.limits.sevenDay.utilization * 100 : null" />
          <span class="w-24 whitespace-nowrap text-right text-faint">{{ credential?.limits?.sevenDay ? rel(credential.limits.sevenDay.resetsAt, store.now) : "" }}</span></span></div>
      <div class="flex items-center justify-between gap-3"><span class="text-tertiary">github api</span>
        <span class="flex items-center gap-2"><TBar :pct="ghPct" />
          <span class="w-24 whitespace-nowrap text-right text-faint">{{ core ? `${core.remaining} left` : "" }}</span></span></div>
    </div>
    <div v-if="account.statusDetail" class="text-danger">! {{ account.statusDetail }}</div>
    <div v-else-if="!credential" class="text-tertiary">// attach a claude credential on <RouterLink to="/accounts" class="text-accent hover:underline">accounts</RouterLink> to enable reviews</div>
    <div v-else-if="credential.statusDetail" class="text-warn">! {{ credential.statusDetail }}</div>
  </article>
</template>
