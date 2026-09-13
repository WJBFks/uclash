<script setup lang="ts">
import { computed } from 'vue';
import { bytes } from '@/utils/format';
import type { ConnectionItem } from '@/api/types';
import { formatSpeed, processDisplay } from './helpers';
const props = defineProps<{ rows: ConnectionItem[]; compact?: boolean; state: 'active' | 'closed'; selectedIds: Set<string> }>();
const emit = defineEmits<{ toggle: [id: string]; detail: [connection: ConnectionItem]; addRule: [connection: ConnectionItem] }>();
const showSelection = computed(() => !props.compact && props.state === 'active');
const domain = (c: ConnectionItem) => c.metadata?.host || c.metadata?.sni || c.metadata?.destination || '—';
const chain = (c: ConnectionItem) => c.chains?.slice().reverse().join(' → ') || '—';
const endpoint = (c: ConnectionItem, side: 'source' | 'destination') => {
  const meta = c.metadata;
  const value = meta?.[side];
  if (value) return value;
  const ip = meta?.[`${side}IP`], port = meta?.[`${side}Port`];
  return ip && port !== undefined && port !== '' ? `${ip}:${port}` : ip || '—';
};
</script>
<template>
  <div class="table-scroll connections-table-scroll"><table class="data-table connections-table"><thead><tr><th v-if="showSelection" scope="col">选择</th><th scope="col">域名 / 进程</th><th scope="col">来源 → 目标</th><th scope="col">入站 / 协议</th><th scope="col">规则 / 代理链</th><th scope="col" class="numeric">↓ 下载</th><th scope="col" class="numeric">↑ 上传</th><th scope="col">操作</th></tr></thead><tbody><tr v-for="connection in rows" :key="connection.id">
    <td v-if="showSelection"><input type="checkbox" :aria-label="'选择 ' + connection.id" :checked="selectedIds.has(connection.id)" @change="emit('toggle', connection.id)" /></td>
    <td><strong>{{ domain(connection) }}</strong><div class="muted">进程：{{ processDisplay(connection) }}</div></td>
    <td><span class="endpoint-pair">{{ endpoint(connection, 'source') }} → {{ endpoint(connection, 'destination') }}</span></td>
    <td>{{ connection.metadata?.type || '—' }}<div class="muted">{{ connection.metadata?.network || '—' }}</div></td>
    <td>{{ connection.rule || '—' }} {{ connection.rulePayload || '' }}<div class="muted">{{ chain(connection) }}</div></td>
    <td class="numeric">{{ formatSpeed(connection.downloadSpeed, bytes) }}<div class="muted">{{ bytes(connection.download) }}</div></td><td class="numeric">{{ formatSpeed(connection.uploadSpeed, bytes) }}<div class="muted">{{ bytes(connection.upload) }}</div></td>
    <td class="actions"><button class="small" @click="emit('detail', connection)">详情</button><button class="small" @click="emit('addRule', connection)">添加规则</button></td>
  </tr></tbody></table></div>
</template>
<style scoped>
.connections-table { min-width: 980px; }.connections-table-scroll { max-width: 100%; }.numeric { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }.actions { white-space: nowrap; }@media (max-width: 720px) { .connections-table { min-width: 900px; } }
</style>
