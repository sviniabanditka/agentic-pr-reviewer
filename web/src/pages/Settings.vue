<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { api } from "../api";
import { store } from "../store";
import type { Channel } from "../types";
import TBtn from "../components/TBtn.vue";
import TPrompt from "../components/TPrompt.vue";
import { toast } from "../components/toast";

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

async function channelAct(key: string, fn: () => Promise<unknown>, ok: string) {
  saving[key] = true;
  try {
    await fn();
    toast(ok);
    await loadChannels();
  } catch (e) {
    toast((e as Error).message, true);
  } finally {
    saving[key] = false;
  }
}
const testChannel = (c: Channel) => channelAct(`t-${c.id}`, () => api.post(`/channels/${c.id}/test`), "test sent");
const flipChannel = (c: Channel) => channelAct(c.id, () => api.patch(`/channels/${c.id}`, { enabled: !c.enabled }), c.enabled ? "channel off" : "channel on");
const removeChannel = (c: Channel) => channelAct(c.id, () => api.del(`/channels/${c.id}`), "channel removed");
const addChannel = () =>
  channelAct("add", async () => {
    await api.post("/channels", { type: newChannel.type, label: newChannel.label, secret: newChannel.secret, events: newChannel.events, ...(newChannel.type === "telegram" ? { chatId: newChannel.chatId } : {}) });
    Object.assign(newChannel, { open: false, label: "", secret: "", chatId: "" });
  }, "channel added");
function toggle(list: string[], v: string) {
  const i = list.indexOf(v);
  if (i >= 0) list.splice(i, 1);
  else list.push(v);
}
const secretLabel = { webhook: "webhook url (https)", slack: "slack incoming webhook url", telegram: "bot token" };
</script>

<template>
  <div class="grid max-w-3xl gap-8">
    <section class="grid gap-3">
      <TPrompt :level="1">settings</TPrompt>
      <div class="rounded-lg border border-subtle bg-surface px-5 py-4 text-secondary">
        signed in as <span class="text-bright">{{ store.user?.login }}</span> <span class="text-tertiary">({{ store.user?.role }})</span>
      </div>
    </section>

    <section class="grid gap-3">
      <TPrompt>notifications</TPrompt>
      <div class="grid gap-3 rounded-lg border border-subtle bg-surface px-5 py-4">
        <p class="m-0 text-tertiary">// where to hear about reviews: a slack channel, a telegram chat, or any https webhook (json body). the url or bot token is stored encrypted.</p>
        <div v-for="c in channels" :key="c.id" class="grid gap-1 border-b border-subtle pb-2 last:border-0">
          <div class="flex flex-wrap items-center gap-3">
            <span class="text-bright">{{ c.label }}</span>
            <span class="text-accent2">{{ c.type }}</span>
            <span class="text-tertiary">{{ c.events.join(", ") }}</span>
            <span v-if="!c.enabled" class="text-faint">off</span>
            <span class="ml-auto flex gap-1">
              <TBtn :busy="saving[`t-${c.id}`]" @click="testChannel(c)">send test</TBtn>
              <TBtn @click="flipChannel(c)">{{ c.enabled ? "turn off" : "turn on" }}</TBtn>
              <TBtn tone="danger" confirm="remove?" @click="removeChannel(c)">remove</TBtn>
            </span>
          </div>
          <div v-if="c.lastError" class="text-warn">// last send failed: {{ c.lastError }}</div>
        </div>
        <div v-if="!newChannel.open"><TBtn tone="primary" @click="newChannel.open = true">add channel</TBtn></div>
        <form v-else class="grid gap-3" @submit.prevent="addChannel">
          <div class="grid gap-3 md:grid-cols-3">
            <label><span class="label">type</span><select v-model="newChannel.type" class="field"><option value="slack">slack</option><option value="telegram">telegram</option><option value="webhook">webhook</option></select></label>
            <label class="md:col-span-2"><span class="label">name</span><input v-model="newChannel.label" class="field" placeholder="team channel" required></label>
            <label class="md:col-span-2"><span class="label">{{ secretLabel[newChannel.type] }}</span><input v-model="newChannel.secret" class="field" type="password" autocomplete="off" required></label>
            <label v-if="newChannel.type === 'telegram'"><span class="label">chat id</span><input v-model="newChannel.chatId" class="field" required></label>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <span class="text-tertiary">send on</span>
            <label v-for="e in events" :key="e" class="flex items-center gap-1"><input type="checkbox" class="accent-[#9ece6a]" :checked="newChannel.events.includes(e)" @change="toggle(newChannel.events, e)"> {{ e }}</label>
          </div>
          <div class="flex gap-1"><TBtn type="submit" tone="primary" :busy="saving.add">save</TBtn><TBtn @click="newChannel.open = false">cancel</TBtn></div>
        </form>
      </div>
    </section>

    <section class="grid gap-3">
      <TPrompt>retention</TPrompt>
      <form class="flex flex-wrap items-end gap-3 rounded-lg border border-subtle bg-surface px-5 py-4" @submit.prevent="save('ret', { retentionDays: retention }, 'retention saved')">
        <p class="m-0 w-full text-tertiary">// findings quote code from the diff; they and pasted patches are deleted after this many days. verdicts, counts and costs stay.</p>
        <label><span class="label">keep findings for</span><input v-model.number="retention" type="number" min="1" max="3650" class="field w-28"></label>
        <span class="pb-2 text-tertiary">days</span>
        <TBtn type="submit" tone="primary" :busy="saving.ret">save</TBtn>
      </form>
    </section>

    <section class="grid gap-3">
      <TPrompt>models</TPrompt>
      <form class="grid gap-3 rounded-lg border border-subtle bg-surface px-5 py-4" @submit.prevent="save('models', { models: models.split('\n').map((m) => m.trim()).filter(Boolean) }, 'models saved')">
        <p class="m-0 text-tertiary">// one per line: what the model pickers offer. anything <span class="text-secondary">claude --model</span> accepts — aliases (sonnet, opus, haiku) or full ids (claude-opus-5-5).</p>
        <textarea v-model="models" class="field min-h-36" :disabled="!admin" aria-label="models" />
        <div><TBtn type="submit" tone="primary" :busy="saving.models" :disabled="!admin">save</TBtn>
          <span v-if="!admin" class="ml-2 text-faint">// admin only</span></div>
      </form>
    </section>

    <section class="grid gap-3">
      <TPrompt>sign in with github</TPrompt>
      <form class="grid gap-3 rounded-lg border border-subtle bg-surface px-5 py-4" @submit.prevent="save('oauth', { githubOauthClientId: clientId }, 'saved')">
        <p class="m-0 text-tertiary">// the client id of a github oauth app with device flow enabled. with it set, accounts can be added by signing in instead of pasting a token. no client secret is needed.</p>
        <input v-model="clientId" class="field max-w-80" placeholder="Iv1.0123456789abcdef" :disabled="!admin" aria-label="oauth client id">
        <div><TBtn type="submit" tone="primary" :busy="saving.oauth" :disabled="!admin">save</TBtn>
          <span v-if="!admin" class="ml-2 text-faint">// admin only</span></div>
      </form>
    </section>
  </div>
</template>
