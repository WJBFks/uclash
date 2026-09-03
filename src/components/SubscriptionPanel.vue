<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '@/api/client';
import { useToast } from '@/composables/useToast';
import type {
  ImportData,
  SubActivateData,
  SubDeleteData,
  SubProviderCard,
  SubRefreshData,
  SubUserinfo,
  SubUserinfoData,
} from '@/api/types';

const toast = useToast();

const providers = ref<SubProviderCard[]>([]);
const loading = ref(true);
const refreshing = ref(false);
const lastSummary = ref('');
const usageLoading = ref<Set<string>>(new Set());

const impUrl = ref('');
const impName = ref('');
const impBusy = ref(false);
const impMsg = ref<{ ok: boolean; text: string } | null>(null);
const activating = ref('');

async function loadSubs() {
  try {
    const d = await api<{ providers: SubProviderCard[] }>('/subscriptions');
    providers.value = d.providers ?? [];
  } catch {
    providers.value = [];
  } finally {
    loading.value = false;
  }
}

/** 用量/到期信息：先取列表返回的缓存值，缺失时懒加载（后端拉取订阅 URL 响应头，10 分钟缓存） */
async function loadUserinfo(p: SubProviderCard, force = false) {
  if (p.userinfo && !force) return;
  usageLoading.value.add(p.name);
  try {
    const qs = force ? 'force=1' : '';
    const d = await api<SubUserinfoData>(
      `/subscriptions/userinfo?name=${encodeURIComponent(p.name)}${qs}`,
      { timeout: 25000 },
    );
    const cur = providers.value.find((x) => x.name === p.name);
    if (cur) cur.userinfo = d.userinfo;
  } catch {
    // 拉取失败（订阅不可达等）：不显示用量，不打断页面
  } finally {
    usageLoading.value.delete(p.name);
  }
}

async function doImport(mode: 'update' | 'create') {
  const url = impUrl.value.trim();
  if (!url) return toast('请先填写订阅链接', true);
  const name = impName.value.trim();
  if (mode === 'create' && !name) return toast('新建需填写 provider 名', true);
  const what = mode === 'create' ? `新增订阅源「${name}」` : '更新默认订阅源 mysub';
  if (!confirm(`确认${what}？\n\nURL: ${url}\n\n将写入 ~/.config/mihomo/config.yaml（自动备份，失败自动回滚），随后热加载。`)) return;
  impBusy.value = true;
  impMsg.value = { ok: true, text: '写入配置中…' };
  try {
    const d = await api<ImportData>('/import', {
      method: 'POST',
      body: { url, provider: mode === 'create' ? name : '', reload: true },
      timeout: 120000,
    });
    impMsg.value = { ok: true, text: d.message };
    toast(d.message);
    impUrl.value = '';
    if (mode !== 'create') impName.value = '';
    await loadSubs();
    for (const p of providers.value) await loadUserinfo(p, true);
  } catch (e) {
    impMsg.value = { ok: false, text: e instanceof Error ? e.message : String(e) };
  } finally {
    impBusy.value = false;
  }
}

async function refreshSubs() {
  refreshing.value = true;
  lastSummary.value = '';
  try {
    const d = await api<SubRefreshData>('/subscriptions/refresh', { method: 'POST', timeout: 120000 });
    lastSummary.value = d.summary;
    toast(d.summary);
    await loadSubs();
    for (const p of providers.value) await loadUserinfo(p, true);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  } finally {
    refreshing.value = false;
  }
}

async function copyLink(url: string, from: string) {
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    toast(`已复制「${from}」的订阅链接`);
  } catch {
    // 非安全上下文等场景回退
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast(`已复制「${from}」的订阅链接`);
    } catch {
      toast('复制失败', true);
    }
    document.body.removeChild(ta);
  }
}

async function delSub(p: SubProviderCard) {
  if (!confirm(`确认删除订阅源「${p.name}」？\n\n将从 config.yaml 移除其声明（自动备份）、删除本地缓存文件并热加载；引用它的订阅组会被同步清理。`)) return;
  try {
    const d = await api<SubDeleteData>('/subscriptions/delete', { method: 'POST', body: { name: p.name }, timeout: 120000 });
    toast(d.message);
    await loadSubs();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  }
}

/** 注入主配置（独占激活）：让 PROXY/Auto 等主配置组的 use 引用指向该订阅源 */
async function activate(p: SubProviderCard) {
  if (p.active) return;
  if (!confirm(`确认将订阅源「${p.name}」注入主配置？\n\n会把主配置组 PROXY/Auto 的 use 引用切到它${p.declared ? '' : '（并补写 config.yaml 声明）'}（自动备份，失败自动回滚），随后热加载并同步订阅组。\n\n当前激活的源将转为待机（声明与缓存保留，随时可再激活）。`)) return;
  activating.value = p.name;
  try {
    const d = await api<SubActivateData>('/subscriptions/activate', { method: 'POST', body: { name: p.name }, timeout: 120000 });
    toast(d.message);
    await loadSubs();
    for (const x of providers.value) if (x.active) await loadUserinfo(x, true);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  } finally {
    activating.value = '';
  }
}

// ---- 展示辅助 ----
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url || '（无链接）';
  }
}

function relTime(ts: number): string {
  if (!ts) return '尚未更新';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚更新';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(ts).toLocaleDateString();
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(2)}${units[i]}`;
}

function usageOf(p: SubProviderCard): { usedText: string; pct: number; expire: string } | null {
  const u: SubUserinfo | null = p.userinfo;
  if (!u) return null;
  const used = (u.upload ?? 0) + (u.download ?? 0);
  const pct = u.total ? Math.max(0, Math.min(100, (used / u.total) * 100)) : 0;
  return {
    usedText: `${fmtBytes(used)} / ${fmtBytes(u.total)}`,
    pct,
    expire: u.expire ? new Date(u.expire * 1000).toLocaleDateString() : '',
  };
}

function intervalText(iv: number): string {
  if (!iv) return '';
  const h = iv / 3600;
  return Number.isInteger(h) ? `每 ${h}h 自动更新` : `每 ${Math.round(iv / 60)}min 自动更新`;
}

onMounted(async () => {
  await loadSubs();
  for (const p of providers.value) await loadUserinfo(p);
});
</script>

<template>
  <div>
    <!-- 顶部：导入订阅源（Verge 风格：链接输入 + 导入 + 新建） -->
    <div class="card">
      <h2>订阅管理 <span class="count">{{ providers.length }}</span></h2>
      <div class="si-row">
        <input
          v-model="impUrl"
          type="url"
          class="si-input"
          placeholder="订阅文件链接（https://…）"
          @keyup.enter="doImport(impName.trim() ? 'create' : 'update')"
        />
        <button class="btn" :disabled="!impUrl.trim() || impBusy" title="导入：更新默认订阅源 mysub" @click="doImport('update')">
          导入
        </button>
        <button class="primary" :disabled="impBusy" title="新建订阅源（需填写下方 provider 名）" @click="doImport('create')">
          新建
        </button>
      </div>
      <div class="si-row">
        <input
          v-model="impName"
          type="text"
          class="si-input"
          placeholder="新建订阅源的 provider 名（留空时「导入」= 更新默认源 mysub）"
        />
        <button class="btn" :disabled="refreshing" @click="refreshSubs">{{ refreshing ? '刷新中…' : '⟳ 刷新全部' }}</button>
      </div>
      <div v-if="impMsg" :class="['si-msg', impMsg.ok ? 'ok' : 'fail']">{{ impMsg.text }}</div>
      <div v-if="lastSummary && !refreshing" class="si-msg muted">{{ lastSummary }}</div>
    </div>

    <!-- 订阅源卡片 -->
    <div v-if="loading" class="card">
      <div class="node-empty">加载中…</div>
    </div>
    <div v-else-if="!providers.length" class="card">
      <div class="node-empty">未配置订阅源</div>
    </div>
    <div v-else class="sub-grid">
      <div v-for="p in providers" :key="p.name" :class="['card', 'sub-card', { active: p.active }]">
        <div class="sc-head">
          <span class="sc-icon">📄</span>
          <span class="sc-name" :title="p.name">{{ p.name }}</span>
          <span v-if="p.active" class="sc-badge on">使用中</span>
          <span v-else-if="!p.declared" class="sc-badge">未声明</span>
          <span class="sc-spacer" />
          <button
            class="icon-btn"
            :disabled="refreshing"
            title="刷新订阅源（mihomo 无单源刷新端点，将刷新全部订阅）"
            @click="refreshSubs()"
          >
            ⟳
          </button>
          <button class="icon-btn" title="复制订阅链接" @click="copyLink(p.url, p.name)">⧉</button>
          <button class="icon-btn danger" title="删除订阅源" @click="delSub(p)">✕</button>
        </div>
        <div class="sc-meta">
          <span class="sc-host" :title="p.url">{{ hostOf(p.url) }}</span>
          <span class="sc-rel">{{ relTime(p.updated) }}</span>
        </div>
        <div v-if="usageOf(p)" class="sc-usage">
          <div class="sc-usage-row">
            <span>{{ usageOf(p)!.usedText }}</span>
            <span v-if="usageOf(p)!.expire" class="sc-expire">{{ usageOf(p)!.expire }}</span>
          </div>
          <div class="sc-bar">
            <div class="sc-bar-fill" :class="{ warn: usageOf(p)!.pct > 80 }" :style="{ width: usageOf(p)!.pct + '%' }" />
          </div>
        </div>
        <div v-else-if="usageLoading.has(p.name)" class="sc-usage">
          <div class="muted">用量加载中…</div>
        </div>
        <div class="sc-foot">
          <span>{{ p.nodes }} 个节点</span>
          <span v-if="p.groupCount"> · {{ p.groupCount }} 组</span>
          <span v-if="p.ruleCount"> · {{ p.ruleCount }} 条规则</span>
          <span v-if="intervalText(p.interval)" class="muted"> · {{ intervalText(p.interval) }}</span>
        </div>
        <button v-if="!p.active" class="btn inject-btn" :disabled="activating === p.name" @click="activate(p)">
          {{ activating === p.name ? '激活中…' : '⚡ 注入主配置（设为当前激活源）' }}
        </button>
      </div>
    </div>

    <!-- 订阅组自动同步说明 -->
    <div class="card">
      <h2>订阅组自动同步</h2>
      <p class="muted">
        mihomo 的 proxy-providers 只导入订阅里的节点，不导入其代理组。刷新/导入订阅时，本系统会自动把订阅
        yaml 中定义的 proxy-groups 注入主配置并热加载生效（写前自动备份，热加载失败自动回滚，各组当前选择在
        加载后恢复）。各组详情见「代理组」页。
      </p>
    </div>
  </div>
</template>
