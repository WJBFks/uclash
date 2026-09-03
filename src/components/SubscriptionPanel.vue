<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '@/api/client';
import { useToast } from '@/composables/useToast';
import type { SubscriptionsData, SubRefreshData, ImportData } from '@/api/types';

const toast = useToast();

const subNames = ref<string[]>([]);
const refreshing = ref(false);
const refreshResults = ref<SubRefreshData['results'] | null>(null);
const refreshSummary = ref('');

const impUrl = ref('');
const impName = ref('');
const impReload = ref(true);
const impBusy = ref(false);
const impResult = ref('');
const impError = ref('');
const impBackup = ref('');

async function loadSubs() {
  try {
    const d = await api<SubscriptionsData>('/subscriptions');
    subNames.value = d.subscriptions;
  } catch {
    subNames.value = [];
  }
}

async function refreshSubs() {
  refreshing.value = true;
  refreshResults.value = null;
  refreshSummary.value = '';
  try {
    const d = await api<SubRefreshData>('/subscriptions/refresh', { method: 'POST', timeout: 120000 });
    refreshResults.value = d.results;
    refreshSummary.value = d.summary;
    toast(d.summary);
    loadSubs();
  } catch (e) {
    refreshSummary.value = e instanceof Error ? e.message : String(e);
  } finally {
    refreshing.value = false;
  }
}

async function doImport() {
  const url = impUrl.value.trim();
  const name = impName.value.trim();
  if (!url) return toast('请填写订阅 URL', true);
  const what = name ? `新增订阅源「${name}」` : '更新默认订阅源 mysub';
  if (!confirm(`确认${what}？\n\nURL: ${url}\n\n将写入 ~/.config/mihomo/config.yaml（自动备份 .bak.*，失败自动回滚），随后热加载。`)) return;
  impBusy.value = true;
  impResult.value = '';
  impError.value = '写入配置中…';
  impBackup.value = '';
  try {
    const d = await api<ImportData>('/import', { method: 'POST', body: { url, provider: name, reload: impReload.value }, timeout: 120000 });
    impError.value = '';
    impResult.value = d.message;
    impBackup.value = d.backup || '';
    toast(d.message);
    impUrl.value = '';
    impName.value = '';
    loadSubs();
  } catch (e) {
    impResult.value = '';
    impError.value = e instanceof Error ? e.message : String(e);
  } finally {
    impBusy.value = false;
  }
}

onMounted(loadSubs);
</script>

<template>
  <div class="card">
    <h2>订阅管理</h2>
    <div class="row">
      <button class="primary" :disabled="refreshing" @click="refreshSubs">{{ refreshing ? '刷新中…' : '刷新全部订阅' }}</button>
      <span class="muted">{{ subNames.length ? '订阅源: ' + subNames.join('、') : '未配置订阅源' }}</span>
    </div>
    <div class="sub-result">
      <span v-if="refreshing" class="muted">刷新中（热加载 + 验证缓存文件变化，最多约 15 秒）…</span>
      <template v-else-if="refreshResults">
        <div v-for="r in refreshResults" :key="r.name" :class="r.ok ? 'ok' : 'fail'">
          {{ r.ok ? '✓' : '✗' }} {{ r.name }}{{ r.error ? ` — ${r.error}` : '' }}
        </div>
        <div class="muted">{{ refreshSummary }}</div>
      </template>
      <span v-else-if="refreshSummary" class="fail">{{ refreshSummary }}</span>
    </div>

    <hr class="sep" />
    <div class="sub-title">导入订阅源（写入 config.yaml，自动备份 + 热加载，失败自动回滚）</div>
    <div class="form-row">
      <input type="url" v-model="impUrl" placeholder="订阅 URL，如 https://example.com/sub?token=…" />
      <input type="text" v-model="impName" placeholder="provider 名（留空 = 更新默认源 mysub）" />
    </div>
    <div class="row import-row">
      <button :disabled="impBusy" @click="doImport">{{ impBusy ? '导入中…' : '导入并热加载' }}</button>
      <label class="chk">
        <input type="checkbox" v-model="impReload" /> 热加载（PUT /configs）
      </label>
    </div>
    <div class="sub-result">
      <span v-if="impResult" class="ok">{{ impResult }}</span>
      <span v-if="impBackup" class="muted">备份: {{ impBackup }}</span>
      <span v-if="impError" class="fail">{{ impError }}</span>
    </div>
    <div class="hint">注意：导入新 provider 会修改 config.yaml；更新默认源不影响现有节点名，新增源需 mihomo 配置中已声明对应 provider。</div>
  </div>
</template>
