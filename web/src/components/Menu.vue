<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
// A dropdown: the trigger slot gets `toggle`, the default slot gets `close`. Closes on Esc
// and on a click outside.
defineProps<{ align?: "left" | "right"; width?: string }>();
const open = ref(false);
const root = ref<HTMLElement | null>(null);
const toggle = () => (open.value = !open.value);
const close = () => (open.value = false);
function onDoc(e: MouseEvent) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) close();
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") close();
}
document.addEventListener("mousedown", onDoc);
document.addEventListener("keydown", onKey);
onBeforeUnmount(() => (document.removeEventListener("mousedown", onDoc), document.removeEventListener("keydown", onKey)));
</script>

<template>
  <div ref="root" class="relative inline-flex">
    <slot name="trigger" :toggle="toggle" :open="open" />
    <div v-if="open" role="menu" class="absolute top-[calc(100%+6px)] z-30 rounded-xl border border-[#30313a] bg-[#1e1f25] p-1.5 shadow-xl shadow-black/45"
      :class="align === 'left' ? 'left-0' : 'right-0'" :style="{ width: width ?? '260px' }">
      <slot :close="close" />
    </div>
  </div>
</template>
