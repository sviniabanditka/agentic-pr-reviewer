import { createRouter, createWebHistory } from "vue-router";
import { api } from "./api";
import { connect, loadState, store } from "./store";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "inbox", component: () => import("./pages/Inbox.vue") },
    // Old links: the inbox is the home page, an item opens inside it.
    { path: "/inbox", redirect: (to) => ({ path: "/", query: to.query }) },
    { path: "/items/:id", redirect: (to) => ({ path: "/", query: { item: String(to.params.id) } }) },
    { path: "/targets", name: "targets", component: () => import("./pages/Targets.vue") },
    { path: "/accounts", name: "accounts", component: () => import("./pages/Accounts.vue") },
    { path: "/profiles", name: "profiles", component: () => import("./pages/Profiles.vue") },
    { path: "/activity", name: "activity", component: () => import("./pages/Activity.vue") },
    { path: "/settings", name: "settings", component: () => import("./pages/Settings.vue") },
    { path: "/admin", name: "admin", component: () => import("./pages/Admin.vue") },
    { path: "/login", name: "login", component: () => import("./pages/Login.vue"), meta: { public: true } },
    { path: "/setup", name: "setup", component: () => import("./pages/Login.vue"), meta: { public: true, setup: true } },
    { path: "/invite/:token", name: "invite", component: () => import("./pages/Login.vue"), meta: { public: true, invite: true } },
    { path: "/:rest(.*)", redirect: "/" },
  ],
});

router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  if (store.user) return true;
  try {
    const { needsSetup } = await api.get<{ needsSetup: boolean }>("/setup");
    if (needsSetup) return { name: "setup" };
    await loadState();
    connect();
    return true;
  } catch {
    return { name: "login", query: { next: to.fullPath } };
  }
});

/** Opens a review: inside the inbox there, as a side panel elsewhere. */
export function openReview(id: number): void {
  const current = router.currentRoute.value;
  void router.push({ query: { ...current.query, review: String(id) } });
}
