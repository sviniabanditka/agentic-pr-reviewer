<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
// Right-hand panel over the page. Closes on Esc, on × and on a click outside; returns
// focus to whatever opened it.
const props = defineProps<{ open: boolean; title?: string; width?: string }>();
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
      <aside v-if="open" class="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-strong bg-base shadow-2xl shadow-black/40" :style="{ maxWidth: width ?? '880px' }" role="dialog" aria-modal="true" :aria-label="title">
        <button ref="closeBtn" class="absolute right-3 top-2.5 z-10 grid size-8 cursor-pointer place-items-center rounded-lg text-lg text-secondary hover:bg-hover hover:text-bright" title="Close (Esc)" aria-label="Close" @click="emit('close')">×</button>
        <div class="flex-1 overflow-y-auto"><slot /></div>
      </aside>
    </Transition>
  </Teleport>
</template>
