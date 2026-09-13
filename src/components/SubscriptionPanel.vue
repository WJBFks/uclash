<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '@/api/client';
import { useModalDialog } from '@/composables/useModalDialog';
import { useToast } from '@/composables/useToast';
import type {
  ImportData,
  ImportPreviewData,
  SubActivateData,
  SubDeleteData,
  SubProviderCard,
  SubRefreshData,
  SubUserinfo,
  SubUserinfoData,
} from '@/api/types';

const toast = useToast();
// Keep controller bindings distinct from static template-ref names. Vue treats a
// same-named setup binding as the template ref target and cannot assign the DOM node.
const editModal = useModalDialog('editDialog');
const importModal = useModalDialog('importDialog');

const providers = ref<SubProviderCard[]>([]);
/** 订阅列表：仅非内置源（内置「默认配置」不再展示，由「恢复默认」按钮承担其职责） */
const listProviders = computed(() => providers.value.filter((p) => !p.builtin));
const loading = ref(true);
const refreshing = ref(false);
const usageLoading = ref<Set<string>>(new Set());

const impUrl = ref('');
const impBusy = ref(false);
/** 添加订阅弹窗状态机：loading（拉取识别）→ merge（已存在同链接，询问合并）/ name（新源，填名确认）→ importing（写入热加载）→ error */
const impModal = ref<{
  stage: 'loading' | 'merge' | 'name' | 'importing' | 'error';
  existing?: { name: string; url: string };
  nodes?: number | null;
  detected?: boolean;
  warning?: string | null;
  msg?: string;
} | null>(null);
const newName = ref('');
const activating = ref('');
let importPreviewGeneration = 0;

async function loadSubs() {
  try {
    const d = await api<{ providers: SubProviderCard[] }>('/subscriptions');
    providers.value = d.providers ?? [];
  } catch {
    toast('订阅列表读取失败，请重试', true);
  } finally {
    loading.value = false;
  }
}

/** 用量/到期信息：先取列表返回的缓存值，缺失时懒加载（后端拉取订阅 URL 响应头，10 分钟缓存） */
async function loadUserinfo(p: SubProviderCard, force = false) {
  if (p.userinfo && !force) return;
  usageLoading.value.add(p.name);
  try {
    const qs = force ? '&force=1' : '';
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

const editing = ref<{ name: string; displayName: string; url: string; interval: number } | null>(null);
const editBusy = ref(false);
function editSub(p: SubProviderCard) {
  editModal.open(closeEditDialog);
  editing.value = { name: p.name, displayName: p.displayName || p.name, url: p.url, interval: p.interval || 86400 };
}
function closeEditDialog(force = false) {
  if (editBusy.value && !force) return;
  editing.value = null;
  editModal.close();
}
async function saveEdit() {
  if (!editing.value || !confirm('保存订阅设置并重载配置？可能短暂影响现有连接。')) return;
  editBusy.value = true;
  try { const d = await api<{ message: string }>('/subscriptions/edit', { method: 'POST', body: { ...editing.value, confirm: true }, timeout: 90000 }); toast(d.message); closeEditDialog(true); await loadSubs(); }
  catch (e) { toast(String(e), true); } finally { editBusy.value = false; }
}
function expiryWarning(p: SubProviderCard) {
  if (!p.userinfo?.expire) return '';
  const days = Math.ceil((p.userinfo.expire * 1000 - Date.now()) / 86400000);
  return days <= 0 ? '订阅已到期' : days <= 7 ? `订阅将在 ${days} 天内到期` : '';
}

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 第一步（正在导入）：后端拉取订阅、识别名字、比对已导入（只读，不改配置） */
async function startImport() {
  const url = impUrl.value.trim();
  if (!url) return toast('请先填写订阅链接', true);
  const generation = ++importPreviewGeneration;
  impBusy.value = true;
  impModal.value = { stage: 'loading' };
  try {
    const d = await api<ImportPreviewData>('/import/preview', { method: 'POST', body: { url }, timeout: 30000 });
    if (generation !== importPreviewGeneration || !impModal.value) return;
    if (d.existing) {
      impModal.value = { stage: 'merge', existing: d.existing, nodes: d.nodes };
    } else {
      newName.value = d.name || todayStr();
      impModal.value = { stage: 'name', nodes: d.nodes, detected: Boolean(d.name), warning: d.warning };
    }
  } catch (e) {
    if (generation !== importPreviewGeneration || !impModal.value) return;
    impModal.value = { stage: 'error', msg: e instanceof Error ? e.message : String(e) };
  } finally {
    if (generation === importPreviewGeneration) impBusy.value = false;
  }
}

/** 合并：用该链接更新已导入的同链接订阅源（不新建重复源） */
async function confirmMerge() {
  const url = impUrl.value.trim();
  const target = impModal.value?.existing;
  if (!url || !target) return;
  impBusy.value = true;
  impModal.value = { ...impModal.value, stage: 'importing' };
  try {
    const d = await api<ImportData>('/import', {
      method: 'POST',
      body: { url, provider: target.name, reload: true },
      timeout: 120000,
    });
    toast(d.message);
    impModal.value = null;
    importModal.close();
    impUrl.value = '';
    await loadSubs();
    for (const p of providers.value) await loadUserinfo(p, true);
    impBusy.value = false;
  } catch (e) {
    impModal.value = { stage: 'error', msg: e instanceof Error ? e.message : String(e) };
    impBusy.value = false;
  }
}

/** 新建：以识别/填写的名字导入新订阅源（自动激活） */
async function confirmCreate() {
  const url = impUrl.value.trim();
  const name = newName.value.trim();
  if (!url || !name) return;
  impBusy.value = true;
  impModal.value = { ...impModal.value, stage: 'importing' };
  try {
    const d = await api<ImportData>('/import', {
      method: 'POST',
      body: { url, provider: name, reload: true },
      timeout: 120000,
    });
    toast(d.message);
    impModal.value = null;
    importModal.close();
    impUrl.value = '';
    await loadSubs();
    for (const p of providers.value) await loadUserinfo(p, true);
    impBusy.value = false;
  } catch (e) {
    impModal.value = { stage: 'error', msg: e instanceof Error ? e.message : String(e) };
    impBusy.value = false;
  }
}

function closeModal() {
  if (impModal.value?.stage === 'importing') return; // 写入热加载中不可取消
  importPreviewGeneration++;
  impBusy.value = false;
  impModal.value = null;
  importModal.close();
}

watch(
  () => impModal.value?.stage,
  (stage, previousStage) => {
    if (!stage) return;
    if (!previousStage) importModal.open(closeModal);
    else importModal.focusInitial();
  },
  { flush: 'post' },
);

async function refreshSubs(name?: string) {
  refreshing.value = true;
  try {
    const d = await api<SubRefreshData>('/subscriptions/refresh', { method: 'POST', body: { name }, timeout: 120000 });
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

/** 注入主配置（独占激活）：切换选中源 → 重建注入组 + 合并订阅规则 */
async function activate(p: SubProviderCard) {
  if (!confirm(`确认将订阅源「${p.name}」注入主配置？\n\n会把主配置组 PROXY/Auto 的 use 引用切到它${p.declared ? '' : '（并补写 config.yaml 声明）'}，并把该源定义的代理组与规则合并进主配置（自动备份，失败自动回滚）。\n\n当前激活的源将转为待机（声明与缓存保留，可随时再激活）。`)) return;
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

/** 恢复默认配置：移除注入的订阅组与合并规则，回到原始快照（原「默认配置」卡片的职责） */
async function restoreDefault() {
  if (!confirm('确认恢复默认配置？\n\n将从主配置移除注入的订阅组与已合并的订阅规则，恢复为原始基础规则（自动备份，失败自动回滚）。\n订阅源与缓存均保留，可随时重新激活。')) return;
  activating.value = 'default';
  try {
    const d = await api<SubActivateData>('/subscriptions/activate', { method: 'POST', body: { name: 'default' }, timeout: 120000 });
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
    <!-- 顶部：添加订阅（单行链接 + 导入；导入后弹窗：比对已导入 → 合并询问 / 名字确认 → 写入热加载） -->
    <div class="card">
      <h2>添加订阅 <span class="count">{{ providers.length }}</span></h2>
      <div class="si-row">
        <label class="visually-hidden" for="import-subscription-url">订阅链接</label>
        <input
          id="import-subscription-url"
          v-model="impUrl"
          type="url"
          name="subscription-url"
          autocomplete="url"
          class="si-input"
          placeholder="订阅文件链接（https://…）"
          @keyup.enter="startImport"
        />
        <button class="primary" :disabled="!impUrl.trim() || impBusy" @click="startImport">
          导入
        </button>
      </div>
    </div>

    <!-- 订阅列表：外框分组（参考代理组页 group-card 布局），每行最多 2 个订阅；内置「默认配置」卡片移除，由「恢复默认」按钮承担 -->
    <div v-if="loading" class="card">
      <div class="node-empty">加载中…</div>
    </div>
    <div v-else class="card sub-list-card">
      <div class="group-head">
        <div class="gh-left">
          <h3 class="gh-name">订阅列表</h3>
          <span class="gh-type">({{ listProviders.length }})</span>
        </div>
        <div class="gh-right">
          <button
            v-if="listProviders.some((p) => p.active)"
            class="small"
            :disabled="activating !== '' || refreshing"
            title="移除注入的订阅组与合并规则，恢复原始配置快照"
            @click="restoreDefault"
          >
            {{ activating === 'default' ? '恢复中…' : '⚡ 恢复默认' }}
          </button>
        </div>
      </div>
      <div v-if="listProviders.length" class="sub-grid">
        <div v-for="p in listProviders" :key="p.name" :class="['card', 'sub-card', { active: p.active }]">
          <div class="sc-head">
            <span class="sc-icon" aria-hidden="true">📄</span>
            <span class="sc-name" :title="p.name">{{ p.displayName || p.name }}</span>
            <span v-if="p.active" class="sc-badge on">使用中</span>
            <span v-else-if="!p.declared" class="sc-badge">未声明</span>
            <span class="sc-spacer" />
            <button
              class="icon-btn sub-icon-btn"
              :disabled="refreshing"
              title="仅更新此订阅的节点，不重载配置"
              aria-label="刷新此订阅"
              @click="refreshSubs(p.name)"
            >
              ⟳
            </button>
            <button v-if="p.declared" class="icon-btn sub-icon-btn" title="编辑订阅" aria-label="编辑订阅" @click="editSub(p)">✎</button>
            <button class="icon-btn sub-icon-btn" title="复制订阅链接" aria-label="复制订阅链接" @click="copyLink(p.url, p.name)">⧉</button>
            <button class="icon-btn sub-icon-btn danger" title="删除订阅源" aria-label="删除订阅源" @click="delSub(p)">✕</button>
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
          <p v-if="expiryWarning(p)" class="fail">{{ expiryWarning(p) }}</p>
          <p v-if="p.refreshStatus?.error" class="fail">更新失败：{{ p.refreshStatus.error }}</p>
          <p v-if="p.refreshStatus?.successAt" class="muted">最近更新成功：{{ new Date(p.refreshStatus.successAt).toLocaleString() }}</p>
          <div class="sc-foot">
            <span>{{ p.nodes }} 个节点</span>
            <span v-if="p.groupCount"> · {{ p.groupCount }} 组</span>
            <span v-if="p.ruleCount"> · {{ p.ruleCount }} 条规则</span>
            <span v-if="intervalText(p.interval)" class="muted"> · {{ intervalText(p.interval) }}</span>
          </div>
          <button class="btn inject-btn" :disabled="activating === p.name" @click="activate(p)">
            {{ activating === p.name ? '应用中…' : p.active ? '重新应用订阅组与规则' : '⚡ 注入主配置（设为当前激活源）' }}
          </button>
        </div>
      </div>
      <div v-else class="node-empty">未配置订阅源</div>
    </div>

    <!-- 订阅组自动同步说明 -->
    <div class="card">
      <h2>订阅组自动同步</h2>
      <p class="muted">
        mihomo 的 proxy-providers 只导入订阅里的节点，不导入其代理组与规则。UClash 会把
        <strong>当前选中（激活）</strong>订阅源里定义的 proxy-groups 与 rules 合并注入主配置并热加载生效（写前自动备份，热加载失败自动回滚，各组当前选择在加载后恢复）。
        只展示/注入当前选中的源；「默认配置」为原始配置快照，可随时恢复用于备份与测试。
        各组详情见「代理组」页。
      </p>
    </div>

    <div v-if="editing" class="modal-mask" @click.self="closeEditDialog"><form ref="editDialog" class="card dialog-wide" role="dialog" aria-modal="true" aria-labelledby="edit-subscription-title" tabindex="-1" @keydown="editModal.onKeydown($event, closeEditDialog)" @submit.prevent="saveEdit">
      <h2 id="edit-subscription-title">编辑订阅</h2><p class="muted">显示名称不改变内部引用。保存 URL 或更新间隔需要重载配置。</p>
      <label class="field">显示名称<input v-model="editing.displayName" data-dialog-initial name="subscription-display-name" autocomplete="off" required /></label>
      <label class="field">订阅 URL<input v-model="editing.url" type="url" name="subscription-url" autocomplete="url" required /></label>
      <label class="field">更新间隔（秒）<input v-model.number="editing.interval" type="number" name="subscription-interval" autocomplete="off" min="60" max="2592000" required /></label>
      <div class="toolbar"><button type="button" :disabled="editBusy" @click="closeEditDialog">取消</button><button class="primary" :disabled="editBusy">保存并应用</button></div>
    </form></div>

    <!-- 添加订阅弹窗：正在导入 → 合并询问 / 名字确认 → 写入热加载 → 结果 -->
    <div v-if="impModal" class="modal-mask" @click.self="closeModal">
      <div ref="importDialog" class="card modal-card" role="dialog" aria-modal="true" aria-labelledby="import-subscription-title" tabindex="-1" :aria-busy="impModal.stage === 'loading' || impModal.stage === 'importing'" @keydown="importModal.onKeydown($event, closeModal)">
        <template v-if="impModal.stage === 'loading'">
          <h2 id="import-subscription-title">正在导入…</h2>
          <p class="muted">拉取订阅、识别订阅名并比对已导入订阅，请稍候。</p>
        </template>
        <template v-else-if="impModal.stage === 'merge'">
          <h2 id="import-subscription-title">检测到已导入的相同订阅</h2>
          <p>该链接已导入为订阅源 <strong>{{ impModal.existing?.name }}</strong>。</p>
          <p class="muted">是否合并（用该链接更新现有订阅源，不新建重复源）？</p>
          <div class="modal-actions">
            <button class="btn" data-dialog-initial @click="closeModal">取消</button>
            <button class="primary" @click="confirmMerge">合并</button>
          </div>
        </template>
        <template v-else-if="impModal.stage === 'name'">
          <h2 id="import-subscription-title">确认导入</h2>
          <p v-if="impModal.nodes" class="muted">识别到 {{ impModal.nodes }} 个节点。</p>
          <p v-if="impModal.warning" class="si-msg warning">{{ impModal.warning }}</p>
          <p class="muted">{{ impModal.detected ? '已自动识别订阅名（可修改后确认）：' : '订阅名识别失败，已默认填写日期（可修改后确认）：' }}</p>
          <label class="visually-hidden" for="import-subscription-name">订阅名称</label>
          <input id="import-subscription-name" v-model="newName" data-dialog-initial type="text" name="subscription-name" autocomplete="off" class="si-input" />
          <div class="modal-actions">
            <button class="btn" @click="closeModal">取消</button>
            <button class="primary" :disabled="!newName.trim()" @click="confirmCreate">确认导入</button>
          </div>
        </template>
        <template v-else-if="impModal.stage === 'importing'">
          <h2 id="import-subscription-title">正在导入…</h2>
          <p class="muted">写入配置并热加载 mihomo，约 10~30 秒，请勿关闭。</p>
        </template>
        <template v-else>
          <h2 id="import-subscription-title">导入失败</h2>
          <p class="si-msg fail">{{ impModal.msg }}</p>
          <div class="modal-actions">
            <button class="primary" data-dialog-initial @click="closeModal">关闭</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
