<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '@/api/client';
import { useToast } from '@/composables/useToast';
import { getTestUrl, setTestUrl, PrefsEvent } from '@/utils/prefs';
import type { ProxiesData, ProxyGroupView, ProxyTestData, ProxyTestResult, ProxySetResult, ModeResult } from '@/api/types';

const toast = useToast();

const data = ref<ProxiesData | null>(null);
const filter = ref('');
const testUrl = ref(getTestUrl());
const testResults = ref<Record<string, ProxyTestResult>>({});
const testing = ref(false);
const testStatus = ref('');
const loadError = ref('');
let inflight = false;
let timer: ReturnType<typeof setInterval> | null = null;

const groups = computed<ProxyGroupView[]>(() => data.value?.groups ?? []);
const mode = computed(() => data.value?.mode || 'rule');

// ---- 代理模式切换（规则/全局/直连）----
async function setMode(m: string) {
  if (m === mode.value) return;
  try {
    const d = await api<ModeResult>('/mode', { method: 'POST', body: { mode: m } });
    toast(d.message, d.ok === false);
    if (d.ok !== false) loadNodes(true); // 立即刷新（全局模式行为变化）
  } catch (e) {
    toast(`切换失败: ${e instanceof Error ? e.message : e}`, true);
  }
}

function onPrefsChanged() {
  testUrl.value = getTestUrl();
}
watch(testUrl, (v) => setTestUrl(v));

// ---- 组/成员展示 ----
const GROUP_ICON: Record<string, string> = { Selector: '🎛️', URLTest: '⚡', Fallback: '🛟', LoadBalance: '⚖️' };
const TYPE_LABEL: Record<string, string> = { Selector: 'selector', URLTest: 'url-test', Fallback: 'fallback', LoadBalance: 'load-balance' };
const SPECIAL_BADGE: Record<string, string> = { DIRECT: '直连', REJECT: '拒绝' };

const groupNames = computed(() => new Set(groups.value.map((g) => g.name)));
const visibleMembers = (g: ProxyGroupView): string[] => {
  const q = filter.value.trim().toLowerCase();
  return g.all.filter((n) => !q || n.toLowerCase().includes(q));
};
const visibleGroups = computed(() => groups.value.filter((g) => visibleMembers(g).length > 0));
const totalMembers = computed(() => groups.value.reduce((s, g) => s + g.all.length, 0));

async function loadNodes(force = false) {
  if (inflight && !force) return; // in-flight 合并：转发 mihomo，卡时防堆积
  inflight = true;
  try {
    data.value = await api<ProxiesData>('/proxies');
    loadError.value = '';
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    inflight = false;
  }
}

function isNode(name: string): boolean {
  return Boolean(data.value?.meta?.[name]);
}
function badgeOf(name: string): string {
  if (SPECIAL_BADGE[name]) return SPECIAL_BADGE[name];
  if (groupNames.value.has(name)) return '组';
  return data.value?.meta?.[name]?.type || '';
}
function badgeClass(r: ProxyTestResult): string {
  if (!r.ok) return 'fail';
  const l = r.latency ?? 0;
  if (l < 300) return 'good';
  if (l < 1000) return 'mid';
  return 'slow';
}

// ---- 测速（mihomo 原生 healthcheck，只测物理节点，组/特殊项不可测）----
function testableIn(g: ProxyGroupView): string[] {
  return g.all.filter(isNode);
}
const allTestable = computed(() => {
  const s = new Set<string>();
  for (const g of groups.value) for (const n of testableIn(g)) s.add(n);
  return [...s];
});

async function runTest(names: string[]) {
  if (testing.value) return;
  if (names.length === 0) return toast('没有可测试的节点（组/特殊项不可测速）', true);
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
  }
}

// ---- 切换组内选择 ----
async function setNode(name: string, group: string) {
  try {
    const d = await api<ProxySetResult>('/proxy-set', { method: 'POST', body: { name, group } });
    toast(d.message, d.ok === false);
    if (d.ok !== false) loadNodes(true);
  } catch (e) {
    toast(`切换失败: ${e instanceof Error ? e.message : e}`, true);
  }
}

onMounted(() => {
  loadNodes();
  timer = setInterval(() => loadNodes(), 3000);
  window.addEventListener(PrefsEvent, onPrefsChanged);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
  window.removeEventListener(PrefsEvent, onPrefsChanged);
});
</script>

<template>
  <div>
    <!-- 顶部：标题 + 模式切换 + 测试工具栏 -->
    <div class="card">
      <div class="np-header">
        <div class="np-title">
          <h2>代理组</h2>
          <span class="count">{{ groups.length }}</span>
          <span v-if="totalMembers" class="np-total">{{ totalMembers }} 个成员</span>
        </div>
        <div class="mode-switch" role="group" aria-label="代理模式">
          <button :class="{ active: mode === 'rule' }" @click="setMode('rule')">规则</button>
          <button :class="{ active: mode === 'global' }" @click="setMode('global')">全局</button>
          <button :class="{ active: mode === 'direct' }" @click="setMode('direct')">直连</button>
        </div>
      </div>

      <div v-if="mode === 'direct'" class="mode-note direct">
        ⚠️ 直连模式：所有流量直连，代理不生效。组内选择仍保留，切回「规则」后按 PROXY 组走代理。
      </div>
      <div v-else-if="mode === 'global'" class="mode-note global">
        ℹ️ 全局模式：所有流量（含国内）经 <b>GLOBAL</b> 组出口。在 GLOBAL 里选 PROXY = 跟随 PROXY 组当前节点；选 DIRECT = 全直连。
      </div>

      <div class="row np-toolbar">
        <input type="text" v-model="filter" class="np-search" placeholder="搜索节点/组…" />
        <input type="url" v-model="testUrl" class="np-url" placeholder="测速 URL（默认 Google 204）" />
        <button class="primary" :disabled="testing || !allTestable.length" @click="runTest(allTestable)">
          测试全部 ({{ allTestable.length }})
        </button>
      </div>
    </div>

    <!-- 各代理组卡片 -->
    <div v-if="loadError" class="card"><div class="node-empty">{{ loadError }}</div></div>
    <template v-else>
      <div v-for="g in visibleGroups" :key="g.name" class="card group-card">
        <div class="group-head">
          <div class="gh-left">
            <span class="gh-icon">{{ GROUP_ICON[g.type] || '📦' }}</span>
            <h3 class="gh-name">{{ g.name }}</h3>
            <span class="gh-type">{{ TYPE_LABEL[g.type] || g.type }}</span>
          </div>
          <div class="gh-right">
            <span v-if="g.now" class="gh-now">当前：{{ g.now }}</span>
            <button
              class="small"
              :disabled="testing || !testableIn(g).length"
              :title="testableIn(g).length ? '测试此组物理节点' : '此组无物理节点可测'"
              @click="runTest(testableIn(g))"
            >
              测速 ({{ testableIn(g).length }})
            </button>
          </div>
        </div>

        <div class="node-grid">
          <div
            v-for="n in visibleMembers(g)"
            :key="g.name + n"
            :class="['node-card', { current: n === g.now }]"
            :title="n"
            @click="setNode(n, g.name)"
          >
            <div class="nc-top">
              <span class="nc-name">{{ n }}</span>
              <span v-if="n === g.now" class="nc-check">✓</span>
            </div>
            <div class="nc-badges">
              <span v-if="badgeOf(n)" class="badge">{{ badgeOf(n) }}</span>
              <span v-if="data?.meta?.[n]?.udp" class="badge">UDP</span>
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

        <div v-if="g.type === 'URLTest'" class="hint">
          url-test 自动选延迟最低的节点；手动点击会锁定该节点（再次点击同一节点解锁）
        </div>
      </div>

      <div v-if="!visibleGroups.length && groups.length" class="card">
        <div class="node-empty">无匹配节点</div>
      </div>
      <div v-if="!groups.length && !data" class="card">
        <div class="node-empty">加载节点中…</div>
      </div>
    </template>

    <!-- 订阅源定义但未在 mihomo 激活的组 -->
    <div v-if="data?.orphanGroups?.length" class="card orphan-card">
      <h2>订阅定义的组（未在 mihomo 激活）<span class="count">{{ data.orphanGroups.length }}</span></h2>
      <div v-for="g in data.orphanGroups" :key="g.name" class="orphan-item">
        <span class="orphan-name">{{ g.name }}</span>
        <span class="badge">{{ TYPE_LABEL[g.type] || g.type || '未知' }}</span>
        <span class="muted">{{ g.members.length }} 个成员</span>
      </div>
      <div class="hint">
        这些组定义在订阅源（<code>~/.config/mihomo/providers/*.yaml</code>）的 proxy-groups 段，但 mihomo 的
        proxy-providers 只导入节点、不导入组，所以未激活、不参与分流。
        规则页的 <code>MATCH,PROXY</code> 等规则引用的只能是上方已激活的组。
      </div>
    </div>

    <div v-if="testStatus" class="hint testing"><span class="dot warn"></span>{{ testStatus }}</div>
    <div class="hint">
      点击成员卡片 = 切换该组的选择（<code>clash set</code>）；列表每 3 秒自动刷新；测速走 mihomo 原生 healthcheck、并发、单项 10s 超时，不影响当前出口
    </div>
  </div>
</template>
