<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
// Right-hand panel. Closes on Esc, on the × and on a click outside; returns focus to
// whatever opened it.
const props = defineProps<{ open: boolean; title?: string }>();
const emit = defineEmits<{ (e: "close"): void }>();
const closeBtn = ref<HTMLButtonElement | null>(null);
let opener: Element | null = null;

watch(() => props.open, async (open) => {
  if (open) {
    opener = document.activeElement;
    await nextTick();
    closeBtn.value?.focus();
  } else if (opener instanceof HTMLElement) {
    opener.focus();
  }
});
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape" && props.open) emit("close");
}
window.addEventListener("keydown", onKey);
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <Teleport to="body">
    <Transition enter-from-class="opacity-0" leave-to-class="opacity-0" enter-active-class="transition-opacity duration-200" leave-active-class="transition-opacity duration-200">
      <div v-if="open" class="fixed inset-0 z-40 bg-black/50" @click="emit('close')" />
    </Transition>
    <Transition enter-from-class="translate-x-full" leave-to-class="translate-x-full" enter-active-class="transition-transform duration-200" leave-active-class="transition-transform duration-200">
      <aside v-if="open" class="fixed inset-y-0 right-0 z-50 flex w-full max-w-3xl flex-col border-l border-subtle bg-surface shadow-2xl" role="dialog" aria-modal="true" :aria-label="title">
        <div class="flex items-start gap-3 border-b border-subtle px-5 py-4">
          <div class="min-w-0 flex-1"><slot name="header" /></div>
          <button ref="closeBtn" class="rounded-sm px-1.5 text-tertiary hover:bg-hover hover:text-bright" title="close (esc)" aria-label="close" @click="emit('close')">✕</button>
        </div>
        <div class="flex-1 overflow-y-auto px-5 py-4"><slot /></div>
      </aside>
    </Transition>
  </Teleport>
</template>
