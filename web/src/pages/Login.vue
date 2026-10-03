<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { connect, loadState } from "../store";

const route = useRoute();
const router = useRouter();
const setup = computed(() => route.meta.setup === true);
const invite = computed(() => (route.meta.invite === true ? String(route.params.token) : null));
const creating = computed(() => setup.value || invite.value !== null);
const login = ref("");
const password = ref("");
const code = ref("");
const needCode = ref(false);
const inviteRole = ref<string | null>(null);
const error = ref("");
const busy = ref(false);
onMounted(async () => {
  if (!invite.value) return;
  try {
    inviteRole.value = (await api.get<{ role: string }>(`/invites/${invite.value}`)).role;
  } catch (e) {
    error.value = (e as Error).message;
  }
});

async function submit() {
  error.value = "";
  busy.value = true;
  try {
    const path = setup.value ? "/setup" : invite.value ? `/invites/${invite.value}` : "/auth/login";
    await api.post(path, { login: login.value.trim(), password: password.value, ...(needCode.value ? { code: code.value } : {}) });
    await loadState();
    connect();
    const next = String(route.query.next ?? "/");
    await router.push(next.startsWith("/") && !next.startsWith("//") ? next : "/");
  } catch (e) {
    error.value = (e as Error).message;
    // The server asks for the authenticator code only after the password checked out.
    if (!creating.value && /code/.test(error.value)) needCode.value = true;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="grid min-h-screen place-items-center px-4">
    <form class="grid w-full max-w-sm gap-4 rounded-lg border border-subtle bg-surface px-6 py-7" @submit.prevent="submit">
      <div>
        <h1 class="m-0 text-base font-medium text-bright"><span class="text-ok">$</span> agentic-pr-reviewer {{ setup ? "setup" : invite ? "join" : "login" }}<span class="cursor-blink text-accent">█</span></h1>
        <p class="mb-0 mt-1 text-tertiary">// {{ setup ? "first run: create the admin account" : invite ? `you were invited${inviteRole === "admin" ? " as an admin" : ""}: pick a login and password` : "sign in to the review desk" }}</p>
      </div>
      <label><span class="label">login</span><input v-model="login" class="field" autocomplete="username" required autofocus></label>
      <label><span class="label">password</span><input v-model="password" class="field" type="password" :autocomplete="creating ? 'new-password' : 'current-password'" :minlength="creating ? 10 : undefined" required></label>
      <label v-if="needCode"><span class="label">code from your authenticator app</span><input v-model="code" class="field tracking-widest" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required autofocus></label>
      <button type="submit" class="justify-self-start rounded-sm px-1 py-0.5 text-accent hover:bg-hover disabled:opacity-40" :disabled="busy">
        <span class="text-tertiary">[</span> {{ busy ? "…" : setup ? "create admin" : invite ? "create account" : "sign in" }} <span class="text-tertiary">]</span>
      </button>
      <p v-if="error" class="m-0 text-danger" role="alert">! {{ error }}</p>
      <p v-if="setup" class="m-0 text-faint">// at least 10 characters. this page disappears once an admin exists.</p>
      <p v-if="invite" class="m-0 text-faint">// at least 10 characters. the link works once. your github accounts, claude subscription and reviews stay yours: the admin sees only how much you use.</p>
    </form>
  </main>
</template>
