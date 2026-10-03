<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { api } from "../api";
import { accountOf, refreshState, store } from "../store";
import type { Target, TargetFilters, TargetParams } from "../types";
import Rel from "../components/Rel.vue";
import TBtn from "../components/TBtn.vue";
import TPrompt from "../components/TPrompt.vue";
import { toast } from "../components/toast";

const PRESETS: { label: string; query: string; role: TargetParams["role"] }[] = [
  { label: "review requested from me", query: "review-requested:@me", role: "review_requested" },
  { label: "my pull requests", query: "author:@me", role: "author" },
  { label: "mentioning me", query: "mentions:@me", role: "watching" },
  { label: "involving me", query: "involves:@me", role: "watching" },
];

interface Draft {
  id: string | null; accountId: string; name: string; type: Target["type"]; query: string; repo: string; number: string;
  role: NonNullable<TargetParams["role"]>; drafts: boolean; bots: boolean; owners: string; labelsInclude: string; labelsExclude: string;
  authorsInclude: string; authorsExclude: string; maxChangedFiles: string; automation: Target["automation"]; model: string; profileId: string; pollSec: number; enabled: boolean;
}
const editing = ref<Draft | null>(null);
const preview = ref<{ repo: string; number: number; title: string; author: string; draft: boolean; url: string }[] | null>(null);
const previewing = ref(false);
const saving = ref(false);
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

function blank(): Draft {
  return { id: null, accountId: store.accounts[0]?.id ?? "", name: "", type: "search", query: "review-requested:@me", repo: "", number: "", role: "review_requested",
    drafts: false, bots: false, owners: "", labelsInclude: "", labelsExclude: "", authorsInclude: "", authorsExclude: "", maxChangedFiles: "",
    automation: "manual", model: "", profileId: "", pollSec: 60, enabled: true };
}
function edit(t: Target) {
  const f = t.filters;
  editing.value = { id: t.id, accountId: t.accountId, name: t.name, type: t.type, query: t.params.query ?? "", repo: t.params.repo ?? "",
    number: t.params.number ? String(t.params.number) : "", role: t.params.role ?? "watching", drafts: !!f.drafts, bots: !!f.bots,
    owners: (f.owners ?? []).join(", "), labelsInclude: (f.labelsInclude ?? []).join(", "), labelsExclude: (f.labelsExclude ?? []).join(", "),
    authorsInclude: (f.authorsInclude ?? []).join(", "), authorsExclude: (f.authorsExclude ?? []).join(", "), maxChangedFiles: f.maxChangedFiles ? String(f.maxChangedFiles) : "",
    automation: t.automation, model: t.model ?? "", profileId: t.profileId ?? "", pollSec: t.pollSec, enabled: t.enabled };
  preview.value = null;
}
function payload(d: Draft) {
  const params: TargetParams = d.type === "search" ? { query: d.query, role: d.role } : d.type === "repo" ? { repo: d.repo.trim(), role: d.role } : { repo: d.repo.trim(), number: Number(d.number), role: d.role };
  const filters: TargetFilters = { drafts: d.drafts, bots: d.bots };
  if (d.owners) filters.owners = list(d.owners);
  if (d.labelsInclude) filters.labelsInclude = list(d.labelsInclude);
  if (d.labelsExclude) filters.labelsExclude = list(d.labelsExclude);
  if (d.authorsInclude) filters.authorsInclude = list(d.authorsInclude);
  if (d.authorsExclude) filters.authorsExclude = list(d.authorsExclude);
  if (d.maxChangedFiles) filters.maxChangedFiles = Number(d.maxChangedFiles);
  return { accountId: d.accountId, name: d.name || (d.type === "search" ? d.query : d.repo), type: d.type, params, filters, automation: d.automation, model: d.model || null, profileId: d.profileId || null, pollSec: d.pollSec, enabled: d.enabled };
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
    if (d.id) await api.patch(`/targets/${d.id}`, payload(d));
    else await api.post("/targets", payload(d));
    toast(d.id ? "target saved" : "target added; fetching its pull requests");
    editing.value = null;
    await refreshState();
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
    await refreshState();
  } catch (e) {
    toast((e as Error).message, true);
  } finally {
    busy[t.id] = false;
  }
}
function describe(t: Target) {
  if (t.type === "search") return `is:pr is:open ${t.params.query}`;
  if (t.type === "repo") return `all open prs in ${t.params.repo}`;
  return `${t.params.repo}#${t.params.number}`;
}
const autoPostWarning = computed(() => editing.value?.automation === "auto-review");
</script>

<template>
  <div class="grid gap-5">
    <div class="flex flex-wrap items-center gap-3">
      <TPrompt :level="1">targets</TPrompt>
      <span class="text-tertiary">// what to watch. targets only list pull requests; reviewing and posting stay manual unless you opt in.</span>
      <TBtn class="ml-auto" tone="primary" :disabled="!store.accounts.length" @click="(editing = blank()), (preview = null)">new target</TBtn>
    </div>
    <div v-if="!store.accounts.length" class="text-warn">! add a github account on <RouterLink to="/accounts" class="text-accent hover:underline">accounts</RouterLink> first</div>

    <form v-if="editing" class="grid gap-4 rounded-lg border border-accent/40 bg-surface px-5 py-5" @submit.prevent="save">
      <TPrompt sigil="$">{{ editing.id ? "edit target" : "new target" }}</TPrompt>
      <div class="grid gap-4 md:grid-cols-3">
        <label><span class="label">account</span><select v-model="editing.accountId" class="field"><option v-for="a in store.accounts" :key="a.id" :value="a.id">{{ a.label }} (@{{ a.login }})</option></select></label>
        <label><span class="label">type</span><select v-model="editing.type" class="field"><option value="search">github search</option><option value="repo">repository</option><option value="pr">single pull request</option></select></label>
        <label><span class="label">name</span><input v-model="editing.name" class="field" placeholder="shown in the inbox"></label>
      </div>
      <div v-if="editing.type === 'search'" class="grid gap-2">
        <label><span class="label">query (added after <span class="text-accent2">is:pr is:open archived:false</span>)</span>
          <input v-model="editing.query" class="field" placeholder="review-requested:@me org:acme -label:wip" required></label>
        <div class="flex flex-wrap gap-2 text-[13px]">
          <button v-for="p in PRESETS" :key="p.query" type="button" class="rounded-sm border border-subtle px-2 py-0.5 text-tertiary hover:text-bright"
            @click="(editing.query = p.query), (editing.role = p.role ?? 'watching'), editing.name || (editing.name = p.label)">{{ p.label }}</button>
        </div>
      </div>
      <div v-else class="grid gap-4 md:grid-cols-3">
        <label><span class="label">repository</span><input v-model="editing.repo" class="field" placeholder="owner/name" required></label>
        <label v-if="editing.type === 'pr'"><span class="label">number</span><input v-model="editing.number" class="field" inputmode="numeric" required></label>
      </div>
      <div class="grid gap-4 md:grid-cols-3">
        <label><span class="label">role of found prs</span><select v-model="editing.role" class="field"><option value="review_requested">review requested</option><option value="author">mine</option><option value="watching">watching</option></select></label>
        <label><span class="label">repo owners (your own prs only; comma-separated)</span><input v-model="editing.owners" class="field" placeholder="any"></label>
        <label><span class="label">max changed files</span><input v-model="editing.maxChangedFiles" class="field" inputmode="numeric" placeholder="no limit"></label>
        <label><span class="label">labels: any of</span><input v-model="editing.labelsInclude" class="field" placeholder="api, backend"></label>
        <label><span class="label">labels: none of</span><input v-model="editing.labelsExclude" class="field" placeholder="wip"></label>
        <label><span class="label">authors: only / except (comma-separated)</span>
          <span class="flex gap-2"><input v-model="editing.authorsInclude" class="field" placeholder="only"><input v-model="editing.authorsExclude" class="field" placeholder="except"></span></label>
      </div>
      <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
        <label class="flex items-center gap-2"><input v-model="editing.drafts" type="checkbox" class="accent-[#9ece6a]"> include drafts</label>
        <label class="flex items-center gap-2"><input v-model="editing.bots" type="checkbox" class="accent-[#9ece6a]"> include bot prs</label>
        <label class="flex items-center gap-2"><input v-model="editing.enabled" type="checkbox" class="accent-[#9ece6a]"> enabled</label>
        <label class="flex items-center gap-2">poll every <input v-model.number="editing.pollSec" type="number" min="30" class="field w-24 py-1"> s</label>
      </div>
      <div class="grid gap-4 md:grid-cols-3">
        <label><span class="label">automation</span><select v-model="editing.automation" class="field"><option value="manual">manual — list only</option><option value="auto-review">auto-review new commits (results stay private)</option></select></label>
        <label><span class="label">model for automatic reviews</span><select v-model="editing.model" class="field"><option value="">account default</option><option v-for="m in store.models" :key="m" :value="m">{{ m }}</option></select></label>
        <label><span class="label">profile for automatic reviews</span><select v-model="editing.profileId" class="field"><option value="">account default</option><option v-for="p in store.profiles" :key="p.id" :value="p.id">{{ p.name.toLowerCase() }}</option></select></label>
      </div>
      <p v-if="autoPostWarning" class="m-0 text-warn">// auto-review spends your claude quota on every new push it finds. nothing is posted without your press.</p>
      <div class="flex flex-wrap items-center gap-1">
        <TBtn :busy="previewing" @click="runPreview">preview</TBtn>
        <TBtn type="submit" tone="primary" :busy="saving">save</TBtn>
        <TBtn @click="editing = null">cancel</TBtn>
      </div>
      <div v-if="preview" class="grid gap-1 rounded-md bg-base px-3 py-2">
        <div class="text-tertiary">// {{ preview.length }} match{{ preview.length === 1 ? "" : "es" }} right now{{ preview.length === 20 ? " (first 20)" : "" }}</div>
        <a v-for="p in preview" :key="`${p.repo}#${p.number}`" :href="p.url" target="_blank" rel="noopener" class="truncate hover:text-bright">
          <span class="text-accent2">{{ p.repo }} #{{ p.number }}</span> {{ p.title }} <span class="text-faint">@{{ p.author }}{{ p.draft ? " draft" : "" }}</span></a>
      </div>
    </form>

    <ul class="m-0 grid gap-2 p-0">
      <li v-for="t in store.targets" :key="t.id" class="grid list-none gap-1 rounded-lg border border-subtle bg-surface px-4 py-3" :class="t.enabled ? '' : 'opacity-60'">
        <div class="flex flex-wrap items-center gap-3">
          <span class="font-medium text-bright">{{ t.name }}</span>
          <span class="text-tertiary">as {{ accountOf(t.accountId)?.label }}</span>
          <span v-if="t.automation === 'auto-review'" class="text-warn">auto-review</span>
          <span v-if="!t.enabled" class="text-faint">disabled</span>
          <span class="ml-auto text-accent2">{{ t.openItems }} open</span>
        </div>
        <div class="truncate text-tertiary"><span class="text-ok">$</span> {{ describe(t) }}</div>
        <div class="flex flex-wrap items-center gap-x-4 text-[13px] text-tertiary">
          <span>polled <Rel :ts="t.lastPolledAt" /></span><span>every {{ t.pollSec }}s</span>
          <span v-if="t.lastError" class="text-danger">! {{ t.lastError }}</span>
          <span class="ml-auto flex gap-1">
            <TBtn :busy="busy[t.id]" @click="act(t, 'poll')">poll now</TBtn>
            <TBtn @click="edit(t)">edit</TBtn>
            <TBtn @click="act(t, 'toggle')">{{ t.enabled ? "disable" : "enable" }}</TBtn>
            <TBtn tone="danger" confirm="delete?" @click="act(t, 'delete')">delete</TBtn>
          </span>
        </div>
      </li>
      <li v-if="!store.targets.length && store.accounts.length" class="list-none text-tertiary">// no targets. press [ new target ] — "review requested from me" is a good first one.</li>
    </ul>
  </div>
</template>
