<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "../api";
import { accountOf, store } from "../store";
import { preferredModel, publishReview, rememberModel, startReview } from "../actions";
import { openReview } from "../router";
import { dur, roleLabel, sha7, stamp, verdictWord } from "../format";
import type { Review } from "../types";
import TBtn from "../components/TBtn.vue";
import TGlyph from "../components/TGlyph.vue";
import TPrompt from "../components/TPrompt.vue";
import Rel from "../components/Rel.vue";
import { toast } from "../components/toast";

const props = defineProps<{ id: string }>();
const item = computed(() => store.items.get(props.id));
const account = computed(() => accountOf(item.value?.accountId));
const reviews = computed<Review[]>(() => [...store.reviews.values()].filter((r) => r.item_id === props.id).sort((a, b) => b.id - a.id));
const last = computed(() => reviews.value[0]);
const busy = computed(() => last.value?.status === "queued" || last.value?.status === "running");
const model = ref(preferredModel(props.id, account.value?.model));
watch(model, (m) => rememberModel(props.id, m));

// Reviews older than the 300 the overview loaded still belong on this page.
watch(() => props.id, async (id) => {
  const { reviews: rows } = await api.get<{ reviews: Review[] }>(`/reviews?itemId=${id}&limit=100`).catch(() => ({ reviews: [] as Review[] }));
  rows.forEach((r) => store.reviews.has(r.id) || store.reviews.set(r.id, r));
}, { immediate: true });

const posting = ref(false);
async function post() {
  posting.value = true;
  await publishReview(last.value!.id);
  posting.value = false;
}
async function archive(on: boolean) {
  try {
    const { item: fresh } = await api.post<{ item: typeof item.value }>(`/items/${props.id}/${on ? "archive" : "unarchive"}`);
    if (fresh) store.items.set(fresh.id, { ...fresh, lastReview: item.value?.lastReview ?? null });
  } catch (e) {
    toast((e as Error).message, true);
  }
}
</script>

<template>
  <div v-if="item" class="grid gap-6">
    <div class="text-tertiary"><RouterLink to="/inbox" class="hover:text-bright">inbox</RouterLink> / <span class="text-accent2">{{ item.repo }} #{{ item.number }}</span></div>
    <header class="grid gap-3 rounded-lg border border-subtle bg-surface px-5 py-4">
      <h1 class="m-0 text-lg font-medium leading-snug text-bright"><TGlyph :review="last" class="mr-2" />{{ item.title }}</h1>
      <div class="flex flex-wrap gap-x-4 gap-y-1 text-tertiary">
        <span>{{ roleLabel(item.role) }}</span>
        <span v-if="!item.role.startsWith('author')">by @{{ item.author }}</span>
        <span>as {{ account?.label }} (@{{ account?.login }})</span>
        <span>head <span class="text-accent2">{{ sha7(item.headSha) }}</span></span>
        <span v-if="item.changedFiles">{{ item.changedFiles }} files <span class="text-ok">+{{ item.additions }}</span> <span class="text-danger">-{{ item.deletions }}</span></span>
        <span :class="item.state === 'open' ? 'text-ok' : 'text-warn'">{{ item.state }}{{ item.draft ? " (draft)" : "" }}</span>
        <span>updated <Rel :ts="item.updatedAt ? Date.parse(item.updatedAt) : null" /></span>
      </div>
      <div v-if="item.labels.length" class="flex flex-wrap gap-2"><span v-for="l in item.labels" :key="l" class="text-info">#{{ l }}</span></div>
      <div class="flex flex-wrap items-center gap-1">
        <a :href="item.url" target="_blank" rel="noopener" class="rounded-sm px-1 py-0.5 text-secondary hover:bg-hover"><span class="text-tertiary">[</span> open on github ↗ <span class="text-tertiary">]</span></a>
        <select v-model="model" class="field ml-2 w-auto py-1" :disabled="busy" aria-label="model"><option v-for="m in store.models" :key="m" :value="m">{{ m }}</option></select>
        <TBtn tone="primary" :disabled="busy || !account?.credentialId || item.state !== 'open'" @click="startReview(item.id, model)">{{ busy ? "in progress" : last ? "re-review" : "review" }}</TBtn>
        <TBtn v-if="last?.status === 'done' && !last.comment_url" tone="ok" :busy="posting" :confirm="`post as @${account?.login} → ${item.repo.split('/')[1]} #${item.number}`" @click="post">post last review</TBtn>
        <TBtn v-if="item.state !== 'archived'" @click="archive(true)">archive</TBtn>
        <TBtn v-else @click="archive(false)">unarchive</TBtn>
      </div>
      <div v-if="!account?.credentialId" class="text-warn">! no claude credential attached to @{{ account?.login }} — attach one on <RouterLink to="/accounts" class="text-accent hover:underline">accounts</RouterLink></div>
    </header>

    <section class="grid gap-3">
      <TPrompt>reviews</TPrompt>
      <ol class="m-0 grid gap-0.5 rounded-lg border border-subtle bg-surface p-1.5">
        <li v-for="r in reviews" :key="r.id" class="grid cursor-pointer grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-3 rounded-md px-3 py-2 hover:bg-hover" @click="openReview(r.id)">
          <TGlyph :review="r" class="text-center" />
          <div class="min-w-0">
            <div :class="r.status === 'done' ? (r.conclusion === 'success' ? 'text-ok' : 'text-danger') : r.status === 'error' ? 'text-warn' : 'text-accent'">{{ r.verdict_title ?? verdictWord(r) }}</div>
            <div class="text-[13px] text-tertiary">#{{ r.id }} · <span class="text-accent2">{{ sha7(r.head_sha) }}</span> · {{ r.model }} · {{ r.finished_at && r.started_at ? dur(r.finished_at - r.started_at) : "" }}
              <span v-if="r.comment_url" class="text-ok"> · posted</span><span v-else-if="r.status === 'done'"> · not posted</span>
              <span v-if="r.status === 'error'" class="text-warn"> · {{ r.error }}</span></div>
          </div>
          <span class="text-tertiary" :title="stamp(r.created_at)"><Rel :ts="r.created_at" /></span>
        </li>
        <li v-if="!reviews.length" class="list-none px-3 py-4 text-tertiary">// not reviewed yet — pick a model and press [ review ]</li>
      </ol>
    </section>
  </div>
  <div v-else class="text-tertiary">// pull request not found. it may belong to another account or have been removed. <RouterLink to="/inbox" class="text-accent hover:underline">back to inbox</RouterLink></div>
</template>
