<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '@/api/client';
import { useToast } from '@/composables/useToast';
import type { ProxiesData, ProxyTestData, ProxyTestResult, ProxySetResult } from '@/api/types';

const toast = useToast();

const nodes = ref<ProxiesData>({ now: '', all: [] });
const filter = ref('');
const testUrl = ref(localStorage.getItem('cw_test_url') || 'https://www.google.com/generate_204');
const testResults = ref<Record<string, ProxyTestResult>>({});
const testing = ref(false);
const testStatus = ref('');
const loadError = ref('');
let inflight = false;
let timer: ReturnType<typeof setInterval> | null = null;

watch(testUrl, (v) => localStorage.setItem('cw_test_url', v));

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
  timer = setInterval(loadNodes, 3000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="card">
    <h2>节点切换 <span class="count">{{ visible.length }}</span></h2>
    <div class="node-search">
      <input type="text" v-model="filter" placeholder="搜索节点名…" />
    </div>
    <div class="row test-row">
      <input
        type="url"
        v-model="testUrl"
        placeholder="测试链接（默认 https://www.google.com/generate_204）"
      />
      <button :disabled="testing" @click="runTest(true)">测试选中</button>
      <button class="primary" :disabled="testing" @click="runTest(false)">测试全部</button>
    </div>
    <div class="node-list">
      <div v-if="loadError" class="node-empty">{{ loadError }}</div>
      <div v-else-if="!visible.length" class="node-empty">
        {{ nodes.all.length ? '无匹配节点' : '暂无节点（mihomo 未运行？）' }}
      </div>
      <div
        v-for="n in visible"
        :key="n"
        :class="['node-item', { current: n === nodes.now }]"
        @click="setNode(n)"
      >
        <span class="name">{{ n }}</span>
        <span class="meta">
          <span v-if="testResults[n]" :class="['tag', badgeClass(testResults[n])]" :title="testResults[n].error || ''">
            {{ testResults[n].ok ? `${testResults[n].latency}ms` : `✗ ${(testResults[n].error || '').slice(0, 14)}` }}
          </span>
          <span v-if="n === nodes.now" class="tag cur">← 当前</span>
        </span>
      </div>
    </div>
    <div v-if="testStatus" class="hint testing"><span class="dot warn"></span>{{ testStatus }}</div>
    <div class="hint">
      点击节点立即切换（= <code>clash set</code>）；列表每 3 秒自动刷新；延迟测试走 mihomo 原生 healthcheck、并发、单项 10s 超时，不切换当前节点、互不干扰
    </div>
  </div>
</template>
