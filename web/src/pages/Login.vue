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
  <main class="grid min-h-screen place-items-center bg-base px-4">
    <form class="grid w-full max-w-[360px] gap-4 rounded-2xl border border-subtle bg-surface p-8" @submit.prevent="submit">
      <span aria-hidden="true" class="size-7 rounded-lg bg-accent" />
      <div>
        <h1 class="m-0 text-xl font-semibold text-bright">{{ needCode ? "Enter the code" : setup ? "Create the admin" : invite ? "Join" : "Sign in" }}</h1>
        <p class="m-0 mt-0.5 text-[13.5px] text-tertiary">{{ needCode ? `From your authenticator app, for ${login}.` : setup ? "First run of Agentic PR Reviewer." : invite ? `You were invited${inviteRole === "admin" ? " as an admin" : ""}. Pick a login and password.` : "Agentic PR Reviewer" }}</p>
      </div>
      <template v-if="!needCode">
        <label><span class="label">Login</span><input v-model="login" class="field bg-base" autocomplete="username" required autofocus></label>
        <label><span class="label">Password</span><input v-model="password" class="field bg-base" type="password" :autocomplete="creating ? 'new-password' : 'current-password'" :minlength="creating ? 10 : undefined" required></label>
      </template>
      <label v-else><span class="label">6-digit code</span>
        <input v-model="code" class="field border-[#4a4170] bg-base py-2.5 text-center text-[22px] tracking-[0.3em]" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required autofocus></label>
      <button type="submit" class="cursor-pointer rounded-[9px] bg-accent py-2.5 font-medium text-on-accent hover:bg-[#ae9fff] disabled:opacity-50" :disabled="busy">
        {{ busy ? "…" : needCode ? "Continue" : setup ? "Create admin" : invite ? "Create account" : "Sign in" }}
      </button>
      <button v-if="needCode" type="button" class="cursor-pointer text-[13px] text-tertiary hover:text-bright" @click="(needCode = false), (code = ''), (error = '')">Back to password</button>
      <p v-if="error && !(needCode && /enter the code/i.test(error))" class="m-0 text-[13px] text-danger" role="alert">{{ error }}</p>
      <p v-if="setup" class="hint">At least 10 characters. This page disappears once an admin exists.</p>
      <p v-if="invite" class="hint">At least 10 characters; the link works once. Your GitHub accounts, Claude subscription and reviews stay yours: the admin only sees how much you use.</p>
    </form>
  </main>
</template>
