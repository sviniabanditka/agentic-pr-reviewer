<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { api } from "../api";
import { store } from "../store";
import type { Channel } from "../types";
import TBtn from "../components/TBtn.vue";
import { toast } from "../components/toast";
import { stamp } from "../format";

const origin = location.origin;

interface Settings { models: string[]; retentionDays: number; githubOauthClientId: string }
const admin = store.user?.role === "admin";
const models = ref(store.models.join("\n"));
const retention = ref(90);
const clientId = ref("");
const saving = reactive<Record<string, boolean>>({});

const channels = ref<Channel[]>([]);
const events = ref<string[]>([]);
const newChannel = reactive({ open: false, type: "slack" as Channel["type"], label: "", secret: "", chatId: "", events: ["blocking", "failed", "posted"] as string[] });

onMounted(async () => {
  const s = await api.get<Settings>("/settings");
  retention.value = s.retentionDays;
  clientId.value = s.githubOauthClientId;
  await loadChannels();
});
async function loadChannels() {
  const r = await api.get<{ channels: Channel[]; events: string[] }>("/channels");
  channels.value = r.channels;
  events.value = r.events;
}

async function save(key: string, body: Partial<Settings>, ok: string) {
  saving[key] = true;
  try {
    const res = await api.patch<Settings>("/settings", body);
    store.models = res.models;
    models.value = res.models.join("\n");
    toast(ok);
  } catch (e) {
    toast((e as Error).message, true);
  } finally {
    saving[key] = false;
  }
}

async function channelAct(key: string, fn: () => Promise<unknown>, ok: string): Promise<boolean> {
  saving[key] = true;
  try {
    await fn();
    toast(ok);
    await loadChannels();
    return true;
  } catch (e) {
    toast((e as Error).message, true);
    return false;
  } finally {
    saving[key] = false;
  }
}
const testChannel = (c: Channel) => channelAct(`t-${c.id}`, () => api.post(`/channels/${c.id}/test`), "Test sent");
const flipChannel = (c: Channel) => channelAct(c.id, () => api.patch(`/channels/${c.id}`, { enabled: !c.enabled }), c.enabled ? "Channel off" : "Channel on");
const removeChannel = (c: Channel) => channelAct(c.id, () => api.del(`/channels/${c.id}`), "Channel removed");
const addChannel = () =>
  channelAct("add", async () => {
    await api.post("/channels", { type: newChannel.type, label: newChannel.label, secret: newChannel.secret, events: newChannel.events, ...(newChannel.type === "telegram" ? { chatId: newChannel.chatId } : {}) });
    Object.assign(newChannel, { open: false, label: "", secret: "", chatId: "" });
  }, "Channel added");
function toggle(list: string[], v: string) {
  const i = list.indexOf(v);
  if (i >= 0) list.splice(i, 1);
  else list.push(v);
}
const pw = reactive({ current: "", next: "" });
const savePassword = () =>
  channelAct("pw", async () => {
    await api.post("/auth/password", { current: pw.current, next: pw.next });
    Object.assign(pw, { current: "", next: "" });
  }, "Password changed; other browsers are signed out");
const totpOn = ref(false);
const totpSetup = ref<{ secret: string; uri: string } | null>(null);
const totpCodeIn = ref("");
const totpOff = reactive({ password: "", code: "", open: false });
onMounted(async () => {
  totpOn.value = (await api.get<{ totp: boolean }>("/auth/me")).totp;
});
const startTotp = () => channelAct("totp", async () => (totpSetup.value = await api.post("/auth/totp/setup")), "Add the key to your authenticator app");
const enableTotp = () =>
  channelAct("totp", async () => {
    await api.post("/auth/totp/enable", { code: totpCodeIn.value });
    totpOn.value = true;
    totpSetup.value = null;
    totpCodeIn.value = "";
  }, "Two-factor sign-in is on");
const disableTotp = () =>
  channelAct("totp", async () => {
    await api.post("/auth/totp/disable", { password: totpOff.password, code: totpOff.code });
    totpOn.value = false;
    Object.assign(totpOff, { password: "", code: "", open: false });
  }, "Two-factor sign-in is off");
interface ApiToken { id: string; label: string; hint: string; created_at: number; last_used_at: number | null }
const tokens = ref<ApiToken[]>([]);
const tokenLabel = ref("");
const shownToken = ref<string | null>(null);
const loadTokens = async () => (tokens.value = (await api.get<{ tokens: ApiToken[] }>("/tokens")).tokens);
onMounted(loadTokens);
const createToken = () =>
  channelAct("tok", async () => {
    shownToken.value = (await api.post<{ token: string }>("/tokens", { label: tokenLabel.value })).token;
    tokenLabel.value = "";
    await loadTokens();
  }, "Token created");
const revokeToken = (t: ApiToken) => channelAct(t.id, async () => {
  await api.del(`/tokens/${t.id}`);
  await loadTokens();
}, "Token revoked");
const secretLabel = { webhook: "Webhook URL (https)", slack: "Slack incoming webhook URL", telegram: "Bot token" };
const pwOpen = ref(false);
const sections = [["signin", "Sign-in"], ["notifications", "Notifications"], ["tokens", "API tokens"], ["retention", "Retention"], ["models", "Models"], ["github", "GitHub sign-in"]];
const active = ref("signin");
function go(id: string) {
  active.value = id;
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
</script>

<template>
  <div class="flex min-h-screen flex-wrap">
    <nav aria-label="Settings sections" class="grid flex-[0_0_220px] content-start gap-0.5 border-r border-subtle px-3 py-[22px]">
      <h1 class="m-0 mb-3 px-2.5 text-base font-semibold text-bright">Settings</h1>
      <button v-for="[id, label] in sections" :key="id" class="cursor-pointer rounded-lg px-2.5 py-[7px] text-left text-[13.5px]" :class="active === id ? 'bg-chip text-bright' : 'text-secondary hover:text-bright'" @click="go(id)">{{ label }}</button>
    </nav>
    <div class="grid max-w-[860px] min-w-0 flex-[999_1_560px] content-start gap-[34px] px-10 pb-16 pt-[26px]">
      <section id="signin" class="grid scroll-mt-6 gap-3.5">
        <div><h2 class="m-0 text-[15px] font-semibold text-bright">Sign-in</h2><p class="hint mt-0.5">Signed in as {{ store.user?.login }} ({{ store.user?.role }}).</p></div>
        <div class="card grid gap-3 px-[18px] py-4">
          <div class="flex flex-wrap items-center gap-3.5">
            <div class="flex-1"><div class="text-bright">Two-factor sign-in</div><div class="text-[12.5px] text-tertiary">A code from an authenticator app after the password.</div></div>
            <span class="chip" :class="totpOn ? 'bg-ok-bg text-ok' : ''">{{ totpOn ? "on" : "off" }}</span>
            <TBtn v-if="!totpOn && !totpSetup" :busy="saving.totp" @click="startTotp">Turn on</TBtn>
            <TBtn v-if="totpOn && !totpOff.open" @click="totpOff.open = true">Turn off</TBtn>
          </div>
          <form v-if="totpSetup" class="grid gap-2.5 border-t border-subtle pt-3" @submit.prevent="enableTotp">
            <p class="hint">Add this key to an authenticator app (1Password, Google Authenticator, Aegis…) as a time-based code, then type the 6-digit code it shows.</p>
            <code class="justify-self-start break-all rounded-lg bg-base px-3 py-1.5 tracking-[0.2em] text-bright">{{ totpSetup.secret.match(/.{1,4}/g)?.join(" ") }}</code>
            <a :href="totpSetup.uri" class="link justify-self-start text-[13px]">Open in an authenticator app on this device</a>
            <div class="flex flex-wrap items-end gap-2">
              <label><span class="label">Code</span><input v-model="totpCodeIn" class="field w-32 tracking-[0.2em]" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>
              <TBtn type="submit" tone="primary" :busy="saving.totp">Confirm</TBtn>
              <TBtn tone="ghost" @click="totpSetup = null">Cancel</TBtn>
            </div>
          </form>
          <form v-if="totpOff.open" class="flex flex-wrap items-end gap-2 border-t border-subtle pt-3" @submit.prevent="disableTotp">
            <label><span class="label">Password</span><input v-model="totpOff.password" class="field" type="password" autocomplete="current-password" required></label>
            <label><span class="label">Code</span><input v-model="totpOff.code" class="field w-32 tracking-[0.2em]" inputmode="numeric" maxlength="6" required></label>
            <TBtn type="submit" tone="danger" :busy="saving.totp">Turn off</TBtn>
            <TBtn tone="ghost" @click="totpOff.open = false">Cancel</TBtn>
          </form>
        </div>
        <div class="card grid gap-3 px-[18px] py-4">
          <div class="flex flex-wrap items-center gap-3.5">
            <div class="flex-1"><div class="text-bright">Password</div><div class="text-[12.5px] text-tertiary">Changing it signs out your other browsers.</div></div>
            <TBtn v-if="!pwOpen" @click="pwOpen = true">Change password</TBtn>
          </div>
          <form v-if="pwOpen" class="flex flex-wrap items-end gap-2 border-t border-subtle pt-3" @submit.prevent="savePassword().then((ok) => ok && (pwOpen = false))">
            <label><span class="label">Current password</span><input v-model="pw.current" class="field" type="password" autocomplete="current-password" required></label>
            <label><span class="label">New password</span><input v-model="pw.next" class="field" type="password" autocomplete="new-password" minlength="10" required></label>
            <TBtn type="submit" tone="primary" :busy="saving.pw">Save</TBtn>
            <TBtn tone="ghost" @click="pwOpen = false">Cancel</TBtn>
          </form>
        </div>
      </section>

      <section id="notifications" class="grid scroll-mt-6 gap-3.5">
        <div class="flex flex-wrap items-end gap-2.5">
          <div class="flex-1"><h2 class="m-0 text-[15px] font-semibold text-bright">Notifications</h2><p class="hint mt-0.5">Where to hear about finished, blocking and failed reviews. The URL or bot token is stored encrypted.</p></div>
          <TBtn v-if="!newChannel.open" tone="primary" @click="newChannel.open = true">+ Add channel</TBtn>
        </div>
        <form v-if="newChannel.open" class="card grid gap-3 px-[18px] py-4" @submit.prevent="addChannel">
          <div class="grid gap-3 md:grid-cols-3">
            <label><span class="label">Type</span><select v-model="newChannel.type" class="field"><option value="slack">Slack</option><option value="telegram">Telegram</option><option value="webhook">Webhook</option></select></label>
            <label class="md:col-span-2"><span class="label">Name</span><input v-model="newChannel.label" class="field" placeholder="#code-review" required></label>
            <label class="md:col-span-2"><span class="label">{{ secretLabel[newChannel.type] }}</span><input v-model="newChannel.secret" class="field" type="password" autocomplete="off" required></label>
            <label v-if="newChannel.type === 'telegram'"><span class="label">Chat id</span><input v-model="newChannel.chatId" class="field" required></label>
          </div>
          <div class="flex flex-wrap items-center gap-4">
            <span class="text-[13px] text-tertiary">Send on</span>
            <label v-for="e in events" :key="e" class="flex items-center gap-1.5"><input type="checkbox" class="accent-accent" :checked="newChannel.events.includes(e)" @change="toggle(newChannel.events, e)"> {{ e }}</label>
          </div>
          <div class="flex gap-1.5"><TBtn type="submit" tone="primary" :busy="saving.add">Save</TBtn><TBtn tone="ghost" @click="newChannel.open = false">Cancel</TBtn></div>
        </form>
        <div v-if="channels.length" class="panel overflow-hidden">
          <div v-for="c in channels" :key="c.id" class="grid gap-1 border-t border-subtle px-[18px] py-3.5 first:border-t-0" :class="c.enabled ? '' : 'opacity-60'">
            <div class="flex flex-wrap items-center gap-3">
              <span class="chip capitalize">{{ c.type }}</span><span class="font-medium text-bright">{{ c.label }}</span>
              <span class="text-[12.5px] text-tertiary">{{ c.events.join(" · ") }}</span>
              <span class="ml-auto flex gap-1.5">
                <TBtn size="sm" :busy="saving[`t-${c.id}`]" @click="testChannel(c)">Send test</TBtn>
                <TBtn size="sm" @click="flipChannel(c)">{{ c.enabled ? "Turn off" : "Turn on" }}</TBtn>
                <TBtn size="sm" tone="danger" confirm="Remove?" @click="removeChannel(c)">Remove</TBtn>
              </span>
            </div>
            <div v-if="c.lastError" class="text-xs text-warn">Last send failed: {{ c.lastError }}</div>
          </div>
        </div>
        <p v-else-if="!newChannel.open" class="hint">No channels yet.</p>
      </section>

      <section id="tokens" class="grid scroll-mt-6 gap-3.5">
        <div><h2 class="m-0 text-[15px] font-semibold text-bright">API tokens</h2>
          <p class="hint mt-0.5">For the <span class="font-mono text-secondary">apr</span> command line: <span class="font-mono text-secondary">APR_URL={{ origin }} APR_TOKEN=… apr review main</span> reviews your local branch. A token acts as you, except for admin pages and making more tokens.</p></div>
        <div v-if="tokens.length" class="panel overflow-hidden">
          <div v-for="t in tokens" :key="t.id" class="flex flex-wrap items-center gap-3 border-t border-subtle px-[18px] py-3 first:border-t-0">
            <span class="font-medium text-bright">{{ t.label }}</span><span class="font-mono text-[12.5px] text-tertiary">{{ t.hint }}</span>
            <span class="text-[12.5px] text-tertiary">{{ t.last_used_at ? `used ${stamp(t.last_used_at)}` : "never used" }}</span>
            <TBtn class="ml-auto" size="sm" tone="danger" confirm="Revoke?" @click="revokeToken(t)">Revoke</TBtn>
          </div>
        </div>
        <form class="flex flex-wrap items-end gap-2" @submit.prevent="createToken">
          <label><span class="label">Name</span><input v-model="tokenLabel" class="field" placeholder="laptop" maxlength="60" required></label>
          <TBtn type="submit" :busy="saving.tok">Create token</TBtn>
        </form>
        <div v-if="shownToken" class="grid gap-1.5 rounded-xl bg-warn-bg px-4 py-3">
          <span class="text-[13px] text-warn">Shown once — store it now.</span>
          <code class="break-all text-bright">{{ shownToken }}</code>
        </div>
      </section>

      <section id="retention" class="card flex scroll-mt-6 flex-wrap items-center gap-3.5 px-[18px] py-4">
        <div class="flex-[1_1_320px]"><div class="text-bright">Keep findings for</div><div class="text-[12.5px] text-tertiary">Quoted code and pasted patches are deleted after this; verdicts and numbers stay.</div></div>
        <form class="flex items-center gap-2" @submit.prevent="save('ret', { retentionDays: retention }, 'Retention saved')">
          <input v-model.number="retention" type="number" min="1" max="3650" class="field w-24 bg-base" aria-label="Days"><span class="text-tertiary">days</span>
          <TBtn type="submit" :busy="saving.ret">Save</TBtn>
        </form>
      </section>

      <section id="models" class="grid scroll-mt-6 gap-3.5">
        <div><h2 class="m-0 text-[15px] font-semibold text-bright">Models</h2><p class="hint mt-0.5">One per line: what the model pickers offer. Anything <span class="font-mono">claude --model</span> accepts — aliases (sonnet, opus, haiku) or full ids.{{ admin ? "" : " Only an admin can change this." }}</p></div>
        <form class="grid gap-2.5" @submit.prevent="save('models', { models: models.split('\n').map((m) => m.trim()).filter(Boolean) }, 'Models saved')">
          <textarea v-model="models" class="field min-h-32 font-mono text-[13px]" :disabled="!admin" aria-label="Models" />
          <div><TBtn type="submit" :busy="saving.models" :disabled="!admin">Save</TBtn></div>
        </form>
      </section>

      <section id="github" class="grid scroll-mt-6 gap-3.5">
        <div><h2 class="m-0 text-[15px] font-semibold text-bright">GitHub sign-in</h2><p class="hint mt-0.5">The client id of a GitHub OAuth app with device flow enabled. With it set, accounts can be added by signing in instead of pasting a token. No client secret is needed.{{ admin ? "" : " Only an admin can change this." }}</p></div>
        <form class="flex flex-wrap items-center gap-2" @submit.prevent="save('oauth', { githubOauthClientId: clientId }, 'Saved')">
          <input v-model="clientId" class="field max-w-80 font-mono text-[13px]" placeholder="Iv1.0123456789abcdef" :disabled="!admin" aria-label="OAuth client id">
          <TBtn type="submit" :busy="saving.oauth" :disabled="!admin">Save</TBtn>
        </form>
      </section>
    </div>
  </div>
</template>
