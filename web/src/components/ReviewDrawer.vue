<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import Drawer from "./Drawer.vue";
import ReviewPanel from "./ReviewPanel.vue";

// Outside the inbox a review opens as a side panel over the page (?review=<id>).
const route = useRoute();
const router = useRouter();
const id = computed(() => (route.query.review ? Number(route.query.review) : null));
function close() {
  const { review: _r, ...rest } = route.query;
  void router.push({ query: rest });
}
</script>

<template>
  <Drawer :open="id !== null" title="Review" @close="close">
    <ReviewPanel v-if="id !== null" :review-id="id" drawer />
  </Drawer>
</template>
