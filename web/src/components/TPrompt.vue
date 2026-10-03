<script setup lang="ts">
// Section header as a shell prompt: "# open pull requests".
withDefaults(defineProps<{ sigil?: "#" | "$"; level?: 1 | 2 }>(), { sigil: "#", level: 2 });
</script>

<template>
  <component :is="level === 1 ? 'h1' : 'h2'" class="m-0 flex items-center gap-2 font-medium lowercase text-bright" :class="level === 1 ? 'text-base' : 'text-sm'">
    <span class="text-ok">{{ sigil }}</span><slot />
  </component>
</template>
