<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '@/api/client';
import { useToast } from '@/composables/useToast';
import type { BackupInfo, ConfigPreview } from '@/api/types';

type TunForm = { enable: boolean; stack: string; 'auto-route': boolean; 'route-exclude-address': string };
type DnsForm = { enable: boolean; 'enhanced-mode': string; nameserver: string; fallback: string; 'fake-ip-filter': string };
interface NetworkForm {
  tun: TunForm;
  dns: DnsForm;
  'mixed-port': number; 'allow-lan': boolean; ipv6: boolean;
}
type NetworkConfig = Partial<{ tun: Partial<TunForm>; dns: Partial<DnsForm>; 'mixed-port': number; 'allow-lan': boolean; ipv6: boolean }>;
interface NetworkResponse { network: NetworkConfig; runtime: NetworkConfig; pending: boolean; revision: string; runtimeError: string }
interface MessageResult { ok: boolean; message: string; revision?: string; backup?: string }
interface BackupsResponse { backups: BackupInfo[]; limit: number }
interface BackupBundle { format: string; config: string; overlay?: unknown; at?: string; label?: string }

const toast = useToast();
const busy = ref(false);
const loading = ref(true);
const pending = ref(false);
const networkRevision = ref('');
const runtimeError = ref('');
const networkError = ref('');
const networkLoaded = ref(false);
const preview = ref<ConfigPreview | null>(null);
const backups = ref<BackupInfo[]>([]);
const backupLimit = ref(0);
const fileInput = ref<HTMLInputElement | null>(null);
const backupPreview = ref<{ title: string; config: string } | null>(null);

const form = ref<NetworkForm>(emptyForm());
const savedForm = ref<NetworkForm | null>(null);
function emptyForm(): NetworkForm {
  return { tun: { enable: false, stack: 'system', 'auto-route': true, 'route-exclude-address': '' }, dns: { enable: true, 'enhanced-mode': 'fake-ip', nameserver: '', fallback: '', 'fake-ip-filter': '' }, 'mixed-port': 7890, 'allow-lan': false, ipv6: false };
}
function lines(value: unknown) { return Array.isArray(value) ? value.join('\n') : ''; }
function list(value: string) { return value.split(/\r?\n/).map((v) => v.trim()).filter(Boolean); }
function copyForm(value: NetworkForm): NetworkForm { return JSON.parse(JSON.stringify(value)) as NetworkForm; }
function readNetwork(network: NetworkConfig) {
  const next = emptyForm();
  const tun = network.tun || {}, dns = network.dns || {};
  next.tun.enable = tun.enable === true;
  next.tun.stack = ['system', 'gvisor', 'mixed'].includes(tun.stack) ? tun.stack : next.tun.stack;
  next.tun['auto-route'] = tun['auto-route'] !== false;
  next.tun['route-exclude-address'] = lines(tun['route-exclude-address']);
  next.dns.enable = dns.enable !== false;
  next.dns['enhanced-mode'] = ['fake-ip', 'redir-host'].includes(dns['enhanced-mode']) ? dns['enhanced-mode'] : next.dns['enhanced-mode'];
  for (const key of ['nameserver', 'fallback', 'fake-ip-filter'] as const) next.dns[key] = lines(dns[key]);
  next['mixed-port'] = Number.isInteger(network['mixed-port']) ? network['mixed-port'] : next['mixed-port'];
  next['allow-lan'] = network['allow-lan'] === true;
  next.ipv6 = network.ipv6 === true;
  form.value = next;
  savedForm.value = copyForm(next);
}
function same(value: unknown, original: unknown) { return JSON.stringify(value) === JSON.stringify(original); }
function networkPayload(): NetworkConfig {
  const previous = savedForm.value;
  if (!previous) return {};
  const patch: NetworkConfig = {};
  const tun: Partial<TunForm> = {}, dns: Partial<DnsForm> = {};
  const currentTun = form.value.tun, oldTun = previous.tun;
  if (currentTun.enable !== oldTun.enable) tun.enable = currentTun.enable;
  if (currentTun.stack !== oldTun.stack) tun.stack = currentTun.stack;
  if (currentTun['auto-route'] !== oldTun['auto-route']) tun['auto-route'] = currentTun['auto-route'];
  if (!same(list(currentTun['route-exclude-address']), list(oldTun['route-exclude-address']))) tun['route-exclude-address'] = list(currentTun['route-exclude-address']);
  if (Object.keys(tun).length) patch.tun = tun;
  const currentDns = form.value.dns, oldDns = previous.dns;
  if (currentDns.enable !== oldDns.enable) dns.enable = currentDns.enable;
  if (currentDns['enhanced-mode'] !== oldDns['enhanced-mode']) dns['enhanced-mode'] = currentDns['enhanced-mode'];
  for (const key of ['nameserver', 'fallback', 'fake-ip-filter'] as const) if (!same(list(currentDns[key]), list(oldDns[key]))) dns[key] = list(currentDns[key]);
  if (Object.keys(dns).length) patch.dns = dns;
  for (const key of ['mixed-port', 'allow-lan', 'ipv6'] as const) if (form.value[key] !== previous[key]) patch[key] = form.value[key];
  return patch;
}
const networkDirty = computed(() => !!savedForm.value && Object.keys(networkPayload()).length > 0);
const diff = computed(() => {
  if (!preview.value?.changed) return { added: 0, removed: 0 };
  const before = new Set(preview.value.original.split('\n')), after = new Set(preview.value.candidate.split('\n'));
  return { added: [...after].filter((line) => !before.has(line)).length, removed: [...before].filter((line) => !after.has(line)).length };
});

async function loadNetwork() {
  try {
    const d = await api<NetworkResponse>('/network');
    readNetwork(d.network); networkRevision.value = d.revision; runtimeError.value = d.runtimeError; networkError.value = ''; networkLoaded.value = true;
  } catch (e) {
    networkLoaded.value = false; networkError.value = e instanceof Error ? e.message : String(e); throw e;
  }
}
async function loadPreview() {
  preview.value = await api<ConfigPreview>('/config/preview');
  pending.value = preview.value.pending;
  return preview.value;
}
async function refreshPreview() {
  try { await loadPreview(); }
  catch (e) { toast(`读取预览失败: ${e instanceof Error ? e.message : e}`, true); }
}
async function loadBackups() {
  const d = await api<BackupsResponse>('/backups'); backups.value = d.backups; backupLimit.value = d.limit;
}
async function loadAll() {
  loading.value = true;
  try { await loadNetwork(); await Promise.all([loadPreview(), loadBackups()]); }
  catch (e) { toast(`读取配置失败: ${e instanceof Error ? e.message : e}`, true); }
  finally { loading.value = false; }
}
async function saveDraft() {
  if (!networkLoaded.value || !networkDirty.value) return;
  busy.value = true;
  try {
    const d = await api<MessageResult>('/network/draft', { method: 'POST', body: { network: networkPayload(), revision: networkRevision.value } });
    networkRevision.value = d.revision || networkRevision.value; savedForm.value = copyForm(form.value); pending.value = true; await loadPreview(); toast(d.message);
  } catch (e) { toast(`保存草稿失败: ${e instanceof Error ? e.message : e}`, true); } finally { busy.value = false; }
}
async function validate() {
  if (!preview.value) return;
  busy.value = true;
  try { const d = await api<MessageResult>('/config/validate', { method: 'POST', body: { revision: preview.value.revision }, timeout: 60000 }); toast(d.message); }
  catch (e) { toast(`校验失败: ${e instanceof Error ? e.message : e}`, true); } finally { busy.value = false; }
}
async function apply() {
  if (!preview.value?.pending) return toast('当前没有待应用的配置草稿');
  if (!confirm('确认应用候选配置？这会热加载 mihomo，可能中断现有连接。')) return;
  busy.value = true;
  try { const d = await api<MessageResult>('/config/apply', { method: 'POST', body: { confirm: true, revision: preview.value.revision }, timeout: 120000 }); toast(d.message); await loadAll(); }
  catch (e) { toast(`应用失败: ${e instanceof Error ? e.message : e}`, true); } finally { busy.value = false; }
}
async function discard() {
  if (!pending.value || !confirm('确认丢弃所有未应用的配置草稿？')) return;
  busy.value = true;
  try { const d = await api<MessageResult>('/config/discard', { method: 'POST', body: { revision: preview.value?.revision } }); toast(d.message); await loadAll(); }
  catch (e) { toast(`丢弃失败: ${e instanceof Error ? e.message : e}`, true); } finally { busy.value = false; }
}
async function createBackup() {
  busy.value = true;
  try { const d = await api<MessageResult>('/backups/create', { method: 'POST' }); toast(d.message); await loadBackups(); }
  catch (e) { toast(`创建备份失败: ${e instanceof Error ? e.message : e}`, true); } finally { busy.value = false; }
}
async function getBackup(id: string) { return api<{ bundle: BackupBundle }>(`/backups/export?id=${encodeURIComponent(id)}`); }
async function exportBackup(item: BackupInfo) {
  try { const { bundle } = await getBackup(item.id); const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `clash-web-backup-${item.id}.json`; link.click(); URL.revokeObjectURL(url); }
  catch (e) { toast(`导出失败: ${e instanceof Error ? e.message : e}`, true); }
}
async function viewBackup(item: BackupInfo) {
  try { const { bundle } = await getBackup(item.id); backupPreview.value = { title: `${item.label} · ${item.at}`, config: bundle.config }; }
  catch (e) { toast(`读取备份失败: ${e instanceof Error ? e.message : e}`, true); }
}
async function restoreBackup(item: BackupInfo) {
  try {
    await loadPreview();
    if (!confirm(`确认恢复备份「${item.label}」？这会热加载 mihomo，可能中断现有连接。`)) return;
    busy.value = true; const d = await api<MessageResult>('/backups/restore', { method: 'POST', body: { id: item.id, confirm: true, revision: preview.value?.revision }, timeout: 120000 }); toast(d.message); await loadAll();
  } catch (e) { toast(`恢复失败: ${e instanceof Error ? e.message : e}`, true); } finally { busy.value = false; }
}
async function deleteBackup(item: BackupInfo) {
  if (!confirm(`确认删除备份「${item.label}」？此操作不可撤销。`)) return;
  try { const d = await api<MessageResult>(`/backups?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' }); toast(d.message); await loadBackups(); }
  catch (e) { toast(`删除失败: ${e instanceof Error ? e.message : e}`, true); }
}
function chooseImport() { fileInput.value?.click(); }
async function importBackup(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
  try { const bundle = JSON.parse(await file.text()) as BackupBundle; const d = await api<MessageResult>('/backups/import', { method: 'POST', body: { bundle } }); toast(d.message); await loadBackups(); }
  catch (e) { toast(`导入失败: ${e instanceof Error ? e.message : e}`, true); }
  finally { if (fileInput.value) fileInput.value.value = ''; }
}
onMounted(loadAll);
</script>

<template>
  <div class="config-view">
    <div class="card">
      <div class="toolbar"><div><h2>网络设置</h2><p class="hint">保存仅生成草稿，不会修改或重启当前 mihomo 服务。</p></div><button :disabled="busy || loading || !networkLoaded || !networkDirty" @click="saveDraft">保存为草稿</button></div>
      <p v-if="runtimeError" class="warning">{{ runtimeError }}</p>
      <div v-if="loading" class="muted">读取中…</div>
      <div v-else-if="!networkLoaded" class="warning">无法读取网络设置：{{ networkError }}。为避免以默认值覆盖已有配置，已禁止保存。</div>
      <div v-else class="settings-grid">
        <fieldset><legend>TUN</legend><label class="check"><input v-model="form.tun.enable" type="checkbox" /> 启用 TUN</label><label>Stack<select v-model="form.tun.stack"><option value="system">system</option><option value="gvisor">gvisor</option><option value="mixed">mixed</option></select></label><label class="check"><input v-model="form.tun['auto-route']" type="checkbox" /> 自动路由</label><label>排除地址（每行一个 CIDR）<textarea v-model="form.tun['route-exclude-address']" rows="4" placeholder="192.168.0.0/16"></textarea></label></fieldset>
        <fieldset><legend>DNS</legend><label class="check"><input v-model="form.dns.enable" type="checkbox" /> 启用 DNS</label><label>增强模式<select v-model="form.dns['enhanced-mode']"><option value="fake-ip">fake-ip</option><option value="redir-host">redir-host</option></select></label><label>Nameserver（每行一个）<textarea v-model="form.dns.nameserver" rows="3" placeholder="https://dns.google/dns-query"></textarea></label><label>Fallback（每行一个）<textarea v-model="form.dns.fallback" rows="3"></textarea></label><label>Fake-IP 过滤（每行一个）<textarea v-model="form.dns['fake-ip-filter']" rows="3" placeholder="*.lan"></textarea></label></fieldset>
        <fieldset><legend>监听与 IP</legend><label>Mixed port<input v-model.number="form['mixed-port']" type="number" min="0" max="65535" /></label><label class="check"><input v-model="form['allow-lan']" type="checkbox" /> 允许局域网连接</label><label class="check"><input v-model="form.ipv6" type="checkbox" /> 启用 IPv6</label></fieldset>
      </div>
    </div>

    <div class="card">
      <div class="toolbar"><div><h2>配置预览</h2><p class="hint">原始配置与候选配置并列展示。草稿不会生效，应用可能中断现有连接。</p></div><div class="actions"><button :disabled="busy" @click="refreshPreview">刷新预览</button><button :disabled="busy || !pending" class="danger-outline" @click="discard">丢弃草稿</button><button :disabled="busy || !preview?.pending" class="primary" @click="apply">校验并应用</button></div></div>
      <div v-if="preview" class="preview-note" :class="{ changed: preview.changed }">{{ preview.changed ? `候选配置有变更：新增约 ${diff.added} 行，移除约 ${diff.removed} 行。` : '候选配置与当前配置一致。' }} <button :disabled="busy" @click="validate">仅校验</button></div>
      <div v-if="preview" class="config-columns"><section><h3>当前原始配置</h3><pre>{{ preview.original }}</pre></section><section><h3>候选配置</h3><pre>{{ preview.candidate }}</pre></section></div>
      <div v-else class="muted">读取预览中…</div>
    </div>

    <div class="card">
      <div class="toolbar"><div><h2>本地备份</h2><p class="hint">最多保留 {{ backupLimit || '—' }} 份。备份仅含配置和覆盖层，不含节点缓存；导出文件可能含订阅凭证，请妥善保管。导入只保存副本，恢复才会热加载配置。</p></div><div class="actions"><input ref="fileInput" class="visually-hidden" type="file" accept="application/json,.json" @change="importBackup" /><button :disabled="busy" @click="chooseImport">导入 JSON</button><button :disabled="busy" @click="createBackup">创建备份</button></div></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>时间</th><th>说明</th><th>大小</th><th>操作</th></tr></thead><tbody><tr v-for="item in backups" :key="item.id"><td>{{ new Date(item.at).toLocaleString() }}</td><td>{{ item.label }}</td><td>{{ (item.bytes / 1024).toFixed(1) }} KB</td><td class="row-actions"><button @click="viewBackup(item)">预览</button><button @click="exportBackup(item)">导出</button><button class="primary" :disabled="busy" @click="restoreBackup(item)">恢复</button><button class="danger-outline" @click="deleteBackup(item)">删除</button></td></tr><tr v-if="!backups.length"><td colspan="4" class="muted">尚无本地备份</td></tr></tbody></table></div>
    </div>

    <div v-if="backupPreview" class="modal-backdrop" @click.self="backupPreview = null"><div class="modal"><div class="toolbar"><h2>备份配置</h2><button @click="backupPreview = null">关闭</button></div><p class="hint">{{ backupPreview.title }}</p><pre>{{ backupPreview.config }}</pre></div></div>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/variables' as *;
.toolbar { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; margin-bottom:12px; h2 { margin:0 0 4px; } }
.actions,.row-actions { display:flex; gap:7px; flex-wrap:wrap; align-items:center; }
.settings-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; }
fieldset { min-width:0; border:1px solid $border; border-radius:8px; padding:12px; display:grid; gap:10px; align-content:start; } legend { padding:0 5px; font-weight:600; } label { display:grid; gap:4px; color:$muted; font-size:12px; } .check { display:flex; align-items:center; gap:7px; color:$text; input { width:auto; flex-shrink:0; } } input,select,textarea { width:100%; box-sizing:border-box; padding:7px 9px; border:1px solid $border; border-radius:6px; background:white; color:$text; } textarea { resize:vertical; font-family:ui-monospace,Consolas,monospace; }
.warning { color:#9a6700; background:#fff8c5; padding:8px 10px; border-radius:6px; font-size:13px; }.preview-note { margin-bottom:10px; font-size:13px; color:$muted; &.changed { color:#9a6700; } button { margin-left:8px; } }
.config-columns { display:grid; grid-template-columns:1fr 1fr; gap:12px; section { min-width:0; } h3 { margin:0 0 7px; font-size:13px; } pre,.modal pre { margin:0; background:#101418; color:#d6e0ea; border-radius:7px; padding:10px; overflow:auto; max-height:420px; font-size:12px; line-height:1.45; white-space:pre; } }
.table-wrap { overflow:auto; }.data-table { min-width:640px; }.danger-outline { color:$red; border-color:rgba($red,.4); }.primary { background:$accent; color:white; border-color:$accent; }.visually-hidden { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }
.modal-backdrop { position:fixed; inset:0; z-index:40; background:rgba(0,0,0,.45); display:grid; place-items:center; padding:20px; }.modal { width:min(1000px,100%); max-height:90vh; overflow:auto; background:white; border-radius:10px; padding:18px; }
@media(max-width:900px){ .settings-grid,.config-columns { grid-template-columns:1fr; } }
@media(max-width:600px){ .toolbar{flex-direction:column;} }
</style>
