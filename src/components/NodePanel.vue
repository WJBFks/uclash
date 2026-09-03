<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '@/api/client';
import { useToast } from '@/composables/useToast';
import { getTestUrl, setTestUrl, PrefsEvent } from '@/utils/prefs';
import type { ProxiesData, ProxyTestData, ProxyTestResult, ProxySetResult, ModeData, ModeResult } from '@/api/types';

const toast = useToast();

const nodes = ref<ProxiesData>({ now: '', all: [] });
const filter = ref('');
const testUrl = ref(getTestUrl());
const testResults = ref<Record<string, ProxyTestResult>>({});
const testing = ref(false);
const testStatus = ref('');
const loadError = ref('');
let inflight = false;
let timer: ReturnType<typeof setInterval> | null = null;

// ---- 代理模式（规则/全局/直连，对应 mihomo config 的 mode）----
const mode = ref('rule');
async function loadMode() {
  try {
    const d = await api<ModeData>('/mode');
    mode.value = d.mode;
  } catch {
    /* mihomo 未运行时静默 */
  }
}
async function setMode(m: string) {
  if (m === mode.value) return;
  const prev = mode.value;
  mode.value = m; // 乐观更新，失败回弹
  try {
    const d = await api<ModeResult>('/mode', { method: 'POST', body: { mode: m } });
    toast(d.message, d.ok === false);
  } catch (e) {
    mode.value = prev;
    toast(`切换失败: ${e instanceof Error ? e.message : e}`, true);
  }
}

function onPrefsChanged() {
  testUrl.value = getTestUrl();
}

watch(testUrl, (v) => setTestUrl(v));

const visible = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return nodes.value.all.filter((n) => !q || n.toLowerCase().includes(q));
});

async function loadNodes() {
  if (inflight) return; // in-flight 合并：/proxies 转发 mihomo，卡时防堆积
  inflight = true;
  try {
    nodes.value = await api<ProxiesData>('/proxies');
    loadError.value = '';
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    inflight = false;
  }
}

function metaOf(name: string): { type?: string; udp?: boolean } | undefined {
  return nodes.value.meta?.[name];
}

function badgeClass(r: ProxyTestResult): string {
  if (!r.ok) return 'fail';
  const l = r.latency ?? 0;
  if (l < 300) return 'good';
  if (l < 1000) return 'mid';
  return 'slow';
}

async function runTest(selected: boolean) {
  if (testing.value) return;
  // selected=true 只测当前搜索过滤后可见的节点，否则测全部
  const names = selected ? visible.value : nodes.value.all;
  if (names.length === 0) return toast('没有可测试的节点', true);
  testing.value = true;
  testResults.value = {};
  testStatus.value = `测试中（${names.length} 个节点 · 并发 · 单项 10s 超时）…`;
  try {
    const d = await api<ProxyTestData>('/proxy-test', {
      method: 'POST',
      body: { url: testUrl.value, nodes: names },
      timeout: 45000, // 单项 10s + 排队缓冲
    });
    const m: Record<string, ProxyTestResult> = {};
    for (const r of d.results) m[r.name] = r;
    testResults.value = m;
    const okList = d.results.filter((r) => r.ok).sort((a, b) => (a.latency ?? 0) - (b.latency ?? 0));
    const okFast = okList.slice(0, 3).map((r) => `${r.name}(${r.latency}ms)`).join('、');
    let msg = `完成 ${okList.length}/${d.results.length} 个节点`;
    if (okFast) msg += `，最快: ${okFast}`;
    toast(msg, okList.length === 0);
  } catch (e) {
    toast(`测试失败: ${e instanceof Error ? e.message : e}`, true);
  } finally {
    testing.value = false;
    testStatus.value = '';
    loadNodes();
  }
}

async function setNode(name: string) {
  try {
    const d = await api<ProxySetResult>('/proxy-set', { method: 'POST', body: { name } });
    toast(d.message, d.ok === false);
    nodes.value.now = name;
  } catch (e) {
    toast(`切换失败: ${e instanceof Error ? e.message : e}`, true);
  }
}

onMounted(() => {
  loadNodes();
  loadMode();
  timer = setInterval(loadNodes, 3000);
  window.addEventListener(PrefsEvent, onPrefsChanged);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
  window.removeEventListener(PrefsEvent, onPrefsChanged);
});
</script>

<template>
  <div class="card node-page">
    <!-- 标题行：代理组 + 当前节点 + 模式切换（参考 Clash Verge 布局） -->
    <div class="np-header">
      <div class="np-title">
        <h2>代理组 · PROXY</h2>
        <span v-if="nodes.now" class="np-now">当前：{{ nodes.now }}</span>
      </div>
      <div class="mode-switch" role="group" aria-label="代理模式">
        <button :class="{ active: mode === 'rule' }" @click="setMode('rule')">规则</button>
        <button :class="{ active: mode === 'global' }" @click="setMode('global')">全局</button>
        <button :class="{ active: mode === 'direct' }" @click="setMode('direct')">直连</button>
      </div>
    </div>

    <!-- 工具栏：搜索 + 测速 URL + 测试按钮 -->
    <div class="row np-toolbar">
      <input type="text" v-model="filter" class="np-search" placeholder="搜索节点…" />
      <input type="url" v-model="testUrl" class="np-url" placeholder="测速 URL（默认 Google 204）" />
      <button :disabled="testing" @click="runTest(true)">测试选中</button>
      <button class="primary" :disabled="testing" @click="runTest(false)">测试全部</button>
    </div>

    <!-- 节点卡片网格（Clash Verge 风格） -->
    <div class="node-grid" v-if="!loadError">
      <div v-if="!visible.length" class="node-empty">
        {{ nodes.all.length ? '无匹配节点' : '暂无节点（mihomo 未运行？）' }}
      </div>
      <div
        v-for="n in visible"
        :key="n"
        :class="['node-card', { current: n === nodes.now }]"
        :title="n"
        @click="setNode(n)"
      >
        <div class="nc-top">
          <span class="nc-name">{{ n }}</span>
          <span v-if="n === nodes.now" class="nc-check">✓</span>
        </div>
        <div class="nc-badges">
          <span v-if="metaOf(n)?.type" class="badge">{{ metaOf(n)!.type }}</span>
          <span v-if="metaOf(n)?.udp" class="badge">UDP</span>
          <span
            v-if="testResults[n]"
            :class="['badge', 'lat', badgeClass(testResults[n])]"
            :title="testResults[n].error || ''"
          >
            {{ testResults[n].ok ? `${testResults[n].latency}ms` : `✗ ${(testResults[n].error || '').slice(0, 12)}` }}
          </span>
        </div>
      </div>
    </div>
    <div v-else class="node-empty">{{ loadError }}</div>

    <div v-if="testStatus" class="hint testing"><span class="dot warn"></span>{{ testStatus }}</div>
    <div class="hint">
      点击卡片立即切换（= <code>clash set</code>）；列表每 3 秒自动刷新；测速走 mihomo 原生 healthcheck、并发、单项 10s 超时，不影响当前节点
    </div>
  </div>
</template>
