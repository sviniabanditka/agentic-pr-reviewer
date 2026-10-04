<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { api } from "../api";
import { accountOf, refreshState, store } from "../store";
import type { Target, TargetFilters, TargetParams } from "../types";
import Rel from "../components/Rel.vue";
import TBtn from "../components/TBtn.vue";
import { toast } from "../components/toast";

const PRESETS: { label: string; query: string; role: TargetParams["role"] }[] = [
  { label: "Review requested from me", query: "review-requested:@me", role: "review_requested" },
  { label: "My pull requests", query: "author:@me", role: "author" },
  { label: "Mentioning me", query: "mentions:@me", role: "watching" },
  { label: "Involving me", query: "involves:@me", role: "watching" },
];
const POLL = [[30, "30 seconds"], [60, "1 minute"], [300, "5 minutes"], [900, "15 minutes"], [3600, "1 hour"]] as const;

interface Draft {
  id: string | null; accountId: string; name: string; type: Target["type"]; query: string; repo: string; number: string;
  role: NonNullable<TargetParams["role"]>; drafts: boolean; bots: boolean; owners: string; labelsInclude: string; labelsExclude: string;
  authorsInclude: string; authorsExclude: string; maxChangedFiles: string; automation: Target["automation"]; model: string; profileId: string; pollSec: number; enabled: boolean;
  confirmLogin: string; wasAutoPost: boolean;
}
const editing = ref<Draft | null>(null);
const preview = ref<{ repo: string; number: number; title: string; author: string; draft: boolean; url: string }[] | null>(null);
const previewing = ref(false);
const saving = ref(false);
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

function blank(): Draft {
  return { id: null, accountId: store.accounts[0]?.id ?? "", name: "", type: "search", query: "review-requested:@me", repo: "", number: "", role: "review_requested",
    drafts: false, bots: false, owners: "", labelsInclude: "", labelsExclude: "", authorsInclude: "", authorsExclude: "", maxChangedFiles: "",
    automation: "manual", model: "", profileId: "", pollSec: 60, enabled: true, confirmLogin: "", wasAutoPost: false };
}
function edit(t: Target) {
  const f = t.filters;
  editing.value = { id: t.id, accountId: t.accountId, name: t.name, type: t.type, query: t.params.query ?? "", repo: t.params.repo ?? "",
    number: t.params.number ? String(t.params.number) : "", role: t.params.role ?? "watching", drafts: !!f.drafts, bots: !!f.bots,
    owners: (f.owners ?? []).join(", "), labelsInclude: (f.labelsInclude ?? []).join(", "), labelsExclude: (f.labelsExclude ?? []).join(", "),
    authorsInclude: (f.authorsInclude ?? []).join(", "), authorsExclude: (f.authorsExclude ?? []).join(", "), maxChangedFiles: f.maxChangedFiles ? String(f.maxChangedFiles) : "",
    automation: t.automation, model: t.model ?? "", profileId: t.profileId ?? "", pollSec: t.pollSec, enabled: t.enabled, confirmLogin: "", wasAutoPost: t.automation === "auto-post" };
  preview.value = null;
}
// Open the first target on arrival, so the page is never an empty right half.
watch(() => store.targets.length, () => { if (!editing.value && store.targets[0]) edit(store.targets[0]); }, { immediate: true });

function payload(d: Draft) {
  const params: TargetParams = d.type === "search" ? { query: d.query, role: d.role } : d.type === "repo" ? { repo: d.repo.trim(), role: d.role } : { repo: d.repo.trim(), number: Number(d.number), role: d.role };
  const filters: TargetFilters = { drafts: d.drafts, bots: d.bots };
  if (d.owners) filters.owners = list(d.owners);
  if (d.labelsInclude) filters.labelsInclude = list(d.labelsInclude);
  if (d.labelsExclude) filters.labelsExclude = list(d.labelsExclude);
  if (d.authorsInclude) filters.authorsInclude = list(d.authorsInclude);
  if (d.authorsExclude) filters.authorsExclude = list(d.authorsExclude);
  if (d.maxChangedFiles) filters.maxChangedFiles = Number(d.maxChangedFiles);
  return { accountId: d.accountId, name: d.name || (d.type === "search" ? d.query : d.repo), type: d.type, params, filters, automation: d.automation, model: d.model || null, profileId: d.profileId || null, pollSec: d.pollSec, enabled: d.enabled,
    ...(d.automation === "auto-post" && d.confirmLogin ? { confirmLogin: d.confirmLogin } : {}) };
}
async function runPreview() {
  previewing.value = true;
  try {
    preview.value = (await api.post<{ items: NonNullable<typeof preview.value> }>("/targets/preview", payload(editing.value!))).items;
  } catch (e) {
    toast((e as Error).message, true);
  } finally {
    previewing.value = false;
  }
}
async function save() {
  saving.value = true;
  try {
    const d = editing.value!;
    const r = d.id ? await api.patch<{ target: Target }>(`/targets/${d.id}`, payload(d)) : await api.post<{ target: Target }>("/targets", payload(d));
    toast(d.id ? "Target saved" : "Target added; fetching its pull requests");
    await refreshState();
    const fresh = store.targets.find((t) => t.id === r.target.id);
    if (fresh) edit(fresh);
  } catch (e) {
    toast((e as Error).message, true);
  } finally {
    saving.value = false;
  }
}
const busy = reactive<Record<string, boolean>>({});
async function act(t: Target, what: "poll" | "delete" | "toggle") {
  busy[t.id] = true;
  try {
    if (what === "poll") await api.post(`/targets/${t.id}/poll`);
    if (what === "delete") await api.del(`/targets/${t.id}`);
    if (what === "toggle") await api.patch(`/targets/${t.id}`, { enabled: !t.enabled });
    if (what === "delete") editing.value = null;
    await refreshState();
    if (what === "poll") toast("Checked");
  } catch (e) {
    toast((e as Error).message, true);
  } finally {
    busy[t.id] = false;
  }
}
const pollAll = async () => (await api.post("/poll").catch((e) => toast((e as Error).message, true)), toast("Checking every target"));
function describe(t: Target) {
  if (t.type === "search") return t.params.query ?? "";
  if (t.type === "repo") return `repo ${t.params.repo}`;
  return `${t.params.repo}#${t.params.number}`;
}
const AUTO = { manual: ["List only", "#b9b9c2", "#22232a"], "auto-review": ["Auto-review", "#b4a6ff", "#221f30"], "auto-post": ["Auto-post", "#ff9c86", "#2c1d1e"] } as const;
const needsConfirm = computed(() => editing.value?.automation === "auto-post" && !editing.value.wasAutoPost);
const draftLogin = computed(() => accountOf(editing.value?.accountId)?.login ?? "");
const current = computed(() => store.targets.find((t) => t.id === editing.value?.id));
</script>

<template>
  <div class="flex min-h-screen flex-wrap">
    <section aria-label="Targets" class="min-w-0 max-w-[560px] flex-[1_1_440px] border-r border-subtle">
      <div class="flex items-center gap-2 px-[18px] pb-1.5 pt-[18px]">
        <h1 class="m-0 text-base font-semibold text-bright">Targets</h1>
        <span class="text-xs text-tertiary">{{ store.targets.length }}</span>
        <TBtn class="ml-auto" size="sm" :disabled="!store.targets.length" @click="pollAll">Check all</TBtn>
        <TBtn tone="primary" size="sm" :disabled="!store.accounts.length" @click="(editing = blank()), (preview = null)">+ New target</TBtn>
      </div>
      <p class="hint mx-[18px] mb-3.5">Rules that find pull requests. They list them in the inbox; reviews start only where you allow it.</p>
      <p v-if="!store.accounts.length" class="mx-[18px] text-[13px] text-warn">Add a GitHub account on <RouterLink to="/accounts" class="link">Accounts</RouterLink> first.</p>
      <div v-for="t in store.targets" :key="t.id" class="mx-2 mb-1 cursor-pointer rounded-[10px] px-3.5 py-3" :class="[editing?.id === t.id ? 'bg-hover' : 'hover:bg-[#1b1c21]', t.enabled ? '' : 'opacity-55']" @click="edit(t)">
        <div class="flex items-center gap-2">
          <span class="min-w-0 flex-1 truncate font-medium text-bright">{{ t.name }}</span>
          <span class="chip" :style="{ color: AUTO[t.automation][1], background: AUTO[t.automation][2] }">{{ AUTO[t.automation][0] }}</span>
          <button role="switch" :aria-checked="t.enabled" :aria-label="t.enabled ? 'Turn off' : 'Turn on'" class="flex h-[18px] w-8 shrink-0 cursor-pointer rounded-full p-0.5"
            :class="t.enabled ? 'justify-end bg-accent' : 'justify-start bg-[#33343c]'" @click.stop="act(t, 'toggle')"><span class="size-3.5 rounded-full bg-base" /></button>
        </div>
        <div class="mt-1 truncate font-mono text-xs text-secondary">{{ describe(t) }}</div>
        <div class="mt-1 flex flex-wrap gap-2 text-xs text-tertiary">
          <span>as {{ accountOf(t.accountId)?.label }}</span><span class="text-faint">·</span><span>{{ t.openItems }} open</span><span class="text-faint">·</span>
          <span v-if="!t.enabled">paused</span><span v-else>checked <Rel :ts="t.lastPolledAt" /></span>
        </div>
        <div v-if="t.lastError" class="mt-1 truncate text-xs text-danger">{{ t.lastError }}</div>
      </div>
      <p v-if="!store.targets.length && store.accounts.length" class="hint mx-[18px]">No targets yet. “Review requested from me” is a good first one.</p>
    </section>

    <main class="min-w-0 flex-[999_1_560px]">
      <form v-if="editing" @submit.prevent="save">
        <div class="flex flex-wrap items-center gap-2 border-b border-subtle px-8 py-3.5">
          <span class="text-[13px] text-tertiary">{{ editing.id ? "Edit target" : "New target" }}</span>
          <span class="ml-auto" />
          <TBtn v-if="current" tone="danger" confirm="Delete this target?" @click="act(current, 'delete')">Delete</TBtn>
          <TBtn v-if="current" :busy="busy[current.id]" @click="act(current, 'poll')">Check now</TBtn>
          <TBtn :busy="previewing" @click="runPreview">Preview matches</TBtn>
          <TBtn type="submit" tone="primary" :busy="saving">Save</TBtn>
        </div>
        <div class="grid max-w-[780px] gap-[22px] px-8 py-6">
          <div class="grid gap-3.5 sm:grid-cols-2">
            <label><span class="label">Name</span><input v-model="editing.name" class="field" placeholder="Shown in the inbox"></label>
            <label><span class="label">GitHub account</span><select v-model="editing.accountId" class="field"><option v-for="a in store.accounts" :key="a.id" :value="a.id">{{ a.label }} · @{{ a.login }}</option></select></label>
          </div>
          <div class="grid gap-2">
            <span class="label mb-0">Finds</span>
            <div class="seg justify-self-start" role="radiogroup">
              <button type="button" role="radio" :aria-pressed="editing.type === 'search'" :aria-checked="editing.type === 'search'" @click="editing.type = 'search'">GitHub search</button>
              <button type="button" role="radio" :aria-pressed="editing.type === 'repo'" :aria-checked="editing.type === 'repo'" @click="editing.type = 'repo'">One repository</button>
              <button type="button" role="radio" :aria-pressed="editing.type === 'pr'" :aria-checked="editing.type === 'pr'" @click="editing.type = 'pr'">One pull request</button>
            </div>
            <template v-if="editing.type === 'search'">
              <input v-model="editing.query" class="field font-mono text-[13px]" placeholder="review-requested:@me org:acme -label:wip" aria-label="Search query" required>
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="mr-1 text-xs text-tertiary">Presets</span>
                <button v-for="p in PRESETS" :key="p.query" type="button" class="pill border-strong py-0.5 text-xs"
                  @click="(editing.query = p.query), (editing.role = p.role ?? 'watching'), editing.name || (editing.name = p.label)">{{ p.label }}</button>
              </div>
              <span class="text-xs text-tertiary">Added after <span class="font-mono">is:pr is:open archived:false</span>.</span>
            </template>
            <div v-else class="grid gap-3 sm:grid-cols-[2fr_1fr]">
              <input v-model="editing.repo" class="field" placeholder="owner/name" aria-label="Repository" required>
              <input v-if="editing.type === 'pr'" v-model="editing.number" class="field" inputmode="numeric" placeholder="Number" aria-label="Pull request number" required>
            </div>
            <label class="mt-1 max-w-xs"><span class="label">Your role in what it finds</span><select v-model="editing.role" class="field"><option value="review_requested">Review requested</option><option value="author">Mine</option><option value="watching">Watching</option></select></label>
          </div>
          <div class="panel grid gap-3 px-[18px] py-4">
            <span class="label mb-0">Filters</span>
            <div class="flex flex-wrap gap-5">
              <label class="flex items-center gap-2"><input v-model="editing.drafts" type="checkbox" class="accent-accent"> Include drafts</label>
              <label class="flex items-center gap-2"><input v-model="editing.bots" type="checkbox" class="accent-accent"> Include bots</label>
              <label class="flex items-center gap-2">At most <input v-model="editing.maxChangedFiles" class="field w-16 py-1" inputmode="numeric" placeholder="any" aria-label="Max changed files"> changed files</label>
            </div>
            <div class="grid gap-2.5 sm:grid-cols-2">
              <label><span class="label">Only labels</span><input v-model="editing.labelsInclude" class="field" placeholder="backend, api"></label>
              <label><span class="label">Skip labels</span><input v-model="editing.labelsExclude" class="field" placeholder="wip"></label>
              <label><span class="label">Only authors</span><input v-model="editing.authorsInclude" class="field" placeholder="anyone"></label>
              <label><span class="label">Skip authors</span><input v-model="editing.authorsExclude" class="field" placeholder="dependabot"></label>
              <label class="sm:col-span-2"><span class="label">Repository owners (applies to your own pull requests)</span><input v-model="editing.owners" class="field" placeholder="any"></label>
            </div>
          </div>
          <div class="grid gap-2">
            <span class="label mb-0">When a new commit appears</span>
            <div class="grid gap-2 sm:grid-cols-3">
              <label v-for="[v, title, sub, danger] in ([['manual', 'List only', 'You start reviews', false], ['auto-review', 'Review it', 'Result stays private', false], ['auto-post', 'Review and post', 'Writes to the PR unasked', true]] as const)" :key="v"
                class="grid cursor-pointer gap-0.5 rounded-[10px] border px-3.5 py-3" :class="editing.automation === v ? 'border-[#4a4170] bg-[#1d1b27]' : 'border-subtle hover:bg-[#1b1c21]'">
                <span class="flex items-center gap-2"><input v-model="editing.automation" type="radio" name="automation" :value="v" class="accent-accent"> {{ title }}</span>
                <span class="text-xs" :class="danger ? 'text-danger' : 'text-tertiary'">{{ sub }}</span>
              </label>
            </div>
            <p v-if="editing.automation === 'auto-review'" class="hint">Each new push spends your Claude quota. Nothing is posted until you press Post.</p>
            <div v-if="editing.automation === 'auto-post'" class="grid gap-2 rounded-xl bg-danger-bg px-4 py-3 text-[13px] text-danger">
              Auto-post writes to pull requests as @{{ draftLogin }} without asking: one comment per pull request, edited on each push, never approve or request changes. Every post is in the audit log.
              <label v-if="needsConfirm"><span class="label text-danger/80">Type {{ draftLogin }} to confirm</span><input v-model="editing.confirmLogin" class="field max-w-64" :placeholder="draftLogin" autocomplete="off"></label>
            </div>
          </div>
          <div class="grid gap-3.5 sm:grid-cols-3">
            <label><span class="label">Profile</span><select v-model="editing.profileId" class="field"><option value="">Account default</option><option v-for="p in store.profiles" :key="p.id" :value="p.id">{{ p.name }}</option></select></label>
            <label><span class="label">Model</span><select v-model="editing.model" class="field"><option value="">Account default</option><option v-for="m in store.models" :key="m" :value="m">{{ m }}</option></select></label>
            <label><span class="label">Check every</span><select v-model.number="editing.pollSec" class="field"><option v-for="[s, l] in POLL" :key="s" :value="s">{{ l }}</option><option v-if="!POLL.some(([s]) => s === editing!.pollSec)" :value="editing.pollSec">{{ editing.pollSec }} seconds</option></select></label>
          </div>
          <div v-if="preview" class="card grid gap-1.5 px-4 py-3.5">
            <span class="text-[12.5px] text-tertiary">Matches right now · {{ preview.length }}{{ preview.length === 20 ? " (first 20)" : "" }}</span>
            <a v-for="p in preview" :key="`${p.repo}#${p.number}`" :href="p.url" target="_blank" rel="noopener" class="truncate text-[13px] hover:text-bright">
              {{ p.repo.split("/")[1] }} #{{ p.number }} <span class="text-secondary">{{ p.title }}</span> <span class="text-faint">@{{ p.author }}{{ p.draft ? " · draft" : "" }}</span></a>
            <span v-if="!preview.length" class="hint">Nothing matches right now.</span>
          </div>
        </div>
      </form>
      <div v-else class="grid h-full place-items-center p-10 text-tertiary">Pick a target or create one.</div>
    </main>
  </div>
</template>
