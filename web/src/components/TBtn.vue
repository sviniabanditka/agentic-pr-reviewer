<script setup lang="ts">
import { ref, onBeforeUnmount } from "vue";
// Terminal button: [ label ]. With `confirm`, the first click arms it and shows the
// confirm text; only a second click within 4 s emits. Used for every outward action.
const props = withDefaults(defineProps<{ tone?: "default" | "primary" | "danger" | "ok"; confirm?: string; disabled?: boolean; busy?: boolean; type?: "button" | "submit"; title?: string }>(), {
  tone: "default",
  type: "button",
});
const emit = defineEmits<{ (e: "click"): void }>();
const armed = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
function onClick() {
  if (props.disabled || props.busy) return;
  if (props.confirm && !armed.value) {
    armed.value = true;
    timer = setTimeout(() => (armed.value = false), 4000);
    return;
  }
  armed.value = false;
  clearTimeout(timer);
  emit("click");
}
onBeforeUnmount(() => clearTimeout(timer));
const toneClass = { default: "text-secondary", primary: "text-accent", danger: "text-danger", ok: "text-ok" };
</script>

<template>
  <button
    :type="type"
    :title="title"
    :disabled="disabled || busy"
    class="group inline-flex items-center whitespace-nowrap rounded-sm px-1 py-0.5 hover:bg-hover disabled:cursor-default disabled:opacity-40"
    :class="armed ? 'text-warn' : toneClass[tone]"
    @click="onClick"
  >
    <span class="text-tertiary">[</span>
    <span class="px-1">{{ busy ? "…" : armed ? confirm : "" }}<slot v-if="!busy && !armed" /></span>
    <span class="text-tertiary">]</span>
  </button>
</template>
