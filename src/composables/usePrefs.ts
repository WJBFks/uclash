import { onMounted, onUnmounted, ref } from 'vue';
import { getTestUrl, setTestUrl, PrefsEvent } from '@/utils/prefs';

/** 节点测速 URL：跨页面（节点页/设置页）共享，localStorage 持久化 + 事件同步 */
export function usePrefs() {
  const testUrl = ref(getTestUrl());

  function onPrefsChanged() {
    testUrl.value = getTestUrl();
  }

  onMounted(() => window.addEventListener(PrefsEvent, onPrefsChanged));
  onUnmounted(() => window.removeEventListener(PrefsEvent, onPrefsChanged));

  return {
    testUrl,
    saveTestUrl: (v: string) => setTestUrl(v),
  };
}
