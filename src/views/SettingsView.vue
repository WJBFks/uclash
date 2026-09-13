<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '@/api/client';
import { usePrefs } from '@/composables/usePrefs';
import type { StatusData, LogsData, ConfigInfoData } from '@/api/types';

const props = defineProps<{ status: StatusData | null }>();
const { testUrl } = usePrefs();

// ---- mihomo 日志 ----
const logs = ref<string[] | null>(null);
const logError = ref('');
const loadingLogs = ref(false);
async function loadLogs() {
  loadingLogs.value = true;
  logError.value = '';
  try {
    const d = await api<LogsData>('/logs', { timeout: 20000 });
    logs.value = d.lines;
  } catch (e) {
    logError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loadingLogs.value = false;
  }
}
onMounted(loadLogs);

// ---- 系统信息 ----
const info = ref<ConfigInfoData | null>(null);
onMounted(async () => {
  try {
    info.value = await api<ConfigInfoData>('/config-info');
  } catch {
    info.value = null;
  }
});
</script>

<template>
  <div>
    <div class="card">
      <h2>节点测速 URL</h2>
      <div class="form-row single">
        <input type="url" v-model="testUrl" placeholder="测速目标 URL（默认 Google 204）" />
      </div>
      <div class="hint">切换节点后对当前节点测速会用到此地址；与节点页输入框共享（localStorage），改动即时生效</div>
    </div>

    <div class="card">
      <h2>mihomo 日志（最近 200 行）</h2>
      <div class="row" style="margin-bottom: 10px">
        <button :disabled="loadingLogs" @click="loadLogs">{{ loadingLogs ? '读取中…' : '刷新日志' }}</button>
        <span class="muted">来源：journalctl --user -u mihomo</span>
      </div>
      <div v-if="logError" class="sub-result"><span class="fail">{{ logError }}</span></div>
      <pre v-else class="log-box">{{ logs ? (logs.length ? logs.join('\n') : '（无日志）') : '点击「刷新日志」加载' }}</pre>
    </div>

    <div class="card">
      <h2>系统信息</h2>
      <table class="info-table">
        <tr><td class="k">mihomo 版本</td><td>{{ props.status?.version || '—' }}</td></tr>
        <tr><td class="k">mihomo API</td><td><code>{{ info?.mihomoApi || '—' }}</code></td></tr>
        <tr><td class="k">配置文件</td><td><code>{{ info?.mihomoCfg || '—' }}</code></td></tr>
        <tr><td class="k">订阅缓存目录</td><td><code>{{ info?.providersDir || '—' }}</code></td></tr>
        <tr><td class="k">本服务端口</td><td>{{ info?.webPort || '—' }}</td></tr>
      </table>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/variables' as *;

.form-row.single {
  grid-template-columns: 1fr;
}

.log-box {
  background: #101418;
  color: #c9d4e0;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.5;
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.info-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;

  td {
    padding: 6px 8px;
    border-bottom: 1px solid #f0f1f3;
    vertical-align: top;
  }

  tr:last-child td {
    border-bottom: none;
  }

  .k {
    color: $muted;
    white-space: nowrap;
    width: 140px;
  }
}
</style>
