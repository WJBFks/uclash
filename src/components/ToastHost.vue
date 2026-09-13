<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { onToast, type ToastItem } from '@/composables/useToast';

interface DisplayToast extends ToastItem {
  leaving?: boolean;
}

const toasts = ref<DisplayToast[]>([]);
let off: (() => void) | null = null;

onMounted(() => {
  off = onToast((t) => {
    toasts.value.push(t);
    setTimeout(() => {
      const x = toasts.value.find((v) => v.id === t.id);
      if (x) x.leaving = true;
    }, 3200);
    setTimeout(() => {
      toasts.value = toasts.value.filter((v) => v.id !== t.id);
    }, 3600);
  });
});
onUnmounted(() => {
  off?.();
});
</script>

<template>
  <div class="toast-box" aria-live="polite" aria-atomic="true">
    <div v-for="t in toasts" :key="t.id" :class="['toast-item', { err: t.err, leaving: t.leaving }]" role="status">
      {{ t.msg }}
    </div>
  </div>
</template>
