<script setup lang="ts">
import { computed } from "vue";
import { store } from "../store";

const emit = defineEmits<{ (e: "logout"): void }>();
// Stroke icons, 24-unit grid.
const ICONS: Record<string, string> = {
  inbox: "M3 13l3-8h12l3 8v6H3z M3 13h5l1 2h6l1-2h5",
  targets: "M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z",
  profiles: "M4 6h16 M4 12h10 M4 18h6",
  accounts: "M12 4.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z M5 20c1-4 4-6 7-6s6 2 7 6",
  activity: "M3 12h4l3-7 4 14 3-7h4",
  admin: "M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z",
  settings: "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M5.6 18.4l2.1-2.1 M16.3 7.7l2.1-2.1",
  logout: "M14 4h5v16h-5 M10 8l-4 4 4 4 M6 12h10",
};
const items = computed(() => [
  { to: "/", name: "inbox", label: "Inbox", badge: [...store.items.values()].filter((i) => i.state === "open" && needsYou(i)).length },
  { to: "/targets", name: "targets", label: "Targets" },
  { to: "/profiles", name: "profiles", label: "Profiles" },
  { to: "/accounts", name: "accounts", label: "Accounts" },
  { to: "/activity", name: "activity", label: "Activity" },
  ...(store.user?.role === "admin" ? [{ to: "/admin", name: "admin", label: "Admin" }] : []),
]);
function needsYou(i: { headSha: string | null; lastReview: { status: string; head_sha: string; comment_url: string | null } | null }) {
  const r = i.lastReview;
  return !r || r.status === "error" || (r.status === "done" && (r.head_sha !== i.headSha || !r.comment_url));
}
</script>

<template>
  <nav aria-label="main" class="sticky top-0 flex h-screen w-14 shrink-0 flex-col items-center gap-1 bg-rail py-4">
    <RouterLink to="/" aria-label="Agentic PR Reviewer" class="mb-4 size-6 rounded-[7px] bg-accent" />
    <RouterLink v-for="n in items" :key="n.name" v-slot="{ href, navigate, isExactActive, isActive }" :to="n.to" custom>
      <a :href="href" :aria-label="n.label" :title="n.label" :aria-current="(n.to === '/' ? isExactActive : isActive) ? 'page' : undefined"
        class="relative grid size-11 place-items-center rounded-[10px] transition-colors"
        :class="(n.to === '/' ? isExactActive : isActive) ? 'bg-active text-bright' : 'text-tertiary hover:bg-hover hover:text-bright'" @click="navigate">
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="ICONS[n.name]" /></svg>
        <span v-if="n.badge" class="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold text-on-accent">{{ n.badge }}</span>
      </a>
    </RouterLink>
    <RouterLink v-slot="{ href, navigate, isActive }" to="/settings" custom>
      <a :href="href" aria-label="Settings" title="Settings" class="mt-auto grid size-11 place-items-center rounded-[10px]"
        :class="isActive ? 'bg-active text-bright' : 'text-tertiary hover:bg-hover hover:text-bright'" @click="navigate">
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path :d="ICONS.settings" /></svg>
      </a>
    </RouterLink>
    <button class="grid size-11 cursor-pointer place-items-center rounded-[10px] text-tertiary hover:bg-hover hover:text-bright" :title="`Sign out ${store.user?.login ?? ''}`" aria-label="Sign out" @click="emit('logout')">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="ICONS.logout" /></svg>
    </button>
  </nav>
</template>
