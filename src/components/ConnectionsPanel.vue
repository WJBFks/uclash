<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '@/api/client';
import { useToast } from '@/composables/useToast';
import { bytes } from '@/utils/format';
import type { ConnectionsData, ConnectionItem } from '@/api/types';

const toast = useToast();
const conns = ref<ConnectionItem[]>([]);
const killing = ref<Record<string, boolean>>({});
let inflight = false;
let timer: ReturnType<typeof setInterval> | null = null;

async function load() {
  if (inflight) return; // in-flight 合并：/connections 转发 mihomo，卡时防堆积
  inflight = true;
  try {
    const d = await api<ConnectionsData>('/connections');
    conns.value = d.connections;
  } catch {
    /* 静默 */
  } finally {
    inflight = false;
  }
}

const rows = computed(() => conns.value.slice(0, 100));
function procOf(c: ConnectionItem): string {
  return (c.process || '').split('/').pop() || '';
}

async function kill(c: ConnectionItem) {
  const next = { ...killing.value, [c.id]: true };
  killing.value = next;
  try {
    await api('/connections', { method: 'DELETE', body: { id: c.id } });
  } catch (e) {
    const cur = { ...killing.value, [c.id]: false };
    killing.value = cur;
    toast(`关闭连接失败: ${e instanceof Error ? e.message : e}`, true);
  }
}

onMounted(() => {
  load();
  timer = setInterval(load, 2000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="card">
    <h2>当前连接 <span class="count">{{ conns.length }}</span></h2>
    <div class="conn-scroll">
      <table>
        <thead>
          <tr><th>进程</th><th>Host</th><th>源</th><th>目的</th><th>↑ 上传</th><th>↓ 下载</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="c in rows" :key="c.id">
            <td :title="c.process">{{ procOf(c) }}</td>
            <td>{{ c.metadata?.host || c.metadata?.sni || '' }}</td>
            <td>{{ c.metadata?.source || '' }}</td>
            <td>{{ c.metadata?.destination || '' }}</td>
            <td>{{ bytes(c.upload) }}</td>
            <td>{{ bytes(c.download) }}</td>
            <td>
              <button class="small danger" :disabled="!!killing[c.id]" @click="kill(c)">关</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!conns.length" class="conn-empty">暂无活动连接</div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/variables' as *;

.conn-empty {
  padding: 24px;
  text-align: center;
  color: $muted;
}
</style>
