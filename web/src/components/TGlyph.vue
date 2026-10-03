<script setup lang="ts">
import { computed } from "vue";
import type { Review } from "../types";
// Review state as one glyph: ○ none/queued, ◐ running, ✓ clean, ✗ blocking, ⊘ failed/cancelled.
const props = defineProps<{ review: Pick<Review, "status" | "conclusion"> | null | undefined }>();
const g = computed(() => {
  const r = props.review;
  if (!r) return { ch: "·", cls: "text-faint", label: "not reviewed" };
  if (r.status === "queued") return { ch: "○", cls: "text-accent", label: "queued" };
  if (r.status === "running") return { ch: "◐", cls: "text-accent", label: "reviewing" };
  if (r.status === "error") return { ch: "⊘", cls: "text-warn", label: "failed" };
  if (r.status === "skipped") return { ch: "⊘", cls: "text-faint", label: "skipped" };
  return r.conclusion === "success" ? { ch: "✓", cls: "text-ok", label: "clean" } : { ch: "✗", cls: "text-danger", label: "blocking" };
});
</script>

<template>
  <span :class="g.cls" :title="g.label" :aria-label="g.label">{{ g.ch }}</span>
</template>
