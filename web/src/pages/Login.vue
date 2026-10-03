<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { connect, loadState } from "../store";

const route = useRoute();
const router = useRouter();
const setup = computed(() => route.meta.setup === true);
const login = ref("");
const password = ref("");
const error = ref("");
const busy = ref(false);

async function submit() {
  error.value = "";
  busy.value = true;
  try {
    await api.post(setup.value ? "/setup" : "/auth/login", { login: login.value.trim(), password: password.value });
    await loadState();
    connect();
    const next = String(route.query.next ?? "/");
    await router.push(next.startsWith("/") && !next.startsWith("//") ? next : "/");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="grid min-h-screen place-items-center px-4">
    <form class="grid w-full max-w-sm gap-4 rounded-lg border border-subtle bg-surface px-6 py-7" @submit.prevent="submit">
      <div>
        <h1 class="m-0 text-base font-medium text-bright"><span class="text-ok">$</span> agentic-pr-reviewer {{ setup ? "setup" : "login" }}<span class="cursor-blink text-accent">█</span></h1>
        <p class="mb-0 mt-1 text-tertiary">// {{ setup ? "first run: create the admin account" : "sign in to the review desk" }}</p>
      </div>
      <label><span class="label">login</span><input v-model="login" class="field" autocomplete="username" required autofocus></label>
      <label><span class="label">password</span><input v-model="password" class="field" type="password" :autocomplete="setup ? 'new-password' : 'current-password'" :minlength="setup ? 10 : undefined" required></label>
      <button type="submit" class="justify-self-start rounded-sm px-1 py-0.5 text-accent hover:bg-hover disabled:opacity-40" :disabled="busy">
        <span class="text-tertiary">[</span> {{ busy ? "…" : setup ? "create admin" : "sign in" }} <span class="text-tertiary">]</span>
      </button>
      <p v-if="error" class="m-0 text-danger" role="alert">! {{ error }}</p>
      <p v-if="setup" class="m-0 text-faint">// at least 10 characters. this page disappears once an admin exists.</p>
    </form>
  </main>
</template>
