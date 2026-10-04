<script setup lang="ts">
import { computed } from "vue";
// A thin meter; as a usage meter it turns warn at 70 %, danger at 90 %. `relative` bars
// (share of the largest) keep their colour.
const props = withDefaults(defineProps<{ pct: number | null; label?: string; color?: string; relative?: boolean }>(), {});
const clamped = computed(() => (props.pct == null ? null : Math.max(0, Math.min(100, props.pct))));
const fill = computed(() => {
  if (clamped.value == null) return "";
  if (!props.relative && clamped.value >= 90) return "#ff9c86";
  if (!props.relative && clamped.value >= 70) return "#f2b880";
  return props.color ?? "#9d8cff";
});
</script>

<template>
  <div role="meter" :aria-valuenow="clamped ?? 0" aria-valuemin="0" aria-valuemax="100" :aria-label="label">
    <div v-if="label" class="flex text-xs text-tertiary"><span class="flex-1">{{ label }}</span><span>{{ clamped == null ? "--" : `${Math.round(clamped)}%` }}</span></div>
    <div class="mt-1 h-1 rounded bg-strong"><div class="h-1 rounded" :style="{ width: `${clamped ?? 0}%`, background: fill }" /></div>
  </div>
</template>
