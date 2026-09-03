<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '@/api/client';
import { useToast } from '@/composables/useToast';
import { getTestUrl, setTestUrl, PrefsEvent } from '@/utils/prefs';
import type { ProxiesData, ProxyTestData, ProxyTestResult, ProxySetResult, ModeResult } from '@/api/types';

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

// ---- 代理模式（规则/全局/直连）。/api/proxies 每次返回当前 mode，无需单独轮询 ----
const mode = ref('rule');
async function setMode(m: string) {
  if (m === mode.value) return;
  try {
    const d = await api<ModeResult>('/mode', { method: 'POST', body: { mode: m } });
    toast(d.message, d.ok === false);
    if (d.ok !== false) {
      mode.value = m;
      loadNodes(); // 组可能切换（global → GLOBAL），立即刷新
    }
  } catch (e) {
    toast(`切换失败: ${e instanceof Error ? e.message : e}`, true);
  }
}

function onPrefsChanged() {
  testUrl.value = getTestUrl();
}

watch(testUrl, (v) => setTestUrl(v));

// ---- 活动组：全局模式走 GLOBAL（mihomo 全局模式所有流量经 GLOBAL 组），其余走 PROXY ----
const activeGroup = computed(() => {
  if (mode.value === 'global' && nodes.value.global) {
    return { name: 'GLOBAL', now: nodes.value.global.now, all: nodes.value.global.all };
  }
  return { name: 'PROXY', now: nodes.value.now, all: nodes.value.all };
});

const visible = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return activeGroup.value.all.filter((n) => !q || n.toLowerCase().includes(q));
});

// GLOBAL 组里的特殊条目（非物理节点，无 provider meta）
const SPECIAL_BADGE: Record<string, string> = {
  DIRECT: '直连',
  REJECT: '拒绝',
  PROXY: '选择器组',
  Auto: 'url-test 组',
};

async function loadNodes() {
  if (inflight) return; // in-flight 合并：/proxies 转发 mihomo，卡时防堆积
  inflight = true;
  try {
    const d = await api<ProxiesData>('/proxies');
    nodes.value = d;
    mode.value = d.mode || 'rule'; // mode 与列表同源，避免两次请求
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

function typeBadge(name: string): string {
  return SPECIAL_BADGE[name] || metaOf(name)?.type || '';
}

function badgeClass(r: ProxyTestResult): string {
  if (!r.ok) return 'fail';
  const l = r.latency ?? 0;
  if (l < 300) return 'good';
  if (l < 1000) return 'mid';
  return 'slow';
}

// 全局模式下 GLOBAL 只含特殊条目，无物理节点可测
const canTest = computed(() => mode.value !== 'global' && activeGroup.value.all.length > 0);

async function runTest(selected: boolean) {
  if (testing.value || !canTest.value) return;
  // selected=true 只测当前搜索过滤后可见的节点，否则测全部
  const names = selected ? visible.value : activeGroup.value.all;
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
  const g = activeGroup.value;
  try {
    const d = await api<ProxySetResult>('/proxy-set', { method: 'POST', body: { name, group: g.name } });
    toast(d.message, d.ok === false);
    if (d.ok !== false) loadNodes(); // 立即刷新当前选中态
  } catch (e) {
    toast(`切换失败: ${e instanceof Error ? e.message : e}`, true);
  }
}

onMounted(() => {
  loadNodes();
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
    <!-- 标题行：活动代理组 + 当前选择 + 模式切换（参考 Clash Verge 布局） -->
    <div class="np-header">
      <div class="np-title">
        <h2>代理组 · {{ activeGroup.name }}</h2>
        <span v-if="activeGroup.now" class="np-now">当前：{{ activeGroup.now }}</span>
      </div>
      <div class="mode-switch" role="group" aria-label="代理模式">
        <button :class="{ active: mode === 'rule' }" @click="setMode('rule')">规则</button>
        <button :class="{ active: mode === 'global' }" @click="setMode('global')">全局</button>
        <button :class="{ active: mode === 'direct' }" @click="setMode('direct')">直连</button>
      </div>
    </div>

    <!-- 模式提示 -->
    <div v-if="mode === 'direct'" class="mode-note direct">
      ⚠️ 直连模式：所有流量直连，代理不生效。下方列表仅供选择，切回「规则」模式后才按 PROXY 组走代理。
    </div>
    <div v-else-if="mode === 'global'" class="mode-note global">
      ℹ️ 全局模式：所有流量（含国内）经 GLOBAL 组。选择 PROXY 组 = 走 PROXY 内当前节点；选择 DIRECT = 全直连。
    </div>

    <!-- 工具栏：搜索 + 测速 URL + 测试按钮 -->
    <div class="row np-toolbar">
      <input type="text" v-model="filter" class="np-search" placeholder="搜索…" />
      <input
        type="url"
        v-model="testUrl"
        class="np-url"
        placeholder="测速 URL（默认 Google 204）"
        :disabled="mode === 'global'"
      />
      <button :disabled="!canTest || testing" :title="mode === 'global' ? '全局模式无物理节点可测' : ''" @click="runTest(true)">
        测试选中
      </button>
      <button class="primary" :disabled="!canTest || testing" :title="mode === 'global' ? '全局模式无物理节点可测' : ''" @click="runTest(false)">
        测试全部
      </button>
    </div>

    <!-- 节点卡片网格（Clash Verge 风格） -->
    <div class="node-grid" v-if="!loadError">
      <div v-if="!visible.length" class="node-empty">
        {{ activeGroup.all.length ? '无匹配节点' : '暂无节点（mihomo 未运行？）' }}
      </div>
      <div
        v-for="n in visible"
        :key="n"
        :class="['node-card', { current: n === activeGroup.now }]"
        :title="n"
        @click="setNode(n)"
      >
        <div class="nc-top">
          <span class="nc-name">{{ n }}</span>
          <span v-if="n === activeGroup.now" class="nc-check">✓</span>
        </div>
        <div class="nc-badges">
          <span v-if="typeBadge(n)" class="badge">{{ typeBadge(n) }}</span>
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
