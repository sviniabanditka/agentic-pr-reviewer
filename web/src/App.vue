<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "./api";
import { disconnect, store } from "./store";
import Toasts from "./components/Toasts.vue";
import ReviewDrawer from "./components/ReviewDrawer.vue";

const route = useRoute();
const router = useRouter();
const nav = [
  { to: "/", label: "overview", name: "overview" },
  { to: "/inbox", label: "inbox", name: "inbox" },
  { to: "/targets", label: "targets", name: "targets" },
  { to: "/profiles", label: "profiles", name: "profiles" },
  { to: "/accounts", label: "accounts", name: "accounts" },
  { to: "/activity", label: "activity", name: "activity" },
  { to: "/settings", label: "settings", name: "settings" },
];
const shell = computed(() => !route.meta.public);
const active = computed(() => [...store.reviews.values()].filter((r) => r.status === "running" || r.status === "queued").length);
const inboxCount = computed(() => [...store.items.values()].filter((i) => i.state === "open" && (!i.lastReview || (i.lastReview.status === "done" && i.lastReview.head_sha !== i.headSha))).length);

async function logout() {
  await api.post("/auth/logout").catch(() => {});
  disconnect();
  store.user = null;
  store.ready = false;
  await router.push({ name: "login" });
}
</script>

<template>
  <div v-if="shell" class="min-h-screen">
    <header class="sticky top-0 z-30 border-b border-subtle bg-base/90 backdrop-blur">
      <div class="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
        <RouterLink to="/" class="flex items-center gap-1 font-medium text-bright">
          <span class="text-ok">~/</span>agentic-pr-reviewer<span class="cursor-blink text-accent">█</span>
        </RouterLink>
        <nav class="flex flex-wrap items-center gap-1" aria-label="main">
          <RouterLink v-for="n in nav" :key="n.to" :to="n.to" class="rounded-sm px-2 py-1 hover:bg-hover"
            :class="route.name === n.name || (n.name === 'inbox' && route.name === 'item') ? 'bg-active text-bright' : 'text-tertiary'">
            {{ n.label }}<span v-if="n.name === 'inbox' && inboxCount" class="ml-1 text-accent2">{{ inboxCount }}</span>
          </RouterLink>
        </nav>
        <div class="ml-auto flex items-center gap-4 text-tertiary">
          <span v-if="active" class="text-accent">◐ {{ active }} running</span>
          <span class="flex items-center gap-1.5" :title="store.live ? 'live updates connected' : 'reconnecting'">
            <span :class="store.live ? 'text-ok' : 'text-danger'">●</span>{{ store.live ? "live" : "offline" }}
          </span>
          <span v-if="store.user" class="text-secondary">{{ store.user.login }}</span>
          <button class="rounded-sm px-1 hover:bg-hover hover:text-bright" @click="logout"><span>[</span> logout <span>]</span></button>
        </div>
      </div>
    </header>
    <main class="mx-auto max-w-[1440px] px-5 py-6">
      <div v-if="!store.ready" class="grid gap-3">
        <div class="skeleton h-24" /><div class="skeleton h-64" />
      </div>
      <RouterView v-else />
    </main>
    <ReviewDrawer />
  </div>
  <RouterView v-else />
  <Toasts />
</template>
