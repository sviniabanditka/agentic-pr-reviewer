<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../api";
import { store } from "../store";
import { dur, stamp } from "../format";
import TBtn from "../components/TBtn.vue";
import TPrompt from "../components/TPrompt.vue";
import { toast } from "../components/toast";

interface UserLoad {
  id: string; login: string; role: "admin" | "member"; disabled: number; created_at: number; totp_enabled: number; last_seen_at: number | null;
  accounts: number; credentials: number; targets: number; active: number; reviews_24h: number; reviews_7d: number; errors_7d: number; tokens_7d: number; busy_ms_7d: number;
}
interface Invite { id: string; role: string; note: string; created_at: number; expires_at: number; used_at: number | null; used_by: string | null }

const users = ref<UserLoad[]>([]);
const queue = ref<{ status: string; n: number }[]>([]);
const invites = ref<Invite[]>([]);
const newInvite = ref({ role: "member", note: "" });
const link = ref<string | null>(null);

async function load() {
  const [u, i] = await Promise.all([api.get<{ users: UserLoad[]; queue: typeof queue.value }>("/admin/users"), api.get<{ invites: Invite[] }>("/admin/invites")]);
  users.value = u.users;
  queue.value = u.queue;
  invites.value = i.invites;
}
onMounted(() => load().catch((e) => toast((e as Error).message, true)));

async function act(fn: () => Promise<unknown>, ok: string) {
  try {
    await fn();
    toast(ok);
    await load();
  } catch (e) {
    toast((e as Error).message, true);
  }
}
async function createInvite() {
  try {
    const r = await api.post<{ url: string }>("/admin/invites", newInvite.value);
    link.value = r.url;
    newInvite.value.note = "";
    await load();
  } catch (e) {
    toast((e as Error).message, true);
  }
}
async function copy() {
  try {
    await navigator.clipboard.writeText(link.value!);
    toast("invite link copied");
  } catch {
    toast("could not copy; select the link by hand", true);
  }
}
const setUser = (u: UserLoad, body: Record<string, unknown>, ok: string) => act(() => api.patch(`/admin/users/${u.id}`, body), ok);
const revoke = (i: Invite) => act(() => api.del(`/admin/invites/${i.id}`), "invite revoked");
const inviteState = (i: Invite) => (i.used_at ? `joined as ${i.used_by ?? "?"}` : i.expires_at < store.now ? "expired" : `open until ${stamp(i.expires_at)}`);
</script>

<template>
  <div class="grid gap-8">
    <section class="grid gap-3">
      <div class="flex flex-wrap items-center gap-3">
        <TPrompt :level="1">users</TPrompt>
        <span class="text-tertiary">// who uses this instance and how much. reviews, repositories and tokens of others are never shown here.</span>
        <span class="ml-auto text-tertiary">queue: {{ queue.find((q) => q.status === "running")?.n ?? 0 }} running, {{ queue.find((q) => q.status === "queued")?.n ?? 0 }} waiting</span>
      </div>
      <div class="overflow-x-auto rounded-lg border border-subtle bg-surface">
        <table class="w-full min-w-[760px] border-collapse text-left text-[13px]">
          <thead class="text-tertiary">
            <tr><th class="px-3 py-2 font-normal">user</th><th class="px-3 py-2 font-normal">last seen</th><th class="px-3 py-2 font-normal">accounts / subs / targets</th>
              <th class="px-3 py-2 font-normal">reviews 24h / 7d</th><th class="px-3 py-2 font-normal">failed 7d</th><th class="px-3 py-2 font-normal">tokens 7d</th>
              <th class="px-3 py-2 font-normal">model time 7d</th><th class="px-3 py-2 font-normal">now</th><th class="px-3 py-2" /></tr>
          </thead>
          <tbody>
            <tr v-for="u in users" :key="u.id" class="border-t border-subtle" :class="u.disabled ? 'opacity-50' : ''">
              <td class="px-3 py-2"><span class="text-bright">{{ u.login }}</span>
                <span v-if="u.role === 'admin'" class="ml-2 text-accent">admin</span><span v-if="u.totp_enabled" class="ml-2 text-ok">2fa</span><span v-if="u.disabled" class="ml-2 text-danger">disabled</span></td>
              <td class="px-3 py-2 text-tertiary">{{ u.last_seen_at ? stamp(u.last_seen_at) : "never" }}</td>
              <td class="px-3 py-2 text-secondary">{{ u.accounts }} / {{ u.credentials }} / {{ u.targets }}</td>
              <td class="px-3 py-2 text-secondary">{{ u.reviews_24h }} / {{ u.reviews_7d }}</td>
              <td class="px-3 py-2" :class="u.errors_7d ? 'text-warn' : 'text-tertiary'">{{ u.errors_7d }}</td>
              <td class="px-3 py-2 text-secondary">{{ u.tokens_7d.toLocaleString("en") }}</td>
              <td class="px-3 py-2 text-secondary">{{ dur(u.busy_ms_7d) }}</td>
              <td class="px-3 py-2" :class="u.active ? 'text-accent' : 'text-faint'">{{ u.active ? `${u.active} in queue` : "idle" }}</td>
              <td class="px-3 py-2 text-right">
                <template v-if="u.id !== store.user?.id">
                  <TBtn v-if="!u.disabled" tone="danger" :confirm="`disable ${u.login}?`" @click="setUser(u, { disabled: true }, 'user disabled')">disable</TBtn>
                  <TBtn v-else @click="setUser(u, { disabled: false }, 'user enabled')">enable</TBtn>
                  <TBtn :confirm="u.role === 'admin' ? 'make member?' : 'make admin?'" @click="setUser(u, { role: u.role === 'admin' ? 'member' : 'admin' }, 'role changed')">{{ u.role === "admin" ? "make member" : "make admin" }}</TBtn>
                  <TBtn v-if="u.totp_enabled" confirm="turn off their 2fa?" @click="setUser(u, { resetTotp: true }, '2fa reset')">reset 2fa</TBtn>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="grid gap-3">
      <TPrompt>invites</TPrompt>
      <form class="flex flex-wrap items-end gap-3 rounded-lg border border-subtle bg-surface px-5 py-4" @submit.prevent="createInvite">
        <p class="m-0 w-full text-tertiary">// a one-time link valid for 7 days. the person picks their own login and password, then adds their own github accounts and claude subscription.</p>
        <label class="min-w-48 flex-1"><span class="label">who is it for (only you see this)</span><input v-model="newInvite.note" class="field" placeholder="alice, backend team" maxlength="120"></label>
        <label><span class="label">role</span><select v-model="newInvite.role" class="field w-auto"><option value="member">member</option><option value="admin">admin</option></select></label>
        <TBtn type="submit" tone="primary">create link</TBtn>
        <div v-if="link" class="grid w-full gap-1">
          <span class="text-warn">// shown once — copy it now and send it privately.</span>
          <div class="flex flex-wrap items-center gap-2"><code class="break-all rounded-sm bg-base px-2 py-1 text-bright">{{ link }}</code><TBtn @click="copy">copy</TBtn></div>
        </div>
      </form>
      <div v-if="invites.length" class="grid gap-0.5 rounded-lg border border-subtle bg-surface py-2 text-[13px]">
        <div v-for="i in invites" :key="i.id" class="flex flex-wrap items-center gap-3 px-4 py-px">
          <span class="text-faint">{{ stamp(i.created_at) }}</span>
          <span class="text-secondary">{{ i.note || "—" }}</span>
          <span class="text-accent2">{{ i.role }}</span>
          <span class="text-tertiary">{{ inviteState(i) }}</span>
          <TBtn v-if="!i.used_at && i.expires_at > store.now" class="ml-auto" tone="danger" @click="revoke(i)">revoke</TBtn>
        </div>
      </div>
    </section>
  </div>
</template>
