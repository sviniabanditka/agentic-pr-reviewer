<script setup lang="ts">
import { reactive, ref } from "vue";
import { api } from "../api";
import { refreshState, store } from "../store";
import { rel } from "../format";
import type { Account } from "../types";
import TBar from "../components/TBar.vue";
import TBtn from "../components/TBtn.vue";
import { toast } from "../components/toast";

const newAccount = reactive({ token: "", label: "", busy: false, open: false });
const newCred = reactive({ provider: "claude-cli", token: "", label: "", busy: false, open: false });
const replacing = ref<string | null>(null);
const replaceToken = ref("");
const busy = reactive<Record<string, boolean>>({});

async function run(key: string, fn: () => Promise<unknown>, ok?: string): Promise<boolean> {
  busy[key] = true;
  try {
    await fn();
    if (ok) toast(ok);
    await refreshState();
    return true;
  } catch (e) {
    toast((e as Error).message, true);
    return false;
  } finally {
    busy[key] = false;
  }
}
async function addAccount() {
  if (await run("add-account", () => api.post("/accounts", { token: newAccount.token, label: newAccount.label || undefined }), "Account added")) Object.assign(newAccount, { token: "", label: "", open: false });
}
const device = reactive<{ id: string | null; userCode?: string; verificationUri?: string; interval?: number }>({ id: null });
async function deviceLogin() {
  try {
    Object.assign(device, await api.post("/accounts/device", {}));
    void pollDevice();
  } catch (e) {
    toast((e as Error).message, true);
  }
}
async function pollDevice() {
  while (device.id) {
    await new Promise((r) => setTimeout(r, (device.interval ?? 5) * 1000 + 500));
    if (!device.id) return;
    try {
      const r = await api.post<{ status: string }>(`/accounts/device/${device.id}`);
      if (r.status === "done") {
        device.id = null;
        toast("Account added");
        await refreshState();
      }
    } catch (e) {
      device.id = null;
      toast((e as Error).message, true);
    }
  }
}
async function addCredential() {
  if (await run("add-cred", () => api.post("/credentials", { provider: newCred.provider, token: newCred.token, label: newCred.label || undefined }), "Credential added")) {
    Object.assign(newCred, { provider: "claude-cli", token: "", label: "", open: false });
  }
}
const patch = (a: Account, body: Record<string, unknown>) => run(a.id, () => api.patch(`/accounts/${a.id}`, body), "Saved");
const checkAccount = (id: string) => run(`check-${id}`, () => api.post(`/accounts/${id}/check`), "Checked");
const removeAccount = (id: string) => run(id, () => api.del(`/accounts/${id}`), "Account removed");
async function saveToken(id: string) {
  if (await run(`tok-${id}`, () => api.put(`/accounts/${id}/token`, { token: replaceToken.value }), "Token replaced")) replacing.value = null;
}
const renameCredential = (id: string, label: string) => run(id, () => api.patch(`/credentials/${id}`, { label }), "Saved");
const checkCredential = (id: string) => run(`check-${id}`, () => api.post(`/credentials/${id}/check`), "Limits refreshed");
const removeCredential = (id: string) => run(id, () => api.del(`/credentials/${id}`), "Credential removed");
const value = (e: Event) => (e.target as HTMLInputElement).value;
const used = (q?: { limit: number; remaining: number }) => (q ? 100 - (q.remaining / q.limit) * 100 : null);
</script>

<template>
  <div class="grid max-w-[1200px] gap-9 px-10 pb-12 pt-[26px]">
    <section aria-labelledby="gh" class="grid gap-3.5">
      <div>
        <div class="flex flex-wrap items-center gap-2">
          <h1 id="gh" class="m-0 text-base font-semibold text-bright">GitHub accounts</h1>
          <span class="ml-auto" />
          <TBtn v-if="!device.id" @click="deviceLogin">Sign in with GitHub</TBtn>
          <TBtn tone="primary" @click="newAccount.open = !newAccount.open">+ Paste a token</TBtn>
        </div>
        <p class="hint mt-1">Whose name reviews are posted under. Tokens are checked with GitHub, stored encrypted and never shown again.</p>
      </div>
      <div v-if="device.id && device.userCode" class="card flex flex-wrap items-center gap-3 px-5 py-4">
        <span>Open <a :href="device.verificationUri" target="_blank" rel="noopener" class="link">{{ device.verificationUri }}</a> and enter</span>
        <span class="rounded-lg bg-base px-3 py-1 font-mono text-lg tracking-[0.25em] text-bright">{{ device.userCode }}</span>
        <span class="text-tertiary">Waiting for GitHub…</span>
        <TBtn class="ml-auto" tone="ghost" @click="device.id = null">Cancel</TBtn>
      </div>
      <form v-if="newAccount.open" class="card grid gap-3 px-5 py-4" @submit.prevent="addAccount">
        <p class="hint">A token from <span class="font-mono text-secondary">gh auth token --user &lt;login&gt;</span>, or a fine-grained token with Pull requests: read and write, Contents: read.</p>
        <div class="grid gap-3 md:grid-cols-[2fr_1fr_auto] md:items-end">
          <label><span class="label">Token</span><input v-model="newAccount.token" class="field" type="password" autocomplete="off" required></label>
          <label><span class="label">Name (optional)</span><input v-model="newAccount.label" class="field" placeholder="work"></label>
          <TBtn type="submit" tone="primary" :busy="busy['add-account']">Check and save</TBtn>
        </div>
      </form>
      <div class="grid gap-3 lg:grid-cols-2">
        <article v-for="a in store.accounts" :key="a.id" class="card grid content-start gap-3.5 px-5 py-[18px]">
          <div class="flex items-center gap-2.5">
            <span aria-hidden="true" class="grid size-8 place-items-center rounded-full bg-[#2a2836] font-semibold text-[#dcd4ff]">{{ a.label.charAt(0).toUpperCase() }}</span>
            <div class="min-w-0 flex-1">
              <input :value="a.label" class="w-full bg-transparent font-medium text-bright outline-none" :aria-label="`Name of @${a.login}`" @change="patch(a, { label: value($event) })">
              <div class="text-[12.5px] text-tertiary">@{{ a.login }} · token {{ a.tokenHint }} · checked {{ rel(a.checkedAt, store.now) }}</div>
            </div>
            <span class="chip" :class="a.status === 'ok' ? 'bg-ok-bg text-ok' : 'bg-danger-bg text-danger'">{{ a.status === "ok" ? "working" : a.status }}</span>
          </div>
          <p v-if="a.statusDetail" class="m-0 text-[13px] text-danger">{{ a.statusDetail }}</p>
          <div class="grid grid-cols-2 gap-3">
            <TBar label="GitHub API used" :pct="used(a.github?.core)" color="#8bd3a3" />
            <TBar label="Search used" :pct="used(a.github?.search)" color="#8bd3a3" />
          </div>
          <div class="grid gap-2 sm:grid-cols-3">
            <label><span class="label">Claude</span>
              <select :value="a.credentialId ?? ''" class="field bg-base py-1.5 text-[13px]" @change="patch(a, { credentialId: value($event) || null })">
                <option value="">None — reviews off</option><option v-for="c in store.credentials" :key="c.id" :value="c.id">{{ c.label }}</option></select></label>
            <label><span class="label">Model</span>
              <select :value="a.model ?? ''" class="field bg-base py-1.5 text-[13px]" @change="patch(a, { model: value($event) || null })">
                <option value="">First in the list ({{ store.models[0] }})</option><option v-for="m in store.models" :key="m" :value="m">{{ m }}</option></select></label>
            <label><span class="label">Profile</span>
              <select :value="a.profileId ?? ''" class="field bg-base py-1.5 text-[13px]" @change="patch(a, { profileId: value($event) || null })">
                <option value="">Your default ({{ store.profiles.find((p) => p.isDefault)?.name }})</option>
                <option v-for="p in store.profiles" :key="p.id" :value="p.id">{{ p.name }}</option></select></label>
          </div>
          <div class="flex flex-wrap items-center gap-1.5">
            <TBtn size="sm" :busy="busy[`check-${a.id}`]" @click="checkAccount(a.id)">Check</TBtn>
            <TBtn size="sm" @click="(replacing = replacing === a.id ? null : a.id), (replaceToken = '')">Replace token</TBtn>
            <TBtn class="ml-auto" size="sm" tone="danger" :confirm="`Remove @${a.login} and its targets?`" @click="removeAccount(a.id)">Remove</TBtn>
          </div>
          <form v-if="replacing === a.id" class="flex flex-wrap items-end gap-2" @submit.prevent="saveToken(a.id)">
            <label class="flex-1"><span class="label">New token for @{{ a.login }}</span><input v-model="replaceToken" class="field bg-base" type="password" autocomplete="off" required></label>
            <TBtn type="submit" tone="primary" :busy="busy[`tok-${a.id}`]">Save</TBtn>
          </form>
        </article>
      </div>
      <p v-if="!store.accounts.length" class="hint">No accounts yet. Sign in with GitHub or paste a token.</p>
    </section>

    <section aria-labelledby="claude" class="grid gap-3.5">
      <div>
        <div class="flex flex-wrap items-center gap-2">
          <h2 id="claude" class="m-0 text-base font-semibold text-bright">Claude</h2>
          <TBtn class="ml-auto" tone="primary" @click="newCred.open = !newCred.open">+ Add credential</TBtn>
        </div>
        <p class="hint mt-1">Who pays for the model runs: a Claude subscription (from <span class="font-mono">claude setup-token</span>) or an Anthropic API key.</p>
      </div>
      <form v-if="newCred.open" class="card grid gap-3 px-5 py-4" @submit.prevent="addCredential">
        <p class="hint">{{ newCred.provider === "claude-cli"
          ? "Run claude setup-token with the subscription that should pay and paste its output. It is checked with a tiny Haiku request, stored encrypted and only handed to the claude process."
          : "An Anthropic API key (console.anthropic.com → API keys). Billed per token to that account; checked by listing models, sent only to api.anthropic.com." }}</p>
        <div class="grid gap-3 md:grid-cols-[1fr_2fr_1fr_auto] md:items-end">
          <label><span class="label">Kind</span><select v-model="newCred.provider" class="field"><option value="claude-cli">Claude subscription</option><option value="anthropic-api">Anthropic API key</option></select></label>
          <label><span class="label">Token</span><input v-model="newCred.token" class="field" type="password" autocomplete="off" required></label>
          <label><span class="label">Name</span><input v-model="newCred.label" class="field" placeholder="Personal Max"></label>
          <TBtn type="submit" tone="primary" :busy="busy['add-cred']">Check and save</TBtn>
        </div>
      </form>
      <div v-if="store.credentials.length" class="panel overflow-hidden">
        <div v-for="c in store.credentials" :key="c.id" class="grid items-center gap-x-5 gap-y-2 border-t border-subtle px-[18px] py-3.5 first:border-t-0 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
          <div class="min-w-0">
            <input :value="c.label" class="w-full bg-transparent font-medium text-bright outline-none" :aria-label="`Name of ${c.label}`" @change="renameCredential(c.id, value($event))">
            <div class="truncate text-[12.5px] text-tertiary">{{ c.provider === "anthropic-api" ? "Anthropic API key" : "Claude subscription" }} · {{ c.tokenHint }} · used by {{ store.accounts.filter((a) => a.credentialId === c.id).map((a) => a.label).join(", ") || "no account" }}</div>
            <div v-if="c.statusDetail" class="text-xs text-warn">{{ c.statusDetail }}</div>
          </div>
          <template v-if="c.provider !== 'anthropic-api'">
            <div><TBar label="5 hours" :pct="c.limits?.fiveHour ? c.limits.fiveHour.utilization * 100 : null" /><div v-if="c.limits?.fiveHour" class="mt-1 text-[11.5px] text-faint">resets {{ rel(c.limits.fiveHour.resetsAt, store.now) }}</div></div>
            <div><TBar label="7 days" :pct="c.limits?.sevenDay ? c.limits.sevenDay.utilization * 100 : null" /><div v-if="c.limits?.sevenDay" class="mt-1 text-[11.5px] text-faint">resets {{ rel(c.limits.sevenDay.resetsAt, store.now) }}</div></div>
          </template>
          <div v-else class="text-[13px] text-tertiary md:col-span-2">Billed per token; no usage windows.</div>
          <div class="flex gap-1.5">
            <TBtn size="sm" :busy="busy[`check-${c.id}`]" @click="checkCredential(c.id)">Refresh</TBtn>
            <TBtn size="sm" tone="danger" confirm="Remove?" @click="removeCredential(c.id)">Remove</TBtn>
          </div>
        </div>
      </div>
      <p v-else class="hint">No credentials yet: reviews need one.</p>
    </section>
  </div>
</template>
