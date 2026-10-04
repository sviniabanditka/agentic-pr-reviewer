<script setup lang="ts">
import { computed } from "vue";
import { reviewTone } from "../format";
import type { Review } from "../types";
// Review state as a status chip; `dot` shows only the coloured dot.
const props = defineProps<{ review: Pick<Review, "status" | "conclusion" | "error" | "comment_url"> | null | undefined; dot?: boolean }>();
const t = computed(() => reviewTone(props.review));
</script>

<template>
  <span v-if="dot" class="inline-block size-2 shrink-0 rounded-full" :style="{ background: t.fg }" :title="t.label" :aria-label="t.label" />
  <span v-else class="chip" :style="{ color: t.fg, background: t.bg }">{{ t.label }}</span>
</template>
