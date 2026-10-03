<script setup lang="ts">
import { ref } from "vue";
import { api } from "../api";
import { store } from "../store";
import TBtn from "../components/TBtn.vue";
import TPrompt from "../components/TPrompt.vue";
import { toast } from "../components/toast";

const models = ref(store.models.join("\n"));
const saving = ref(false);
async function saveModels() {
  saving.value = true;
  try {
    const res = await api.patch<{ models: string[] }>("/settings", { models: models.value.split("\n").map((m) => m.trim()).filter(Boolean) });
    store.models = res.models;
    models.value = res.models.join("\n");
    toast("models saved");
  } catch (e) {
    toast((e as Error).message, true);
  } finally {
    saving.value = false;
  }
}
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
      <TPrompt>models</TPrompt>
      <form class="grid gap-3 rounded-lg border border-subtle bg-surface px-5 py-4" @submit.prevent="saveModels">
        <p class="m-0 text-tertiary">// one per line: what the model pickers offer. anything <span class="text-secondary">claude --model</span> accepts — aliases (sonnet, opus, haiku) or full ids (claude-opus-5-5).</p>
        <textarea v-model="models" class="field min-h-36" :disabled="store.user?.role !== 'admin'" aria-label="models" />
        <div><TBtn type="submit" tone="primary" :busy="saving" :disabled="store.user?.role !== 'admin'">save</TBtn>
          <span v-if="store.user?.role !== 'admin'" class="ml-2 text-faint">// admin only</span></div>
      </form>
    </section>
  </div>
</template>
