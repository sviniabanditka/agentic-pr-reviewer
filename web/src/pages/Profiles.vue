<script setup lang="ts">
import { computed, ref } from "vue";
import { api } from "../api";
import { refreshState, store } from "../store";
import type { Profile, ProfileOptions } from "../types";
import TBtn from "../components/TBtn.vue";
import TPrompt from "../components/TPrompt.vue";
import { toast } from "../components/toast";

interface Draft {
  id: string | null; name: string; mode: string; model: string; confirmation: "never" | "blocking";
  categories: string[]; blocking: string[]; custom: { id: string; description: string }[];
  budgetTokens: number; maxChunks: number; intent: "pr-body" | "none"; instructions: string;
}
const editing = ref<Draft | null>(null);
const saving = ref(false);
const preview = ref<{ system: string; user: string; chunks: number; tokens: number } | null>(null);
const previewItem = ref("");
const previewing = ref(false);

const mode = computed(() => store.modes.find((m) => m.id === editing.value?.mode));
const modeCategories = computed(() => {
  const d = editing.value;
  if (!d) return [];
  return d.mode === "custom" ? [...d.custom.map((c) => c.id.toUpperCase()).filter(Boolean), "OTHER"] : mode.value?.categories ?? [];
});
const openItems = computed(() => [...store.items.values()].filter((i) => i.state === "open"));

function toDraft(p: Profile | null, modeId = "diff-triage"): Draft {
  const o: ProfileOptions = p?.options ?? {};
  const m = store.modes.find((x) => x.id === (p?.mode ?? modeId))!;
  return {
    id: p?.id ?? null, name: p?.name ?? "", mode: p?.mode ?? modeId, model: o.model ?? "", confirmation: o.confirmation ?? (m.confirmation as "never" | "blocking"),
    categories: o.categories ?? p?.resolved.categories ?? [...m.categories], blocking: o.blocking ?? p?.resolved.blocking ?? [...m.blocking],
    custom: o.customCategories ? o.customCategories.map((c) => ({ ...c })) : [], budgetTokens: o.budgetTokens ?? 32000, maxChunks: o.maxChunks ?? 6,
    intent: o.intent ?? "pr-body", instructions: o.instructions ?? "",
  };
}
function onModeChange() {
  const d = editing.value!;
  const m = store.modes.find((x) => x.id === d.mode)!;
  d.categories = [...m.categories];
  d.blocking = [...m.blocking];
  d.confirmation = m.confirmation as "never" | "blocking";
  if (d.mode === "custom" && !d.custom.length) d.custom = [{ id: "", description: "" }];
}
function toggle(list: string[], id: string) {
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
  else list.push(id);
}
function options(d: Draft): ProfileOptions {
  const custom = d.custom.filter((c) => c.id.trim() && c.description.trim()).map((c) => ({ id: c.id.trim().toUpperCase(), description: c.description.trim() }));
  const cats = d.mode === "custom" ? [...custom.map((c) => c.id), "OTHER"] : d.categories;
  return {
    ...(d.model ? { model: d.model } : {}), confirmation: d.confirmation, categories: cats.filter((c) => d.mode === "custom" || d.categories.includes(c)),
    blocking: d.blocking.filter((b) => cats.includes(b)), budgetTokens: d.budgetTokens, maxChunks: d.maxChunks, intent: d.intent,
    ...(d.instructions.trim() ? { instructions: d.instructions } : {}), ...(d.mode === "custom" ? { customCategories: custom } : {}),
  };
}
async function save() {
  const d = editing.value!;
  saving.value = true;
  try {
    const body = { name: d.name.trim() || (mode.value?.label ?? "profile"), mode: d.mode, options: options(d) };
    if (d.id) await api.patch(`/profiles/${d.id}`, body);
    else await api.post("/profiles", body);
    toast("profile saved");
    editing.value = null;
    await refreshState();
  } catch (e) {
    toast((e as Error).message, true);
  } finally {
    saving.value = false;
  }
}
async function act(p: Profile, what: "default" | "delete") {
  try {
    if (what === "default") await api.post(`/profiles/${p.id}/default`);
    else await api.del(`/profiles/${p.id}`);
    await refreshState();
  } catch (e) {
    toast((e as Error).message, true);
  }
}
async function runPreview() {
  const d = editing.value!;
  if (!d.id) return toast("save the profile first, then preview", true);
  previewing.value = true;
  try {
    preview.value = await api.post(`/profiles/${d.id}/preview`, { itemId: previewItem.value });
  } catch (e) {
    toast((e as Error).message, true);
  } finally {
    previewing.value = false;
  }
}
const modeLabel = (id: string) => store.modes.find((m) => m.id === id)?.label ?? id;
</script>

<template>
  <div class="grid grid-cols-[minmax(0,1fr)] gap-5">
    <div class="flex flex-wrap items-center gap-3">
      <TPrompt :level="1">profiles</TPrompt>
      <span class="text-tertiary">// how to review: a mode, a model, which categories count and which hold a merge</span>
      <TBtn class="ml-auto" tone="primary" @click="(editing = toDraft(null)), (preview = null)">new profile</TBtn>
    </div>

    <form v-if="editing" class="grid grid-cols-[minmax(0,1fr)] gap-4 rounded-lg border border-accent/40 bg-surface px-5 py-5" @submit.prevent="save">
      <TPrompt sigil="$">{{ editing.id ? "edit profile" : "new profile" }}</TPrompt>
      <div class="grid gap-4 md:grid-cols-3">
        <label><span class="label">name</span><input v-model="editing.name" class="field" :placeholder="mode?.label"></label>
        <label><span class="label">mode</span><select v-model="editing.mode" class="field" @change="onModeChange"><option v-for="m in store.modes" :key="m.id" :value="m.id">{{ m.label }}</option></select></label>
        <label><span class="label">model</span><select v-model="editing.model" class="field"><option value="">account default</option><option v-for="m in store.models" :key="m" :value="m">{{ m }}</option></select></label>
      </div>
      <p class="m-0 text-tertiary">// {{ mode?.description }}</p>

      <template v-if="mode?.output === 'findings'">
        <div v-if="editing.mode !== 'custom'" class="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">
          <span class="label">categories — <span class="text-ok">[x]</span> report it, <span class="text-danger">blocking</span> it holds a merge</span>
          <div v-for="c in modeCategories" :key="c" class="flex min-w-0 items-center gap-3 rounded-sm px-2 py-1 hover:bg-hover">
            <button type="button" class="w-44 shrink-0 text-left" @click="toggle(editing.categories, c)">
              <span class="text-tertiary">[</span><span class="text-ok">{{ editing.categories.includes(c) ? "x" : " " }}</span><span class="text-tertiary">]</span> {{ c }}</button>
            <button type="button" class="w-24 shrink-0 text-left" :disabled="!editing.categories.includes(c)" :class="editing.blocking.includes(c) ? 'text-danger' : 'text-faint'" @click="toggle(editing.blocking, c)">
              {{ editing.blocking.includes(c) ? "blocking" : "note" }}</button>
            <span class="min-w-0 flex-1 truncate text-faint" :title="store.categoryText[c]">{{ store.categoryText[c] }}</span>
          </div>
        </div>
        <div v-else class="grid gap-2">
          <span class="label">your categories (OTHER is always added)</span>
          <div v-for="(c, i) in editing.custom" :key="i" class="grid gap-2 md:grid-cols-[180px_1fr_auto_auto] md:items-center">
            <input v-model="c.id" class="field" placeholder="PERF">
            <input v-model="c.description" class="field" placeholder="what the model should report under it">
            <button type="button" :class="editing.blocking.includes(c.id.toUpperCase()) ? 'text-danger' : 'text-faint'" @click="toggle(editing.blocking, c.id.toUpperCase())">{{ editing.blocking.includes(c.id.toUpperCase()) ? "blocking" : "note" }}</button>
            <TBtn tone="danger" @click="editing.custom.splice(i, 1)">remove</TBtn>
          </div>
          <div><TBtn @click="editing.custom.push({ id: '', description: '' })">add category</TBtn></div>
        </div>
        <div class="grid gap-4 md:grid-cols-4">
          <label><span class="label">confirmation</span><select v-model="editing.confirmation" class="field"><option value="blocking">second run for blocking findings</option><option value="never">one run decides</option></select></label>
          <label><span class="label">author's claim</span><select v-model="editing.intent" class="field"><option value="pr-body">send the pr description</option><option value="none">don't send it</option></select></label>
          <label><span class="label">tokens per part</span><input v-model.number="editing.budgetTokens" type="number" min="4000" max="150000" step="1000" class="field"></label>
          <label><span class="label">parts at most</span><input v-model.number="editing.maxChunks" type="number" min="1" max="20" class="field"></label>
        </div>
      </template>
      <label><span class="label">extra instructions (added to the system prompt)</span>
        <textarea v-model="editing.instructions" class="field min-h-24" placeholder="e.g. this codebase uses repository objects for every query; flag direct SQL." /></label>

      <div class="flex flex-wrap items-center gap-1">
        <TBtn type="submit" tone="primary" :busy="saving">save</TBtn>
        <TBtn @click="editing = null">cancel</TBtn>
        <span class="ml-4 text-tertiary">preview on</span>
        <select v-model="previewItem" class="field w-auto max-w-80 py-1" aria-label="pull request to preview on">
          <option value="">pick an open pull request</option>
          <option v-for="i in openItems" :key="i.id" :value="i.id">{{ i.repo.split("/")[1] }} #{{ i.number }} {{ i.title }}</option>
        </select>
        <TBtn :busy="previewing" :disabled="!previewItem || !editing.id" @click="runPreview">preview prompt</TBtn>
      </div>
      <div v-if="preview" class="grid gap-2">
        <div class="text-tertiary">// {{ preview.chunks }} part(s), ~{{ preview.tokens.toLocaleString("en") }} diff tokens. first part shown.</div>
        <details open><summary class="cursor-pointer text-secondary">system prompt</summary><pre class="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-sm bg-base px-3 py-2 text-[12.5px]">{{ preview.system }}</pre></details>
        <details><summary class="cursor-pointer text-secondary">user message</summary><pre class="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-sm bg-base px-3 py-2 text-[12.5px]">{{ preview.user }}</pre></details>
      </div>
    </form>

    <ul class="m-0 grid gap-2 p-0">
      <li v-for="p in store.profiles" :key="p.id" class="grid list-none gap-1 rounded-lg border border-subtle bg-surface px-4 py-3">
        <div class="flex flex-wrap items-center gap-3">
          <span class="font-medium text-bright">{{ p.name }}</span>
          <span class="text-accent2">{{ modeLabel(p.mode) }}</span>
          <span v-if="p.isDefault" class="text-ok">default</span>
          <span class="text-faint">v{{ p.version }}</span>
          <span class="ml-auto text-tertiary">{{ p.options.model || "account model" }}</span>
        </div>
        <div v-if="p.resolved.categories.length" class="text-[13px] text-tertiary">
          <span v-for="c in p.resolved.categories" :key="c" class="mr-2" :class="p.resolved.blocking.includes(c) ? 'text-danger' : ''">{{ c }}</span>
          <span class="text-faint">· {{ p.resolved.confirmation === "never" ? "one run" : "confirm blocking" }} · {{ p.resolved.maxChunks }}×{{ Math.round(p.resolved.budgetTokens / 1000) }}k</span>
        </div>
        <div class="flex flex-wrap gap-1">
          <TBtn @click="(editing = toDraft(p)), (preview = null)">edit</TBtn>
          <TBtn @click="(editing = { ...toDraft(p), id: null, name: `${p.name} copy` }), (preview = null)">duplicate</TBtn>
          <TBtn v-if="!p.isDefault" @click="act(p, 'default')">make default</TBtn>
          <TBtn v-if="!p.isDefault" tone="danger" confirm="delete?" @click="act(p, 'delete')">delete</TBtn>
        </div>
      </li>
    </ul>
  </div>
</template>
