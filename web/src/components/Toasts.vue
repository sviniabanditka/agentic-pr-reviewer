<script setup lang="ts">
import { toasts } from "./toast";
</script>

<template>
  <div class="fixed bottom-5 right-5 z-[60] grid justify-items-end gap-2" aria-live="polite">
    <div v-for="t in toasts" :key="t.id" class="max-w-md rounded-lg border px-3.5 py-2.5 text-[13px] shadow-xl shadow-black/40"
      :class="t.err ? 'border-danger/30 bg-danger-bg text-danger' : 'border-strong bg-surface text-bright'" :role="t.err ? 'alert' : 'status'">
      {{ t.msg }}
    </div>
  </div>
</template>
