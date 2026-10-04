<script setup lang="ts">
import { ref, onBeforeUnmount } from "vue";
// With `confirm`, the first click arms the button and shows the confirm text; only a
// second click within 4 s emits. Used for every outward action.
const props = withDefaults(defineProps<{
  tone?: "default" | "primary" | "danger" | "ghost" | "ok"; size?: "sm" | "md"; confirm?: string; disabled?: boolean; busy?: boolean; type?: "button" | "submit"; title?: string;
}>(), { tone: "default", size: "md", type: "button" });
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
const tones = {
  default: "border border-strong text-bright hover:bg-hover",
  primary: "bg-accent font-medium text-on-accent hover:bg-[#ae9fff]",
  ok: "bg-accent font-medium text-on-accent hover:bg-[#ae9fff]",
  danger: "text-danger hover:bg-danger-bg",
  ghost: "text-secondary hover:bg-hover hover:text-bright",
};
</script>

<template>
  <button
    :type="type"
    :title="title"
    :disabled="disabled || busy"
    class="inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md transition-colors disabled:cursor-default disabled:opacity-40"
    :class="[size === 'sm' ? 'px-2.5 py-1 text-[12.5px]' : 'px-3 py-1.5 text-[13px]', armed ? 'bg-warn-bg text-warn ring-1 ring-warn/40' : tones[tone]]"
    @click="onClick"
  >
    <template v-if="busy">…</template>
    <template v-else-if="armed">{{ confirm }}</template>
    <slot v-else />
  </button>
</template>
