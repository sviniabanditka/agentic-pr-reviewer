<script setup lang="ts">
import { reactive, ref } from "vue";
import { api } from "../api";
import { refreshState, store } from "../store";
import { rel } from "../format";
import type { Account } from "../types";
import TBar from "../components/TBar.vue";
import TBtn from "../components/TBtn.vue";
import TPrompt from "../components/TPrompt.vue";
import { toast } from "../components/toast";

const newAccount = reactive({ token: "", label: "", busy: false, open: false });
const newCred = reactive({ token: "", label: "", busy: false, open: false });
const replacing = ref<string | null>(null);
const replaceToken = ref("");
const busy = reactive<Record<string, boolean>>({});

async function run(key: string, fn: () => Promise<unknown>, ok?: string) {
  busy[key] = true;
  try {
    await fn();
    if (ok) toast(ok);
    await refreshState();
  } catch (e) {
    toast((e as Error).message, true);
  } finally {
    busy[key] = false;
  }
}
async function addAccount() {
  newAccount.busy = true;
  await run("add-account", () => api.post("/accounts", { token: newAccount.token, label: newAccount.label || undefined }), "account added");
  if (!busy["add-account"]) Object.assign(newAccount, { token: "", label: "", open: false });
  newAccount.busy = false;
}
async function addCredential() {
  newCred.busy = true;
  await run("add-cred", () => api.post("/credentials", { provider: "claude-cli", token: newCred.token, label: newCred.label || undefined }), "credential added");
  Object.assign(newCred, { token: "", label: "", open: false, busy: false });
}
const patch = (a: Account, body: Record<string, unknown>) => run(a.id, () => api.patch(`/accounts/${a.id}`, body), "saved");
const checkAccount = (id: string) => run(`check-${id}`, () => api.post(`/accounts/${id}/check`), "checked");
const removeAccount = (id: string) => run(id, () => api.del(`/accounts/${id}`), "account removed");
async function saveToken(id: string) {
  await run(`tok-${id}`, () => api.put(`/accounts/${id}/token`, { token: replaceToken.value }), "token replaced");
  replacing.value = null;
}
const renameCredential = (id: string, label: string) => run(id, () => api.patch(`/credentials/${id}`, { label }), "saved");
const checkCredential = (id: string) => run(`check-${id}`, () => api.post(`/credentials/${id}/check`), "limits refreshed");
const removeCredential = (id: string) => run(id, () => api.del(`/credentials/${id}`), "credential removed");
const inputValue = (e: Event) => (e.target as HTMLInputElement).value;
</script>

<template>
  <div class="grid gap-8">
    <section class="grid gap-3">
      <div class="flex flex-wrap items-center gap-3">
        <TPrompt :level="1">github accounts</TPrompt>
        <TBtn class="ml-auto" tone="primary" @click="newAccount.open = !newAccount.open">add account</TBtn>
      </div>
      <form v-if="newAccount.open" class="grid gap-3 rounded-lg border border-accent/40 bg-surface px-5 py-4" @submit.prevent="addAccount">
        <p class="m-0 text-tertiary">// paste a token: <span class="text-secondary">gh auth token --user &lt;login&gt;</span>, or a fine-grained token with pull requests: read &amp; write, contents: read.
          it is checked against github, then stored encrypted and never shown again.</p>
        <div class="grid gap-3 md:grid-cols-[2fr_1fr_auto] md:items-end">
          <label><span class="label">token</span><input v-model="newAccount.token" class="field" type="password" autocomplete="off" required></label>
          <label><span class="label">label (optional)</span><input v-model="newAccount.label" class="field" placeholder="work"></label>
          <TBtn type="submit" tone="primary" :busy="newAccount.busy">check &amp; save</TBtn>
        </div>
      </form>
      <ul class="m-0 grid gap-2 p-0">
        <li v-for="a in store.accounts" :key="a.id" class="grid list-none gap-3 rounded-lg border border-subtle bg-surface px-4 py-4">
          <div class="flex flex-wrap items-center gap-3">
            <span class="font-medium text-bright">{{ a.label }}</span><span class="text-tertiary">@{{ a.login }}</span>
            <span :class="a.status === 'ok' ? 'text-ok' : 'text-danger'">● {{ a.status }}</span>
            <span class="text-faint">token {{ a.tokenHint }}</span>
            <span v-if="a.scopes" class="text-faint">scopes: {{ a.scopes }}</span>
            <span class="ml-auto flex items-center gap-2 text-tertiary">github api <TBar :pct="a.github?.core ? 100 - (a.github.core.remaining / a.github.core.limit) * 100 : null" :width="10" /></span>
          </div>
          <div v-if="a.statusDetail" class="text-danger">! {{ a.statusDetail }}</div>
          <div class="grid gap-3 md:grid-cols-4">
            <label><span class="label">label</span><input :value="a.label" class="field" @change="patch(a, { label: inputValue($event) })"></label>
            <label><span class="label">claude credential for reviews</span>
              <select :value="a.credentialId ?? ''" class="field" @change="patch(a, { credentialId: inputValue($event) || null })">
                <option value="">none — reviews off</option><option v-for="c in store.credentials" :key="c.id" :value="c.id">{{ c.label }}</option></select></label>
            <label><span class="label">default model</span>
              <select :value="a.model ?? ''" class="field" @change="patch(a, { model: inputValue($event) || null })">
                <option value="">first in the list ({{ store.models[0] }})</option><option v-for="m in store.models" :key="m" :value="m">{{ m }}</option></select></label>
            <label><span class="label">default profile</span>
              <select :value="a.profileId ?? ''" class="field" @change="patch(a, { profileId: inputValue($event) || null })">
                <option value="">your default ({{ store.profiles.find((p) => p.isDefault)?.name.toLowerCase() }})</option>
                <option v-for="p in store.profiles" :key="p.id" :value="p.id">{{ p.name.toLowerCase() }}</option></select></label>
          </div>
          <div class="flex flex-wrap items-center gap-1">
            <TBtn :busy="busy[`check-${a.id}`]" @click="checkAccount(a.id)">check token</TBtn>
            <TBtn @click="(replacing = replacing === a.id ? null : a.id), (replaceToken = '')">replace token</TBtn>
            <TBtn tone="danger" :confirm="`remove @${a.login} and its targets?`" @click="removeAccount(a.id)">remove</TBtn>
            <span class="ml-auto text-faint">checked {{ rel(a.checkedAt, store.now) }}</span>
          </div>
          <form v-if="replacing === a.id" class="flex flex-wrap items-end gap-3" @submit.prevent="saveToken(a.id)">
            <label class="flex-1"><span class="label">new token for @{{ a.login }}</span><input v-model="replaceToken" class="field" type="password" autocomplete="off" required></label>
            <TBtn type="submit" tone="primary" :busy="busy[`tok-${a.id}`]">save</TBtn>
          </form>
        </li>
        <li v-if="!store.accounts.length" class="list-none text-tertiary">// no accounts yet</li>
      </ul>
    </section>

    <section class="grid gap-3">
      <div class="flex flex-wrap items-center gap-3">
        <TPrompt :level="1">claude credentials</TPrompt>
        <TBtn class="ml-auto" tone="primary" @click="newCred.open = !newCred.open">add credential</TBtn>
      </div>
      <form v-if="newCred.open" class="grid gap-3 rounded-lg border border-accent/40 bg-surface px-5 py-4" @submit.prevent="addCredential">
        <p class="m-0 text-tertiary">// run <span class="text-secondary">claude setup-token</span> with the subscription that should pay for reviews and paste its output.
          it is validated with a tiny haiku request, stored encrypted, and only ever handed to the claude process.</p>
        <div class="grid gap-3 md:grid-cols-[2fr_1fr_auto] md:items-end">
          <label><span class="label">token</span><input v-model="newCred.token" class="field" type="password" autocomplete="off" required></label>
          <label><span class="label">label</span><input v-model="newCred.label" class="field" placeholder="personal max"></label>
          <TBtn type="submit" tone="primary" :busy="newCred.busy">validate &amp; save</TBtn>
        </div>
      </form>
      <ul class="m-0 grid gap-2 p-0">
        <li v-for="c in store.credentials" :key="c.id" class="grid list-none gap-2 rounded-lg border border-subtle bg-surface px-4 py-4">
          <div class="flex flex-wrap items-center gap-3">
            <input :value="c.label" class="field w-56 py-1" :aria-label="`label of ${c.label}`" @change="renameCredential(c.id, inputValue($event))">
            <span class="text-tertiary">{{ c.provider }}</span>
            <span :class="c.status === 'ok' ? 'text-ok' : 'text-warn'">● {{ c.status }}</span>
            <span class="text-faint">token {{ c.tokenHint }}</span>
            <span class="text-faint">used by {{ store.accounts.filter((a) => a.credentialId === c.id).map((a) => a.label).join(", ") || "no account" }}</span>
          </div>
          <div class="flex flex-wrap items-center gap-x-6 gap-y-1">
            <span class="flex items-center gap-2"><span class="text-tertiary">5h</span><TBar :pct="c.limits?.fiveHour ? c.limits.fiveHour.utilization * 100 : null" />
              <span class="text-faint">{{ c.limits?.fiveHour ? `resets ${rel(c.limits.fiveHour.resetsAt, store.now)}` : "" }}</span></span>
            <span class="flex items-center gap-2"><span class="text-tertiary">7d</span><TBar :pct="c.limits?.sevenDay ? c.limits.sevenDay.utilization * 100 : null" />
              <span class="text-faint">{{ c.limits?.sevenDay ? `resets ${rel(c.limits.sevenDay.resetsAt, store.now)}` : "" }}</span></span>
          </div>
          <div v-if="c.statusDetail" class="text-warn">! {{ c.statusDetail }}</div>
          <div class="flex flex-wrap items-center gap-1">
            <TBtn :busy="busy[`check-${c.id}`]" title="sends a tiny haiku request" @click="checkCredential(c.id)">check limits</TBtn>
            <TBtn tone="danger" confirm="remove this credential?" @click="removeCredential(c.id)">remove</TBtn>
            <span class="ml-auto text-faint">checked {{ rel(c.checkedAt, store.now) }}</span>
          </div>
        </li>
        <li v-if="!store.credentials.length" class="list-none text-tertiary">// no credentials yet</li>
      </ul>
    </section>
  </div>
</template>
