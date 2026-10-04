<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "../api";
import { refreshState, store } from "../store";
import type { Profile, ProfileOptions } from "../types";
import TBtn from "../components/TBtn.vue";
import Drawer from "../components/Drawer.vue";
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
const openItems = computed(() => [...store.items.values()].filter((i) => i.state === "open" && i.kind === "pr"));
const current = computed(() => store.profiles.find((p) => p.id === editing.value?.id));

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
const open = (p: Profile | null, draft?: Draft) => ((editing.value = draft ?? toDraft(p)), (preview.value = null));
watch(() => store.profiles.length, () => {
  if (!editing.value && store.profiles.length) open(store.profiles.find((p) => p.isDefault) ?? store.profiles[0]!);
}, { immediate: true });

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
function setKind(c: string, blocking: boolean) {
  const d = editing.value!;
  if (blocking !== d.blocking.includes(c)) toggle(d.blocking, c);
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
    const body = { name: d.name.trim() || (mode.value?.label ?? "Profile"), mode: d.mode, options: options(d) };
    const r = d.id ? await api.patch<{ profile: Profile }>(`/profiles/${d.id}`, body) : await api.post<{ profile: Profile }>("/profiles", body);
    toast("Profile saved");
    await refreshState();
    open(store.profiles.find((p) => p.id === r.profile.id) ?? null);
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
    if (what === "delete") editing.value = null;
    await refreshState();
  } catch (e) {
    toast((e as Error).message, true);
  }
}
async function runPreview() {
  const d = editing.value!;
  if (!d.id) return toast("Save the profile first, then preview", true);
  if (!previewItem.value) previewItem.value = openItems.value[0]?.id ?? "";
  if (!previewItem.value) return toast("Preview needs an open pull request in the inbox", true);
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
  <div class="flex min-h-screen flex-wrap">
    <section aria-label="Profiles" class="min-w-0 max-w-[420px] flex-[1_1_360px] border-r border-subtle">
      <div class="flex items-center gap-2 px-[18px] pb-1.5 pt-[18px]">
        <h1 class="m-0 text-base font-semibold text-bright">Profiles</h1>
        <TBtn class="ml-auto" tone="primary" size="sm" @click="open(null)">+ New profile</TBtn>
      </div>
      <p class="hint mx-[18px] mb-3.5">How a review looks for problems: the mode, which categories count and which ones hold a merge.</p>
      <div v-for="p in store.profiles" :key="p.id" class="mx-2 mb-1 cursor-pointer rounded-[10px] px-3.5 py-3" :class="editing?.id === p.id ? 'bg-hover' : 'hover:bg-[#1b1c21]'" @click="open(p)">
        <div class="flex items-center gap-2">
          <span class="font-medium text-bright">{{ p.name }}</span>
          <span v-if="p.isDefault" class="chip bg-ok-bg text-ok">default</span>
          <span class="ml-auto text-xs text-tertiary">{{ p.options.model || "account model" }}</span>
        </div>
        <div class="mt-0.5 text-xs text-tertiary">{{ modeLabel(p.mode) }}<template v-if="p.resolved.categories.length"> · {{ p.resolved.categories.length }} categories, {{ p.resolved.blocking.length }} block</template></div>
      </div>
    </section>

    <main class="min-w-0 flex-[999_1_640px]">
      <form v-if="editing" @submit.prevent="save">
        <div class="flex flex-wrap items-center gap-2 border-b border-subtle px-8 py-3.5">
          <span class="text-[13px] text-tertiary">{{ editing.id ? `${current?.name ?? "Profile"} · version ${current?.version ?? 1}` : "New profile" }}</span>
          <span class="ml-auto" />
          <TBtn v-if="current && !current.isDefault" tone="danger" confirm="Delete this profile?" @click="act(current, 'delete')">Delete</TBtn>
          <TBtn v-if="current && !current.isDefault" @click="act(current, 'default')">Make default</TBtn>
          <TBtn v-if="current" @click="open(null, { ...toDraft(current), id: null, name: `${current.name} copy` })">Duplicate</TBtn>
          <TBtn :busy="previewing" :disabled="!editing.id" :title="editing.id ? '' : 'Save first'" @click="runPreview">Preview prompt</TBtn>
          <TBtn type="submit" tone="primary" :busy="saving">Save</TBtn>
        </div>
        <div class="grid max-w-[840px] gap-[22px] px-8 py-6">
          <div class="grid gap-3.5 sm:grid-cols-3">
            <label><span class="label">Name</span><input v-model="editing.name" class="field" :placeholder="mode?.label"></label>
            <label><span class="label">Mode</span><select v-model="editing.mode" class="field" @change="onModeChange"><option v-for="m in store.modes" :key="m.id" :value="m.id">{{ m.label }}</option></select></label>
            <label><span class="label">Model</span><select v-model="editing.model" class="field"><option value="">Account default</option><option v-for="m in store.models" :key="m" :value="m">{{ m }}</option></select></label>
          </div>
          <p class="hint -mt-2">{{ mode?.description }}</p>

          <template v-if="mode?.output === 'findings'">
            <div v-if="editing.mode !== 'custom'" class="panel overflow-hidden">
              <div class="grid grid-cols-[200px_120px_minmax(0,1fr)] gap-3 bg-[#1a1b20] px-4 py-2.5 text-xs text-tertiary"><span>Category</span><span>Counts as</span><span>What the model reports</span></div>
              <div v-for="c in modeCategories" :key="c" class="grid grid-cols-[200px_120px_minmax(0,1fr)] items-center gap-3 border-t border-subtle px-4 py-2.5">
                <label class="flex items-center gap-2"><input type="checkbox" class="accent-accent" :checked="editing.categories.includes(c)" @change="toggle(editing.categories, c)"> <span class="font-mono text-[12.5px]">{{ c }}</span></label>
                <select class="rounded-md border border-strong px-1.5 py-1 text-[12.5px]" :class="editing.blocking.includes(c) ? 'bg-danger-bg text-danger' : 'bg-surface text-secondary'"
                  :disabled="!editing.categories.includes(c)" :value="editing.blocking.includes(c) ? 'b' : 'n'" :aria-label="`${c} counts as`" @change="setKind(c, ($event.target as HTMLSelectElement).value === 'b')">
                  <option value="b">Blocking</option><option value="n">Note</option></select>
                <span class="truncate text-[12.5px] text-[#9a9aa5]" :title="store.categoryText[c]">{{ store.categoryText[c] }}</span>
              </div>
            </div>
            <div v-else class="grid gap-2">
              <span class="label mb-0">Your categories (OTHER is always added)</span>
              <div v-for="(c, i) in editing.custom" :key="i" class="grid gap-2 md:grid-cols-[180px_minmax(0,1fr)_120px_auto] md:items-center">
                <input v-model="c.id" class="field font-mono text-[13px]" placeholder="PERF" aria-label="Category id">
                <input v-model="c.description" class="field" placeholder="What the model should report under it" aria-label="Description">
                <select class="field py-1.5 text-[13px]" :value="editing.blocking.includes(c.id.toUpperCase()) ? 'b' : 'n'" aria-label="Counts as" @change="setKind(c.id.toUpperCase(), ($event.target as HTMLSelectElement).value === 'b')"><option value="b">Blocking</option><option value="n">Note</option></select>
                <TBtn tone="danger" size="sm" @click="editing.custom.splice(i, 1)">Remove</TBtn>
              </div>
              <div><TBtn size="sm" @click="editing.custom.push({ id: '', description: '' })">+ Category</TBtn></div>
            </div>
            <div class="grid gap-3.5 sm:grid-cols-4">
              <label><span class="label">Confirmation</span><select v-model="editing.confirmation" class="field"><option value="blocking">Second run for blocking</option><option value="never">One run decides</option></select></label>
              <label><span class="label">PR description</span><select v-model="editing.intent" class="field"><option value="pr-body">Send it</option><option value="none">Don't send it</option></select></label>
              <label><span class="label">Tokens per part</span><input v-model.number="editing.budgetTokens" type="number" min="4000" max="150000" step="1000" class="field"></label>
              <label><span class="label">Parts at most</span><input v-model.number="editing.maxChunks" type="number" min="1" max="20" class="field"></label>
            </div>
          </template>
          <label><span class="label">Extra instructions (added to the system prompt)</span>
            <textarea v-model="editing.instructions" rows="3" class="field resize-y" placeholder="This codebase uses repository objects for every query; flag direct SQL." /></label>
          <label v-if="editing.id && openItems.length" class="max-w-md"><span class="label">Preview on</span>
            <select v-model="previewItem" class="field"><option value="">The newest open pull request</option><option v-for="i in openItems" :key="i.id" :value="i.id">{{ i.repo.split("/")[1] }} #{{ i.number }} {{ i.title }}</option></select></label>
        </div>
      </form>
      <div v-else class="grid h-full place-items-center p-10 text-tertiary">Pick a profile or create one.</div>
    </main>

    <Drawer :open="preview !== null" title="Prompt preview" width="900px" @close="preview = null">
      <div v-if="preview" class="grid gap-4 px-8 py-6">
        <h2 class="m-0 text-lg font-semibold text-bright">Prompt preview</h2>
        <p class="hint">{{ preview.chunks }} part(s), about {{ preview.tokens.toLocaleString("en") }} diff tokens. The first part is shown.</p>
        <details open><summary class="cursor-pointer text-secondary">System prompt</summary><pre class="mt-2 max-h-[45vh] overflow-auto whitespace-pre-wrap rounded-lg bg-surface px-4 py-3 text-xs">{{ preview.system }}</pre></details>
        <details><summary class="cursor-pointer text-secondary">User message</summary><pre class="mt-2 max-h-[45vh] overflow-auto whitespace-pre-wrap rounded-lg bg-surface px-4 py-3 text-xs">{{ preview.user }}</pre></details>
      </div>
    </Drawer>
  </div>
</template>
