<script setup lang="ts">
import { computed } from "vue";
import { store } from "../store";
import { openAdd } from "./palette";

// First run: three steps before the inbox has anything in it.
const steps = computed(() => {
  const account = store.accounts[0];
  const withCred = store.accounts.find((a) => a.credentialId);
  return [
    { done: !!account, title: "Add a GitHub account", sub: account ? `@${account.login} added as ${account.label}` : "Whose name reviews are posted under.", to: "/accounts", cta: "Add account" },
    { done: !!withCred, title: "Connect Claude", sub: withCred ? `${withCred.label} reviews with ${store.credentials.find((c) => c.id === withCred.credentialId)?.label}` : "A subscription token or an API key pays for the reviews.", to: "/accounts", cta: "Connect" },
    { done: store.targets.length > 0, title: "Tell it what to watch", sub: store.targets.length ? `${store.targets.length} target(s); pull requests appear as they are found` : "A target finds pull requests, e.g. ones where your review is requested.", to: "/targets", cta: "Add target" },
  ];
});
const next = computed(() => steps.value.findIndex((s) => !s.done));
</script>

<template>
  <div class="grid min-h-screen place-items-center px-6 py-10">
    <div class="w-[560px] max-w-full">
      <h1 class="m-0 mb-1.5 text-[22px] font-semibold tracking-tight text-bright">Three steps to your first review</h1>
      <p class="hint mb-6">Nothing is posted to GitHub until you press Post.</p>
      <ol class="m-0 grid list-none gap-2.5 p-0">
        <li v-for="(s, i) in steps" :key="s.title" class="flex items-center gap-3.5 rounded-xl px-[18px] py-4"
          :class="s.done ? 'bg-surface' : i === next ? 'border border-[#3a3550] bg-surface' : 'border border-subtle'">
          <span class="grid size-[26px] shrink-0 place-items-center rounded-full text-[13px]" :class="s.done ? 'bg-ok-bg text-ok' : i === next ? 'bg-accent-bg text-[#dcd4ff]' : 'bg-chip text-tertiary'">{{ s.done ? "✓" : i + 1 }}</span>
          <div class="min-w-0 flex-1"><div :class="s.done || i === next ? 'text-bright' : 'text-secondary'">{{ s.title }}</div><div class="text-[12.5px] text-tertiary">{{ s.sub }}</div></div>
          <RouterLink v-if="!s.done" :to="s.to" class="rounded-lg px-3 py-1.5 text-[13px]" :class="i === next ? 'bg-accent font-medium text-on-accent' : 'border border-strong text-bright'">{{ s.cta }}</RouterLink>
        </li>
      </ol>
      <p class="hint mt-5">Or review one pull request right away: <button class="link cursor-pointer" @click="openAdd">add it by link</button>.</p>
    </div>
  </div>
</template>
