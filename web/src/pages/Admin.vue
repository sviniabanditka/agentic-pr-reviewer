<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../api";
import { store } from "../store";
import { dur, rel, stamp } from "../format";
import TBtn from "../components/TBtn.vue";
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
    toast("Invite link copied");
  } catch {
    toast("Could not copy; select the link by hand", true);
  }
}
const setUser = (u: UserLoad, body: Record<string, unknown>, ok: string) => act(() => api.patch(`/admin/users/${u.id}`, body), ok);
const revoke = (i: Invite) => act(() => api.del(`/admin/invites/${i.id}`), "Invite revoked");
const inviteOpen = ref(false);
const inviteState = (i: Invite) => (i.used_at ? `joined as ${i.used_by ?? "?"}` : i.expires_at < store.now ? "expired" : `open until ${stamp(i.expires_at)}`);
</script>

<template>
  <div class="grid gap-9 px-10 pb-12 pt-[22px]">
    <section aria-labelledby="people" class="grid gap-3.5">
      <div>
        <div class="flex flex-wrap items-center gap-2.5">
          <h1 id="people" class="m-0 text-base font-semibold text-bright">People</h1>
          <span class="ml-1.5 text-[12.5px] text-tertiary">Queue: {{ queue.find((q) => q.status === "running")?.n ?? 0 }} running, {{ queue.find((q) => q.status === "queued")?.n ?? 0 }} waiting</span>
          <TBtn class="ml-auto" tone="primary" @click="(inviteOpen = !inviteOpen), (link = null)">+ Invite someone</TBtn>
        </div>
        <p class="hint mt-1">Who uses this instance and how much. Their repositories, pull requests and findings are never shown here.</p>
      </div>
      <form v-if="inviteOpen" class="card grid gap-3 px-[18px] py-4" @submit.prevent="createInvite">
        <p class="hint">A one-time link, valid 7 days. The person picks a login and password, then adds their own GitHub accounts and Claude subscription.</p>
        <div class="flex flex-wrap items-end gap-2.5">
          <label class="min-w-48 flex-1"><span class="label">Who it is for (only you see this)</span><input v-model="newInvite.note" class="field bg-base" placeholder="alice, backend team" maxlength="120"></label>
          <label><span class="label">Role</span><select v-model="newInvite.role" class="field w-auto bg-base"><option value="member">Member</option><option value="admin">Admin</option></select></label>
          <TBtn type="submit" tone="primary">Create link</TBtn>
        </div>
        <div v-if="link" class="grid gap-1.5">
          <span class="text-[13px] text-warn">Shown once — copy it now and send it privately.</span>
          <div class="flex flex-wrap items-center gap-2"><code class="min-w-0 flex-1 break-all rounded-lg border border-strong bg-base px-3 py-2 text-[12.5px] text-bright">{{ link }}</code><TBtn tone="primary" @click="copy">Copy link</TBtn></div>
        </div>
      </form>
      <div class="panel overflow-x-auto">
        <table class="w-full min-w-[860px] border-collapse text-left text-[13.5px]">
          <thead class="bg-[#1a1b20] text-xs text-tertiary">
            <tr><th class="px-4 py-2.5 font-normal">Person</th><th class="px-3 py-2.5 font-normal">Last seen</th><th class="px-3 py-2.5 font-normal">Accounts · subs · targets</th>
              <th class="px-3 py-2.5 font-normal">Reviews 24 h / 7 d</th><th class="px-3 py-2.5 font-normal">Failed</th><th class="px-3 py-2.5 font-normal">Tokens 7 d</th>
              <th class="px-3 py-2.5 font-normal">Model time</th><th class="px-3 py-2.5 font-normal">Now</th><th class="px-4 py-2.5" /></tr>
          </thead>
          <tbody>
            <tr v-for="u in users" :key="u.id" class="border-t border-subtle" :class="u.disabled ? 'opacity-55' : ''">
              <td class="px-4 py-3"><span class="font-medium text-bright">{{ u.login }}</span>
                <span class="chip ml-1.5" :class="u.role === 'admin' ? 'bg-accent-bg text-[#dcd4ff]' : ''">{{ u.role }}</span>
                <span v-if="u.totp_enabled" class="ml-1.5 text-[11.5px] text-ok">2FA</span><span v-if="u.disabled" class="ml-1.5 text-[11.5px] text-danger">disabled</span></td>
              <td class="px-3 py-3 text-secondary">{{ u.last_seen_at ? rel(u.last_seen_at, store.now) : "never" }}</td>
              <td class="px-3 py-3 text-secondary">{{ u.accounts }} · {{ u.credentials }} · {{ u.targets }}</td>
              <td class="px-3 py-3">{{ u.reviews_24h }} / {{ u.reviews_7d }}</td>
              <td class="px-3 py-3" :class="u.errors_7d ? 'text-warn' : 'text-secondary'">{{ u.errors_7d }}</td>
              <td class="px-3 py-3 text-secondary">{{ u.tokens_7d.toLocaleString("en") }}</td>
              <td class="px-3 py-3 text-secondary">{{ dur(u.busy_ms_7d) || "0s" }}</td>
              <td class="px-3 py-3" :class="u.active ? 'text-accent2' : 'text-tertiary'">{{ u.active ? `${u.active} in queue` : "idle" }}</td>
              <td class="whitespace-nowrap px-4 py-3 text-right">
                <span v-if="u.id !== store.user?.id" class="inline-flex gap-1.5">
                  <TBtn v-if="u.totp_enabled" size="sm" tone="ghost" :confirm="`Turn off 2FA for ${u.login}?`" @click="setUser(u, { resetTotp: true }, 'Two-factor reset')">Reset 2FA</TBtn>
                  <TBtn size="sm" tone="ghost" :confirm="u.role === 'admin' ? 'Make member?' : 'Make admin?'" @click="setUser(u, { role: u.role === 'admin' ? 'member' : 'admin' }, 'Role changed')">{{ u.role === "admin" ? "Make member" : "Make admin" }}</TBtn>
                  <TBtn v-if="!u.disabled" size="sm" tone="danger" :confirm="`Disable ${u.login}?`" @click="setUser(u, { disabled: true }, 'Disabled')">Disable</TBtn>
                  <TBtn v-else size="sm" @click="setUser(u, { disabled: false }, 'Enabled')">Enable</TBtn>
                </span>
                <span v-else class="text-xs text-faint">you</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="invites.length" aria-labelledby="invites" class="grid gap-3">
      <h2 id="invites" class="m-0 text-[15px] font-semibold text-bright">Invites</h2>
      <div class="panel overflow-hidden">
        <div v-for="i in invites" :key="i.id" class="flex flex-wrap items-center gap-3 border-t border-subtle px-4 py-3 text-[13.5px] first:border-t-0">
          <span class="text-xs text-tertiary">{{ stamp(i.created_at) }}</span>
          <span class="font-medium text-bright">{{ i.note || "—" }}</span><span class="chip">{{ i.role }}</span>
          <span class="text-[12.5px] text-tertiary">{{ inviteState(i) }}</span>
          <TBtn v-if="!i.used_at && i.expires_at > store.now" class="ml-auto" size="sm" tone="danger" @click="revoke(i)">Revoke</TBtn>
        </div>
      </div>
    </section>
  </div>
</template>
