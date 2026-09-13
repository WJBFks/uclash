<script setup lang="ts">
import { computed, shallowRef } from 'vue';
import ConnectionsTable from '@/components/connections/ConnectionsTable.vue';
import ConnectionDetailDialog from '@/components/connections/ConnectionDetailDialog.vue';
import { useConnections } from '@/composables/useConnections';
import { useToast } from '@/composables/useToast';
import type { ConnectionItem } from '@/api/types';
import { deriveDetailConnection } from '@/components/connections/helpers';

const props = defineProps<{ compact?: boolean }>();
const toast = useToast();
const detailId = shallowRef<string | null>(null);
const connections = useConnections(props.compact);
const detail = computed(() => deriveDetailConnection(detailId.value, connections.data.value.connections, connections.data.value.closed ?? []));
function addRule(connection: ConnectionItem) {
  const host = connection.metadata?.host || connection.metadata?.sni;
  if (!host) { toast('该连接没有域名，请在规则页按 IP 或进程添加', true); return; }
  sessionStorage.setItem('cw-rule-seed', JSON.stringify({ type: 'DOMAIN', payload: host }));
  location.hash = '#/rules';
}
async function disconnect(ids: string[]) {
  if (!ids.length || !confirm(`关闭这 ${ids.length} 个连接？对应请求会中断。`)) return;
  try {
    const outcome = await connections.close(ids);
    if (!outcome) return;
    if (outcome.kind !== 'all') toast(outcome.message, outcome.kind === 'none');
    if (detailId.value && outcome.succeededIds.includes(detailId.value)) detailId.value = null;
  }
  catch (cause) { toast(cause instanceof Error ? cause.message : String(cause), true); }
}
</script>
<template>
  <div class="card connections-panel">
    <div class="row"><h2>连接 <span class="count">{{ connections.data.value.connections.length }}</span></h2><a v-if="compact" href="#/connections">查看全部与排障 →</a></div>
    <div v-if="!compact" class="toolbar"><input v-model="connections.query.value" aria-label="搜索连接" placeholder="搜索域名、进程、规则、代理链…" /><select v-model="connections.state.value" aria-label="连接状态"><option value="active">活动连接</option><option value="closed">已关闭（最近 200 条）</option></select><select v-model="connections.sort.value" aria-label="连接排序"><option value="downloadSpeed">下载速度</option><option value="uploadSpeed">上传速度</option><option value="download">下载总量</option><option value="upload">上传总量</option></select><button @click="connections.paused.value = !connections.paused.value">{{ connections.paused.value ? '继续刷新' : '暂停刷新' }}</button><button v-if="connections.state.value === 'active'" @click="connections.selectPage">选择本页</button><button v-if="connections.state.value === 'active'" class="danger" :disabled="connections.busy.value || !connections.selected.value.size" @click="disconnect([...connections.selected.value])">关闭所选 {{ connections.selected.value.size || '' }}</button></div>
    <p v-if="connections.error.value" class="fail" role="alert">{{ connections.error.value }} · 当前显示上次成功读取的数据</p>
    <ConnectionsTable :rows="connections.rows.value" :compact="compact" :state="connections.state.value" :selected-ids="connections.selected.value" @toggle="connections.toggleSelection" @detail="detailId = $event.id" @add-rule="addRule" />
    <p v-if="!connections.rows.value.length" class="muted">{{ connections.loading.value ? '正在读取…' : '没有匹配的连接' }}</p>
    <div v-if="!compact" class="toolbar"><button :disabled="connections.page.value <= 1" @click="connections.page.value--">上一页</button><span>{{ connections.page.value }} / {{ connections.pages.value }} 页 · {{ connections.filtered.value.length }} 条</span><button :disabled="connections.page.value >= connections.pages.value" @click="connections.page.value++">下一页</button><span class="muted">历史仅保存在面板后端内存，重启后清空。</span></div>
  </div>
  <ConnectionDetailDialog :connection="detail" :busy="connections.busy.value" @close="detailId = null" @add-rule="addRule" @disconnect="disconnect([$event.id])" />
</template>
<style scoped>.connections-panel { min-width: 0; }</style>
