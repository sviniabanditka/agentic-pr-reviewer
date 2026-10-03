<script setup lang="ts">
import { computed } from "vue";
// ASCII meter: [████░░░░░░] 42%. Turns warn at 70 %, danger at 90 %.
const props = withDefaults(defineProps<{ pct: number | null; width?: number; hideLabel?: boolean }>(), { width: 12 });
const clamped = computed(() => (props.pct == null ? null : Math.max(0, Math.min(100, props.pct))));
const filled = computed(() => Math.round(((clamped.value ?? 0) / 100) * props.width));
const color = computed(() => (clamped.value == null ? "text-faint" : clamped.value >= 90 ? "text-danger" : clamped.value >= 70 ? "text-warn" : "text-ok"));
</script>

<template>
  <span class="whitespace-nowrap" role="meter" :aria-valuenow="clamped ?? 0" aria-valuemin="0" aria-valuemax="100">
    <span class="text-tertiary">[</span><span :class="color">{{ "█".repeat(filled) }}</span><span class="text-faint/60">{{ "░".repeat(width - filled) }}</span><span class="text-tertiary">]</span>
    <span v-if="!hideLabel" class="ml-1.5" :class="clamped == null ? 'text-faint' : 'text-bright'">{{ clamped == null ? "--" : `${Math.round(clamped)}%` }}</span>
  </span>
</template>
