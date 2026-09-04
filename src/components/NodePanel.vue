<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '@/api/client';
import { useToast } from '@/composables/useToast';
import { getTestUrl, setTestUrl, PrefsEvent, getGroupFilter, setGroupFilter } from '@/utils/prefs';
import type { ProxiesData, ProxyGroupView, ProxyTestData, ProxyTestResult, ProxySetResult, ModeResult } from '@/api/types';
import HelpTip from '@/components/HelpTip.vue';

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

// ---- 「?」hover 说明：解释当前配置下每个组的作用与整体流量走向 ----
const TYPE_DESC: Record<string, string> = {
  Selector: '手动选择组：点谁谁生效',
  URLTest: '自动测速组：定时 ping 成员，自动选最快节点（手动点击会锁定）',
  Fallback: '故障回退组：当前节点不通时自动切下一个',
  LoadBalance: '负载均衡组：流量在成员间轮流分发',
};

function ruleLabel(r: { type: string; payload: string }): string {
  // 兼容两种写法：mihomo API（Match/GeoIP/IPCIDR）与 yaml 原文（MATCH/GEOIP/IP-CIDR）
  const t = (r.type || '').toLowerCase().replace(/-/g, '');
  const p = r.payload;
  if (t === 'match') return '其余所有流量（兜底）';
  if (t === 'fallback') return '未匹配流量（兜底）';
  if (t === 'domain') return `域名 ${p}`;
  if (t === 'domainsuffix') return `域名 ${p}（含子域）`;
  if (t === 'domainkeyword') return `域名包含 ${p}`;
  if (t === 'domainregex') return `域名匹配 ${p}`;
  if (t === 'geosite') return `站点 ${p}`;
  if (t === 'geoip') return p.toUpperCase() === 'CN' ? '中国大陆 IP' : `IP 归属 ${p}`;
  if (t === 'ipcidr' || t === 'ipcidr6') return `网段 ${p}`;
  if (t === 'srcipcidr' || t === 'srcipcidr6') return `来源网段 ${p}`;
  if (t === 'dstport') return `目标端口 ${p}`;
  if (t === 'srcport') return `来源端口 ${p}`;
  if (t === 'processname' || t === 'processpath') return `进程 ${p}`;
  return p ? `${r.type} ${p}` : r.type;
}

const rulesOf = (name: string) => (data.value?.rules ?? []).filter((r) => r.proxy === name);
const subRulesOf = (name: string) => (data.value?.subRules ?? []).filter((r) => r.target === name);

// ---- 组内规则显示（哪些地址会被路由到该组）----
const RULES_PREVIEW = 8;
const expandedRules = ref<Record<string, boolean>>({});
function toggleRules(name: string) {
  expandedRules.value[name] = !expandedRules.value[name];
}
type RuleState = { kind: 'active' | 'sub' | 'none'; cls: string; label: string; rules: { type: string; payload: string }[] };
function groupRuleState(g: ProxyGroupView): RuleState {
  const active = rulesOf(g.name);
  if (active.length) return { kind: 'active', cls: 'ok', label: `生效中 · ${active.length}`, rules: active };
  const sub = subRulesOf(g.name);
  if (sub.length) return { kind: 'sub', cls: 'warn', label: `订阅定义 · 未生效 · ${sub.length}`, rules: sub };
  return { kind: 'none', cls: 'muted', label: '无规则', rules: [] };
}
function hiddenRuleCount(g: ProxyGroupView): number {
  const n = groupRuleState(g).rules.length;
  return expandedRules.value[g.name] ? 0 : Math.max(0, n - RULES_PREVIEW);
}
function ruleNoneText(g: ProxyGroupView): string {
  if (g.name === 'GLOBAL') return '全局模式入口：全局模式下所有流量（含国内）走本组当前选择；规则/直连模式不参与分流';
  return '无规则指向此组 —— 流量不会自动进来；仅在全局模式手动选本组、或添加规则后才承载流量';
}

const globalNow = computed(() => data.value?.globalNow ?? groups.value.find((x) => x.name === 'GLOBAL')?.now ?? '');
const proxyNow = computed(() => data.value?.proxyNow ?? groups.value.find((x) => x.name === 'PROXY')?.now ?? '');

function groupDesc(g: ProxyGroupView): string {
  const lines: string[] = [TYPE_DESC[g.type] || `类型：${g.type}`];
  lines.push(`当前选择：${g.now || '（未选择）'}`);
  lines.push(`成员：${g.all.length} 个`);
  if (g.name === 'GLOBAL') {
    lines.push('流量路径：仅「全局模式」下生效——所有流量（含国内）走本组当前选择；规则/直连模式不参与分流');
    lines.push('选 PROXY = 跟随主代理组；选 DIRECT = 全部直连');
    return lines.join('\n');
  }
  if (mode.value === 'direct') {
    lines.push('流量路径：当前直连模式，所有流量直连，本组不参与分流');
    return lines.join('\n');
  }
  if (mode.value === 'global') {
    lines.push(
      globalNow.value === g.name
        ? '流量路径：全局模式下 GLOBAL 指向本组，所有流量走本组当前选择'
        : `流量路径：GLOBAL 当前指向 ${globalNow.value || '（无）'}，本组未承载流量；把 GLOBAL 切到本组才生效`,
    );
    return lines.join('\n');
  }
  // 规则模式
  const rs = rulesOf(g.name);
  if (rs.length) {
    lines.push(`流量路径：有 ${rs.length} 条规则指向本组 → ${rs.map(ruleLabel).join('；')}`);
  } else {
    lines.push('流量路径：当前无规则指向本组，不参与日常分流');
    lines.push('想让流量走它：切「全局模式」选本组，或添加规则（如 Telegram 域名 → ✈️Telegram）');
  }
  return lines.join('\n');
}

function overviewDesc(): string {
  const names: Record<string, string> = { rule: '规则', global: '全局', direct: '直连' };
  const lines: string[] = [`当前模式：${names[mode.value] || mode.value}。流量怎么走：`];
  if (mode.value === 'direct') {
    lines.push('• 所有流量直连，代理组不生效（各组选择保留，切回后恢复）');
    return lines.join('\n');
  }
  if (mode.value === 'global') {
    lines.push(`• 所有流量（含国内）→ GLOBAL 组当前选择：${globalNow.value || '（无）'}`);
    if (globalNow.value === 'DIRECT') lines.push('• 即当前全部直连');
    else if (globalNow.value === 'PROXY') lines.push(`• 即全部流量走 PROXY 组当前节点：${proxyNow.value || '-'}`);
    return lines.join('\n');
  }
  // 规则模式：按目标组聚合规则
  const byTarget = new Map<string, string[]>();
  for (const r of data.value?.rules ?? []) {
    const arr = byTarget.get(r.proxy) || [];
    arr.push(ruleLabel(r));
    byTarget.set(r.proxy, arr);
  }
  for (const [target, labels] of byTarget) {
    const extra = target === 'DIRECT' ? '（直连）' : target === 'PROXY' ? `（当前节点：${proxyNow.value || '-'}）` : `（组 ${target}）`;
    lines.push(`• ${labels.join('；')} → ${target}${extra}`);
  }
  const referenced = new Set(byTarget.keys());
  const idle = groups.value.filter((g) => g.name !== 'GLOBAL' && !referenced.has(g.name)).map((g) => g.name);
  if (idle.length) lines.push(`未接入分流的组（仅手动切换/全局模式用）：${idle.join('、')}`);
  return lines.join('\n');
}

const modeDesc =
  '规则：按规则表分流（当前：内网/国内直连，其他走 PROXY 组）\n' +
  '全局：所有流量（含国内）走 GLOBAL 组当前选择\n' +
  '直连：所有流量直连，代理组不生效\n' +
  '每个组标题旁的「?」悬停可看该组具体作用与流量路径';

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
const TYPE_LABEL: Record<string, string> = { Selector: 'Selector', URLTest: 'URLTest', Fallback: 'Fallback', LoadBalance: 'LoadBalance' };
const SPECIAL_BADGE: Record<string, string> = { DIRECT: '直连', REJECT: '拒绝' };

const groupNames = computed(() => new Set(groups.value.map((g) => g.name)));
const groupNowMap = computed(() => new Map(groups.value.map((g) => [g.name, g.now])));
const visibleMembers = (g: ProxyGroupView): string[] => {
  const q = filter.value.trim().toLowerCase();
  return g.all.filter((n) => !q || n.toLowerCase().includes(q));
};

// ---- 「显示组」筛选：单选（只看一个）/ 多选（看所有勾选的组）；模式与勾选均持久化到 localStorage ----
const filterMode = ref<'single' | 'multi'>('single'); // 默认单选
const selectedGroups = ref<Set<string>>(new Set());
const seenGroups = new Set<string>();
let filterReady = false;

function persistGroupFilter() {
  setGroupFilter({ mode: filterMode.value, selected: [...selectedGroups.value] });
}
function toggleGroup(name: string) {
  if (filterMode.value === 'single') {
    selectedGroups.value = new Set([name]);
  } else {
    const s = new Set(selectedGroups.value);
    if (s.has(name)) s.delete(name);
    else s.add(name);
    selectedGroups.value = s;
  }
  persistGroupFilter();
}
function setFilterMode(m: 'single' | 'multi') {
  if (filterMode.value === m) return;
  filterMode.value = m;
  if (m === 'single') {
    if (selectedGroups.value.size > 1) {
      selectedGroups.value = new Set([...selectedGroups.value][0]);
    } else if (selectedGroups.value.size === 0 && groups.value.length) {
      selectedGroups.value = new Set([groups.value[0].name]); // 空选时兑底第一个组
    }
  }
  persistGroupFilter();
}
// 首次拿到组列表时恢复 localStorage 偏好（无则默认：单选 + PROXY）；之后新组仅多选模式默认勾选，消失的组清掉；单选项消失时兑底
function reconcileGroupFilter() {
  if (!groups.value.length) return;
  let changed = false;
  if (!filterReady) {
    const saved = getGroupFilter();
    if (saved) {
      filterMode.value = saved.mode;
      selectedGroups.value = new Set(saved.selected);
    } else {
      filterMode.value = 'single';
      const def = groups.value.find((g) => g.name === 'PROXY') ?? groups.value[0];
      selectedGroups.value = new Set([def.name]);
      changed = true; // 默认值也写入 localStorage，后续访问走恢复路径
    }
    filterReady = true;
  }
  for (const g of groups.value) {
    if (!seenGroups.has(g.name) && !selectedGroups.value.has(g.name) && filterMode.value === 'multi') {
      selectedGroups.value.add(g.name);
      changed = true;
    }
    seenGroups.add(g.name);
  }
  for (const n of [...selectedGroups.value]) {
    if (!groupNames.value.has(n)) {
      selectedGroups.value.delete(n);
      changed = true;
    }
  }
  if (filterMode.value === 'single' && selectedGroups.value.size !== 1) {
    selectedGroups.value = new Set([groups.value[0].name]);
    changed = true;
  }
  if (changed) persistGroupFilter();
}

const isGlobalMode = computed(() => data.value?.mode === 'global');
const visibleGroups = computed(() =>
  // 全局模式不按「显示组」筛选，展示全部组
  groups.value.filter((g) =>
    (isGlobalMode.value || selectedGroups.value.has(g.name)) && visibleMembers(g).length > 0,
  ),
);
const totalMembers = computed(() => groups.value.reduce((s, g) => s + g.all.length, 0));

async function loadNodes(force = false) {
  if (inflight && !force) return; // in-flight 合并：转发 mihomo，卡时防堆积
  inflight = true;
  try {
    data.value = await api<ProxiesData>('/proxies');
    loadError.value = '';
    reconcileGroupFilter();
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    inflight = false;
  }
}

function isNode(name: string): boolean {
  return Boolean(data.value?.meta?.[name]);
}
function isGroupMember(name: string): boolean {
  return groupNames.value.has(name);
}
function badgeOf(name: string): string {
  if (SPECIAL_BADGE[name]) return SPECIAL_BADGE[name];
  if (isGroupMember(name)) {
    // 成员本身是组：显示组类型（Selector/URLTest/…）
    const g = groups.value.find((x) => x.name === name);
    return TYPE_LABEL[g?.type || ''] || 'Selector';
  }
  return data.value?.meta?.[name]?.type || '';
}
function groupNow(name: string): string {
  return groupNowMap.value.get(name) || '';
}
// 延迟颜色（Verge 同款）：绿(<300) → 蓝(300–600) → 橙黄(≥600) → 红(失败)
function latClass(r: ProxyTestResult): string {
  if (!r.ok) return 'err';
  const l = r.latency ?? 0;
  if (l < 300) return 'fast';
  if (l < 600) return 'mid';
  return 'slow';
}

// ---- 全局模式：扁平「全局代理」页（全部节点 + 全部组平铺，参考 Clash Verge）----
const flatSpecials = [
  { name: 'DIRECT', label: '直连', tip: '全局直连：所有流量不走代理' },
  { name: 'REJECT', label: '拒绝', tip: '丢弃所有流量' },
];
const flatChain = computed<string[]>(() => data.value?.flatChain ?? []);
// 全局出口链路末端（实际生效的节点/直连/拒绝）
const flatEnd = computed(() => {
  const c = flatChain.value;
  return c.length ? c[c.length - 1] : '';
});
// GLOBAL 直接指向的组（链路第二环），用于高亮组卡片
const flatGroup = computed(() => {
  const g = flatChain.value[1] ?? '';
  return groupNames.value.has(g) ? g : '';
});
const flatNodes = computed<string[]>(() => data.value?.flatNodes ?? []);
const flatVisibleNodes = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return flatNodes.value.filter((n) => !q || n.toLowerCase().includes(q));
});
const flatVisibleGroups = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return groups.value.filter((g) => !q || g.name.toLowerCase().includes(q));
});

function setGlobal(target: string) {
  setNode(target, 'GLOBAL');
}
// 点物理节点：找包含它的组（优先 GLOBAL 当前指向的组），切组内选择 + 必要时 GLOBAL 跟随
async function setGlobalNode(node: string) {
  const host =
    groups.value.find((g) => g.name === flatGroup.value && g.all.includes(node)) ??
    groups.value.find((g) => g.all.includes(node));
  if (!host) {
    toast('该节点不属于当前显示的任何代理组，无法设为全局出口', true);
    return;
  }
  try {
    const d1 = await api<ProxySetResult>('/proxy-set', { method: 'POST', body: { name: node, group: host.name } });
    if (d1.ok === false) {
      toast(d1.message || `切换 ${host.name} 失败`, true);
      return;
    }
    if (flatGroup.value && flatGroup.value !== host.name) {
      const d2 = await api<ProxySetResult>('/proxy-set', { method: 'POST', body: { name: host.name, group: 'GLOBAL' } });
      if (d2.ok === false) {
        toast(d2.message || `GLOBAL 切换到 ${host.name} 失败`, true);
        return;
      }
    }
    toast(`全局出口：${host.name} → ${node}`);
    loadNodes(true);
  } catch (e) {
    toast(`切换失败: ${e instanceof Error ? e.message : e}`, true);
  }
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
          <h2>{{ isGlobalMode ? '全局代理' : '代理组' }}</h2>
          <HelpTip :text="overviewDesc()" />
          <span class="count">{{ isGlobalMode ? flatSpecials.length + flatVisibleNodes.length + flatVisibleGroups.length : groups.length }}</span>
          <span v-if="!isGlobalMode && totalMembers" class="np-total">{{ totalMembers }} 个成员</span>
        </div>
        <div class="mode-switch-wrap">
          <div class="mode-switch" role="group" aria-label="代理模式">
            <button :class="{ active: mode === 'rule' }" @click="setMode('rule')">规则</button>
            <button :class="{ active: mode === 'global' }" @click="setMode('global')">全局</button>
            <button :class="{ active: mode === 'direct' }" @click="setMode('direct')">直连</button>
          </div>
          <HelpTip :text="modeDesc" />
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

      <div v-if="!isGlobalMode" class="row np-groupfilter">
        <span class="ngf-label">显示组</span>
        <div class="seg" role="group" aria-label="显示组模式">
          <button :class="{ active: filterMode === 'single' }" @click="setFilterMode('single')">单选</button>
          <button :class="{ active: filterMode === 'multi' }" @click="setFilterMode('multi')">多选</button>
        </div>
        <div class="ngf-chips">
          <button
            v-for="g in groups"
            :key="g.name"
            :class="['chip', { on: selectedGroups.has(g.name) }]"
            :title="`勾选/取消显示组 ${g.name}`"
            @click="toggleGroup(g.name)"
          >{{ g.name }}</button>
        </div>
      </div>
    </div>

    <div v-if="loadError" class="card"><div class="node-empty">{{ loadError }}</div></div>
    <template v-else>
      <!-- 全局模式：扁平「全局代理」页 —— 特殊项 + 全部节点 + 全部组 平铺（参考 Clash Verge） -->
      <div v-if="isGlobalMode" class="card">
        <div v-if="!flatVisibleNodes.length && !flatVisibleGroups.length" class="node-empty">无匹配节点</div>
        <div v-else class="node-grid">
          <div
            v-for="s in flatSpecials"
            :key="'sp:' + s.name"
            class="node-card"
            :class="{ current: flatEnd === s.name }"
            :title="s.tip"
            @click="setGlobal(s.name)"
          >
            <div class="nc-top">
              <span class="nc-name">{{ s.name }}</span>
              <span v-if="flatEnd === s.name" class="nc-check">✓</span>
            </div>
            <div class="nc-badges"><span class="badge">{{ s.label }}</span></div>
          </div>

          <div
            v-for="n in flatVisibleNodes"
            :key="'n:' + n"
            class="node-card"
            :class="{ current: flatEnd === n }"
            :title="`${n}（点击 = 全局流量经其所在组走该节点）`"
            @click="setGlobalNode(n)"
          >
            <div class="nc-top">
              <span class="nc-name">{{ n }}</span>
              <span class="nc-right">
                <span
                  v-if="testResults[n]"
                  :class="['nc-lat', latClass(testResults[n])]"
                  :title="testResults[n].ok ? '' : (testResults[n].error || '')"
                >{{ testResults[n].ok ? testResults[n].latency : 'Error' }}</span>
                <span v-if="flatEnd === n" class="nc-check">✓</span>
              </span>
            </div>
            <div class="nc-badges">
              <span v-if="data?.meta?.[n]?.type" class="badge">{{ data.meta[n].type }}</span>
              <span v-if="data?.meta?.[n]?.udp" class="badge">UDP</span>
            </div>
          </div>

          <div
            v-for="g in flatVisibleGroups"
            :key="'g:' + g.name"
            class="node-card"
            :class="{ current: flatGroup === g.name }"
            :title="`点击 = 全局出口切换到 ${g.name}`"
            @click="setGlobal(g.name)"
          >
            <div class="nc-top">
              <span class="nc-name">{{ g.name }}</span>
              <span class="nc-right">
                <span
                  v-if="testResults[g.now]"
                  :class="['nc-lat', latClass(testResults[g.now])]"
                  :title="`当前选择：${g.now} · ${testResults[g.now].ok ? '' : (testResults[g.now].error || '')}`"
                >{{ testResults[g.now].ok ? testResults[g.now].latency : 'Error' }}</span>
                <span v-if="g.now" class="nc-now" :title="`当前选择：${g.now}`">{{ g.now }}</span>
                <span v-if="flatGroup === g.name" class="nc-check">✓</span>
              </span>
            </div>
            <div class="nc-badges">
              <span class="badge grp">{{ TYPE_LABEL[g.type] || g.type }}</span>
            </div>
          </div>
        </div>
        <div class="hint">
          全局模式下所有流量经 GLOBAL 出口：点节点 = 全局流量经其所在组走该节点；点组 = 全局出口切到该组；DIRECT = 全直连，REJECT = 丢弃流量
        </div>
      </div>

      <!-- 规则/直连模式：按代理组卡片展示 -->
      <template v-else>
      <div v-for="g in visibleGroups" :key="g.name" class="card group-card">
        <div class="group-head">
          <div class="gh-left">
            <h3 class="gh-name" :title="g.name">{{ g.name }}</h3>
            <span class="gh-type">({{ TYPE_LABEL[g.type] || g.type }})</span>
            <HelpTip :text="groupDesc(g)" />
          </div>
          <div class="gh-right">
            <span v-if="g.now" class="gh-now">当前 {{ g.now }}</span>
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
              <span class="nc-right">
                <span
                  v-if="testResults[n]"
                  :class="['nc-lat', latClass(testResults[n])]"
                  :title="testResults[n].ok ? '' : (testResults[n].error || '')"
                >{{ testResults[n].ok ? testResults[n].latency : 'Error' }}</span>
                <span v-if="n === g.now" class="nc-check">✓</span>
              </span>
            </div>
            <div class="nc-badges">
              <span v-if="isGroupMember(n) && groupNow(n)" class="nc-now" :title="`当前选择：${groupNow(n)}`">{{ groupNow(n) }}</span>
              <span v-if="badgeOf(n)" :class="['badge', { grp: isGroupMember(n) }]">{{ badgeOf(n) }}</span>
              <span v-if="data?.meta?.[n]?.udp" class="badge">UDP</span>
            </div>
          </div>
        </div>

        <div v-if="g.name !== 'GLOBAL'" class="group-rules">
          <div class="gr-head" @click="toggleRules(g.name)">
            <span class="gr-title">路由规则</span>
            <span :class="['gr-badge', groupRuleState(g).cls]">{{ groupRuleState(g).label }}</span>
          </div>
          <template v-if="groupRuleState(g).rules.length">
            <div
              v-for="(r, i) in (expandedRules[g.name] ? groupRuleState(g).rules : groupRuleState(g).rules.slice(0, RULES_PREVIEW))"
              :key="g.name + i"
              class="gr-line"
            >
              <code class="gr-type">{{ r.type }}</code>
              <span class="gr-addr">{{ ruleLabel(r) }}</span>
            </div>
            <div v-if="hiddenRuleCount(g) > 0" class="gr-more" @click="toggleRules(g.name)">
              +{{ hiddenRuleCount(g) }} 条更多，点击展开
            </div>
            <div v-else-if="expandedRules[g.name] && groupRuleState(g).rules.length > RULES_PREVIEW" class="gr-more" @click="toggleRules(g.name)">
              收起
            </div>
          </template>
          <div v-else class="gr-none">{{ ruleNoneText(g) }}</div>
          <div v-if="groupRuleState(g).kind === 'sub'" class="gr-note">
            这些规则来自订阅源、尚未合并进主配置，合并后才会真正参与分流
          </div>
        </div>

        <div v-if="g.type === 'URLTest'" class="hint">
          url-test 自动选延迟最低的节点；手动点击会锁定该节点（再次点击同一节点解锁）
        </div>
      </div>

      <div v-if="!visibleGroups.length && groups.length" class="card">
        <div class="node-empty">{{ !selectedGroups.size ? '未勾选任何组 —— 请在上方「显示组」勾选要显示的代理组' : '无匹配节点' }}</div>
      </div>
      </template>
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
    <div v-if="isGlobalMode" class="hint">
      全局模式：所有流量经 GLOBAL 出口。点节点 = 经其所在组走该节点；点组 / DIRECT / REJECT = 切换全局出口。列表每 3 秒自动刷新
    </div>
    <div v-else class="hint">
      点击成员卡片 = 切换该组的选择（<code>clash set</code>）；列表每 3 秒自动刷新；标题旁的「?」悬停查看该组作用与流量路径；测速走 mihomo 原生 healthcheck、并发、单项 10s 超时，不影响当前出口
    </div>
  </div>
</template>
