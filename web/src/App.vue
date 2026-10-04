<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "./api";
import { disconnect, store } from "./store";
import Toasts from "./components/Toasts.vue";
import ReviewDrawer from "./components/ReviewDrawer.vue";
import Rail from "./components/Rail.vue";
import CommandPalette from "./components/CommandPalette.vue";

const route = useRoute();
const router = useRouter();
const shell = computed(() => !route.meta.public);

async function logout() {
  await api.post("/auth/logout").catch(() => {});
  disconnect();
  store.user = null;
  store.ready = false;
  await router.push({ name: "login" });
}
</script>

<template>
  <div v-if="shell" class="flex min-h-screen">
    <Rail @logout="logout" />
    <main class="min-w-0 flex-1">
      <div v-if="store.ready && !store.live" class="border-b border-warn/20 bg-warn-bg px-6 py-1.5 text-[13px] text-warn" role="status">Reconnecting to the server… live updates are paused.</div>
      <div v-if="!store.ready" class="grid gap-3 p-8">
        <div class="skeleton h-10 w-64" /><div class="skeleton h-64" />
      </div>
      <RouterView v-else />
    </main>
    <ReviewDrawer v-if="route.name !== 'inbox'" />
    <CommandPalette v-if="store.ready" />
  </div>
  <RouterView v-else />
  <Toasts />
</template>
