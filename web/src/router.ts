import { createRouter, createWebHistory } from "vue-router";
import { api } from "./api";
import { connect, loadState, store } from "./store";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "overview", component: () => import("./pages/Overview.vue") },
    { path: "/inbox", name: "inbox", component: () => import("./pages/Inbox.vue") },
    { path: "/items/:id", name: "item", component: () => import("./pages/ItemPage.vue"), props: true },
    { path: "/targets", name: "targets", component: () => import("./pages/Targets.vue") },
    { path: "/accounts", name: "accounts", component: () => import("./pages/Accounts.vue") },
    { path: "/profiles", name: "profiles", component: () => import("./pages/Profiles.vue") },
    { path: "/activity", name: "activity", component: () => import("./pages/Activity.vue") },
    { path: "/settings", name: "settings", component: () => import("./pages/Settings.vue") },
    { path: "/admin", name: "admin", component: () => import("./pages/Admin.vue") },
    { path: "/invite/:token", name: "invite", component: () => import("./pages/Login.vue"), meta: { public: true, invite: true } },
    { path: "/login", name: "login", component: () => import("./pages/Login.vue"), meta: { public: true } },
    { path: "/setup", name: "setup", component: () => import("./pages/Login.vue"), meta: { public: true, setup: true } },
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

/** Opens the review panel over the current page. */
export function openReview(id: number): void {
  void router.push({ query: { ...router.currentRoute.value.query, review: String(id) } });
}
