import { onMounted, onUnmounted, ref } from 'vue';
import { api } from '@/api/client';
import type { StatusData } from '@/api/types';

/** 状态总览：8s 轮询，in-flight 合并防堆积 */
export function useStatus() {
  const status = ref<StatusData | null>(null);
  const lastUpdated = ref<Date | null>(null);
  const statusError = ref(false);
  let inflight = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refresh() {
    if (inflight) return;
    inflight = true;
    try {
      status.value = await api<StatusData>('/status', { timeout: 15000 });
      statusError.value = false;
      lastUpdated.value = new Date();
    } catch {
      statusError.value = true;
    } finally {
      inflight = false;
    }
  }

  onMounted(() => {
    refresh();
    timer = setInterval(refresh, 8000);
  });
  onUnmounted(() => {
    if (timer) clearInterval(timer);
  });

  return { status, lastUpdated, statusError, refresh };
}
