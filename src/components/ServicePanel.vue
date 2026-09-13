<script setup lang="ts">
import { inject, ref } from 'vue';
import { api } from '@/api/client';
import { useToast } from '@/composables/useToast';
import type { StatusData, ServiceResult } from '@/api/types';

const props = defineProps<{ status: StatusData | null }>();
const toast = useToast();
const refreshStatus = inject<() => void>('refreshStatus', () => {});

const busy = ref(false);
const LABELS = { start: '启动', stop: '停止', restart: '重启' } as const;
type Action = keyof typeof LABELS;

async function doSvc(action: Action) {
  const label = LABELS[action];
  if (action !== 'start' && !confirm(`确认${label} mihomo 服务？\n\n${action === 'stop' ? 'TUN 全局代理将关闭，流量回直连。' : '代理将短暂中断。'}`)) return;
  busy.value = true;
  try {
    const d = await api<ServiceResult>('/service', { method: 'POST', body: { action }, timeout: 90000 });
    toast(d.message, d.ok === false);
  } catch (e) {
    toast(`${label}失败: ${e instanceof Error ? e.message : e}`, true);
  } finally {
    busy.value = false;
    refreshStatus();
  }
}
</script>

<template>
  <div class="card">
    <h2>全局服务（systemd · TUN）</h2>
    <div class="row">
      <button class="primary" :disabled="busy" @click="doSvc('start')">启动 TUN</button>
      <button class="danger" :disabled="busy" @click="doSvc('stop')">停止</button>
      <button :disabled="busy" @click="doSvc('restart')">重启</button>
    </div>
    <div class="hint">启动会开启 TUN 并启用自动路由；stop / restart 会中断全局透明代理</div>
  </div>
</template>
