<script setup lang="ts">
defineProps<{ hint?: string; danger?: boolean; href?: string; disabled?: boolean }>();
defineEmits<{ (e: "click"): void }>();
</script>

<template>
  <a v-if="href" role="menuitem" :href="href" class="block rounded-lg px-3 py-2 text-bright hover:bg-[#2a2836]">
    <slot /><span v-if="hint" class="block text-xs text-tertiary">{{ hint }}</span>
  </a>
  <button v-else role="menuitem" :disabled="disabled" class="block w-full cursor-pointer rounded-lg px-3 py-2 text-left hover:bg-[#2a2836] disabled:cursor-default disabled:opacity-40"
    :class="danger ? 'text-danger' : 'text-bright'" @click="$emit('click')">
    <slot /><span v-if="hint" class="block text-xs text-tertiary">{{ hint }}</span>
  </button>
</template>
