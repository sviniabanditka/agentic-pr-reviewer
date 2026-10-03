<script setup lang="ts">
import { toasts } from "./toast";
</script>

<template>
  <div class="fixed bottom-5 right-5 z-50 grid justify-items-end gap-2" aria-live="polite">
    <div v-for="t in toasts" :key="t.id" class="max-w-md rounded-md border px-3 py-2 shadow-lg"
      :class="t.err ? 'border-danger/40 bg-[#24141a] text-danger' : 'border-subtle bg-elevated text-bright'" :role="t.err ? 'alert' : 'status'">
      <span :class="t.err ? 'text-danger' : 'text-ok'">{{ t.err ? "!" : "$" }}</span> {{ t.msg }}
    </div>
  </div>
</template>
