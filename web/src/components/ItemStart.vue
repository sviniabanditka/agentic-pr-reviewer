<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { accountOf, store } from "../store";
import { itemName, preferredModel, preferredProfile, rememberModel, rememberProfile, startReview } from "../actions";
import { roleLabel } from "../format";
import type { Item } from "../types";
import TBtn from "./TBtn.vue";
import Rel from "./Rel.vue";

// The right pane for an item that has no review yet.
const props = defineProps<{ item: Item }>();
const emit = defineEmits<{ (e: "started", id: number): void }>();
const account = computed(() => accountOf(props.item.accountId));
const model = ref("");
const profile = ref("");
watch(() => props.item.id, () => {
  model.value = preferredModel(props.item.id, account.value?.model);
  profile.value = preferredProfile(props.item.id, account.value?.profileId);
}, { immediate: true });
const canReview = computed(() => !!account.value?.credentialId && props.item.state === "open");
function go() {
  rememberModel(props.item.id, model.value);
  rememberProfile(props.item.id, profile.value);
  void startReview(props.item.id, model.value, profile.value).then((id) => id !== null && emit("started", id));
}
</script>

<template>
  <div class="flex min-h-full flex-col">
    <div class="flex flex-wrap items-center gap-2 border-b border-subtle px-8 py-3.5">
      <span class="text-[13px] text-tertiary">{{ itemName(item) }} · as {{ account?.label }}</span>
      <span class="ml-auto" />
      <slot name="actions" />
      <a v-if="item.url" :href="item.url" target="_blank" rel="noopener" class="rounded-md border border-strong px-3 py-1.5 text-[13px] text-bright hover:bg-hover">Open on GitHub</a>
    </div>
    <div class="grid max-w-[760px] gap-5 px-8 py-6">
      <h2 class="m-0 text-[22px] font-semibold leading-snug tracking-tight text-bright">{{ item.title }}</h2>
      <div class="-mt-2 flex flex-wrap gap-1.5">
        <span class="chip">{{ roleLabel(item.role) }}</span>
        <span v-if="item.role !== 'author' && item.kind === 'pr'" class="chip">by @{{ item.author }}</span>
        <span v-if="item.draft" class="chip">draft</span>
        <span v-if="item.state !== 'open'" class="chip text-warn">{{ item.state }}</span>
        <span v-if="item.changedFiles" class="chip">{{ item.changedFiles }} files <span class="text-ok">+{{ item.additions ?? 0 }}</span> <span class="text-danger">−{{ item.deletions ?? 0 }}</span></span>
        <span v-for="l in item.labels" :key="l" class="chip">{{ l }}</span>
        <span class="chip">updated <Rel :ts="item.updatedAt ? Date.parse(item.updatedAt) : null" /></span>
      </div>
      <div class="card grid gap-4 px-5 py-5">
        <div class="text-bright">Not reviewed yet</div>
        <div class="grid gap-3 sm:grid-cols-2">
          <label><span class="label">Profile</span><select v-model="profile" class="field"><option v-for="p in store.profiles" :key="p.id" :value="p.id">{{ p.name }}</option></select></label>
          <label><span class="label">Model</span><select v-model="model" class="field"><option v-for="m in store.models" :key="m" :value="m">{{ m }}</option></select></label>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <TBtn tone="primary" :disabled="!canReview" @click="go">Start review</TBtn>
          <span class="text-[13px] text-tertiary">{{ !account?.credentialId ? "Attach a Claude credential to this account on Accounts first." : item.state !== "open" ? "The pull request is not open." : "The result stays here until you press Post." }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
