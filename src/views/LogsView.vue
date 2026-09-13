<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '@/api/client';
import { useToast } from '@/composables/useToast';

const toast = useToast();
const lines = ref<string[]>([]);
const loading = ref(false);
const paused = ref(false);
const error = ref('');
const query = ref('');
const level = ref('all');
const dnsName = ref('example.com');
const diagnostics = ref<Record<string, unknown> | null>(null);
const diagnosing = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let alive = true;

const levels = ['all', 'error', 'warn', 'info', 'debug'];
const filteredLines = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return lines.value.filter((line) => {
    if (needle && !line.toLowerCase().includes(needle)) return false;
    if (level.value !== 'all' && !new RegExp(`\\b${level.value}\\b`, 'i').test(line)) return false;
    return true;
  });
});

function schedule() {
  if (!alive) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = undefined; void loadLogs(); }, 2500);
}

async function loadLogs(force = false) {
  if (loading.value) return;
  if (!force && (paused.value || document.hidden)) return schedule();
  loading.value = true;
  error.value = '';
  try {
    const result = await api<{ lines: string[] }>('/logs', { timeout: 20000 });
    lines.value = Array.isArray(result.lines) ? result.lines : [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
    schedule();
  }
}

function togglePause() { paused.value = !paused.value; if (!paused.value) void loadLogs(); }
function onVisibility() { if (!document.hidden && !paused.value) void loadLogs(); }

async function runDiagnostics() {
  if (diagnosing.value) return false;
  const name = dnsName.value.trim();
  if (!name) { toast('请输入域名', true); return false; }
  diagnosing.value = true;
  try {
    const result = await api<{ report: Record<string, unknown> }>(`/diagnostics?name=${encodeURIComponent(name)}`, { timeout: 30000 });
    diagnostics.value = result.report;
    toast('诊断完成');
    return true;
  } catch (e) { toast(`诊断失败: ${e instanceof Error ? e.message : e}`, true); return false; }
  finally { diagnosing.value = false; }
}

function download(filename: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}

async function exportDiagnostics() { if (!diagnostics.value) await runDiagnostics(); if (diagnostics.value) download('clash-diagnostics.json', diagnostics.value); }
async function exportLogs() {
  await runDiagnostics();
  const report = diagnostics.value as { logs?: string[] } | null;
  if (report?.logs) download('clash-logs-redacted.json', { logs: report.logs });
}

onMounted(() => { document.addEventListener('visibilitychange', onVisibility); void loadLogs(); });
onBeforeUnmount(() => { alive = false; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); });
</script>

<template>
  <div>
    <div class="card">
      <div class="title-row"><h2>运行日志</h2><span class="muted">最近 200 行 · 非全量历史</span></div>
      <div class="toolbar">
        <button @click="togglePause">{{ paused ? '继续自动刷新' : '暂停自动刷新' }}</button>
        <button :disabled="loading" @click="loadLogs(true)">{{ loading ? '读取中…' : '立即刷新' }}</button>
        <input v-model="query" class="search" placeholder="搜索日志" />
        <select v-model="level"><option v-for="item in levels" :key="item" :value="item">{{ item === 'all' ? '全部级别' : item }}</option></select>
        <button @click="exportLogs">导出脱敏日志</button>
      </div>
      <div class="hint">{{ paused ? '自动刷新已暂停' : '每 2.5 秒刷新；浏览器标签页隐藏时暂停' }} · {{ filteredLines.length }}/{{ lines.length }} 行</div>
      <div v-if="error" class="sub-result"><span class="fail">{{ error }}</span> <span class="muted">已保留上次数据</span></div>
      <pre class="log-box">{{ filteredLines.length ? filteredLines.join('\n') : '（无匹配日志）' }}</pre>
    </div>

    <div class="card">
      <div class="title-row"><h2>网络诊断</h2><span class="muted">不会自动执行</span></div>
      <div class="toolbar"><input v-model="dnsName" class="search" placeholder="DNS 查询域名" @keyup.enter="runDiagnostics" /><button :disabled="diagnosing" @click="runDiagnostics">{{ diagnosing ? '诊断中…' : '运行诊断' }}</button><button :disabled="diagnosing" @click="exportDiagnostics">导出诊断 JSON</button></div>
      <div v-if="diagnostics" class="diagnostics">
        <div>核心：{{ diagnostics.coreReachable ? '可达' : '不可达' }} · 配置：{{ diagnostics.configReadable ? '可读' : '不可读' }} · 端口：{{ diagnostics.portReachable ? '可达' : '不可达' }}</div>
        <div>版本：{{ diagnostics.version || '—' }} · 模式：{{ diagnostics.mode || '—' }} · TUN：{{ diagnostics.tun ? '开启' : '关闭' }}</div>
        <pre>{{ JSON.stringify({ target: diagnostics.target, dns: diagnostics.dns, proxyPort: diagnostics.proxyPort, at: diagnostics.at }, null, 2) }}</pre>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.title-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 6px; align-items: center; }
.search { min-width: 180px; flex: 1; }
.log-box { margin-top: 10px; background: #101418; color: #c9d4e0; border-radius: 8px; padding: 10px 12px; font-size: 12px; line-height: 1.5; max-height: 440px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
.diagnostics { margin-top: 12px; line-height: 1.8; }
.diagnostics pre { background: #f6f7f9; padding: 10px; border-radius: 6px; overflow: auto; font-size: 12px; }
.hint { color: #7b8490; font-size: 12px; }
</style>
