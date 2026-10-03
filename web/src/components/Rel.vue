<script setup lang="ts">
import { computed } from "vue";
import { store } from "../store";
import { rel, stamp } from "../format";
const props = defineProps<{ ts: number | null | undefined }>();
const text = computed(() => rel(props.ts, store.now));
</script>

<template>
  <time :datetime="ts ? new Date(ts).toISOString() : undefined" :title="stamp(ts)">{{ text }}</time>
</template>
