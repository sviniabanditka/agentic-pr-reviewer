<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { accountOf, store } from "../store";
import { preferredModel, preferredProfile, publishReview, rememberModel, rememberProfile, startReview } from "../actions";
import { openReview } from "../router";
import { roleLabel, verdictWord } from "../format";
import type { Item } from "../types";
import Rel from "./Rel.vue";
import TBtn from "./TBtn.vue";
import TGlyph from "./TGlyph.vue";

const props = defineProps<{ item: Item; showAccount?: boolean }>();
const router = useRouter();
const account = computed(() => accountOf(props.item.accountId));
const last = computed(() => props.item.lastReview);
const busy = computed(() => last.value?.status === "queued" || last.value?.status === "running");
const canReview = computed(() => !!account.value?.credentialId && props.item.state === "open");
const stale = computed(() => last.value?.status === "done" && !!props.item.headSha && last.value.head_sha !== props.item.headSha);
const model = ref(preferredModel(props.item.id, account.value?.model));
const profile = ref(preferredProfile(props.item.id, account.value?.profileId));
function pickProfile(e: Event) {
  profile.value = (e.target as HTMLSelectElement).value;
  rememberProfile(props.item.id, profile.value);
}
const posting = ref(false);

async function post() {
  posting.value = true;
  await publishReview(last.value!.id);
  posting.value = false;
}
function pick(e: Event) {
  model.value = (e.target as HTMLSelectElement).value;
  rememberModel(props.item.id, model.value);
}
</script>

<template>
  <li class="group grid cursor-pointer grid-cols-[18px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 rounded-md px-3 py-2.5 hover:bg-hover sm:grid-cols-[18px_minmax(0,1fr)_auto]"
    @click="router.push(`/items/${item.id}`)">
    <TGlyph :review="last" class="text-center" />
    <div class="min-w-0">
      <div class="flex flex-wrap items-baseline gap-x-2 text-tertiary">
        <span class="text-accent2">{{ item.kind === "patch" ? "patch" : item.repo }}{{ item.kind === "pr" || !item.kind ? ` #${item.number}` : "" }}</span>
        <span v-if="item.kind === 'compare'" class="text-faint">compare</span>
        <span v-if="showAccount">as {{ account?.label }}</span>
        <span v-if="item.draft" class="text-faint">draft</span>
        <span v-if="item.state !== 'open'" class="text-warn">{{ item.state }}</span>
      </div>
      <div class="truncate text-bright">{{ item.title }}</div>
      <div class="flex flex-wrap items-center gap-x-3 text-[13px] text-tertiary">
        <span>{{ roleLabel(item.role) }}</span>
        <span v-if="item.role !== 'author'">by @{{ item.author }}</span>
        <span>updated <Rel :ts="item.updatedAt ? Date.parse(item.updatedAt) : null" /></span>
        <span v-if="item.changedFiles">{{ item.changedFiles }} files <span class="text-ok">+{{ item.additions }}</span> <span class="text-danger">-{{ item.deletions }}</span></span>
        <button v-if="last" class="hover:text-bright" :class="last.status === 'done' ? (last.conclusion === 'success' ? 'text-ok' : 'text-danger') : last.status === 'error' ? 'text-warn' : 'text-accent'"
          @click.stop="openReview(last.id)">{{ verdictWord(last) }}{{ last.status === "done" ? (last.comment_url ? " · posted" : " · not posted") : "" }}</button>
        <span v-if="stale" class="text-warn">new commits</span>
      </div>
    </div>
    <div class="col-start-2 flex flex-wrap items-center gap-1 sm:col-start-3" @click.stop>
      <TBtn v-if="last?.status === 'done' && !last.comment_url" tone="ok" :busy="posting"
        :confirm="`post as @${account?.login}?`" title="post the last review as a pr comment" @click="post">post</TBtn>
      <select class="field w-auto max-w-40 py-1" :value="profile" :disabled="busy" :aria-label="`profile for ${item.repo} #${item.number}`" @change="pickProfile">
        <option v-for="p in store.profiles" :key="p.id" :value="p.id">{{ p.name.toLowerCase() }}</option>
      </select>
      <select class="field w-auto py-1" :value="model" :disabled="busy" :aria-label="`model for ${item.repo} #${item.number}`" @change="pick">
        <option v-for="m in store.models" :key="m" :value="m">{{ m }}</option>
      </select>
      <TBtn tone="primary" :disabled="busy || !canReview" :title="canReview ? '' : item.state !== 'open' ? 'the pull request is not open' : 'attach a claude credential to the account'"
        @click="startReview(item.id, model, profile)">{{ busy ? "in progress" : last ? "re-review" : "review" }}</TBtn>
    </div>
  </li>
</template>
