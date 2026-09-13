import { computed, onMounted, onUnmounted, readonly, ref, shallowRef } from 'vue';
import { api } from '@/api/client';
import type { TrafficData } from '@/api/types';

const DEFAULT_INTERVAL_MS = 2000;

/** Polls the traffic snapshot only while its host component is visible. */
export function useTraffic() {
  const data = ref<TrafficData | null>(null);
  const lastUpdated = ref<Date | null>(null);
  const loading = shallowRef(false);
  const error = shallowRef<string | null>(null);
  const stale = shallowRef(false);
  let timer: ReturnType<typeof setInterval> | null = null;

  const intervalMs = computed(() => {
    const value = data.value?.intervalMs;
    return Number.isFinite(value) && value! > 0 ? value! : DEFAULT_INTERVAL_MS;
  });

  function stopPolling() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function startPolling() {
    stopPolling();
    timer = setInterval(poll, intervalMs.value);
  }

  async function reload() {
    if (loading.value) return;

    loading.value = true;
    try {
      const snapshot = await api<TrafficData>('/traffic');
      data.value = snapshot;
      lastUpdated.value = new Date();
      error.value = null;
      stale.value = false;
      if (timer && intervalMs.value !== DEFAULT_INTERVAL_MS) startPolling();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '无法读取流量数据';
      stale.value = data.value !== null;
    } finally {
      loading.value = false;
    }
  }

  function poll() {
    if (!document.hidden) void reload();
  }

  function onVisibilityChange() {
    if (document.hidden) {
      stopPolling();
      return;
    }
    void reload();
    startPolling();
  }

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (!document.hidden) {
      void reload();
      startPolling();
    }
  });
  onUnmounted(() => {
    stopPolling();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  });

  return {
    data: readonly(data), lastUpdated: readonly(lastUpdated), loading: readonly(loading),
    error: readonly(error), stale: readonly(stale), reload,
  };
}
