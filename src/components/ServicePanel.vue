<script setup lang="ts">
import { inject, ref } from 'vue';
import { api } from '@/api/client';
import { useToast } from '@/composables/useToast';
import type { StatusData, ServiceResult, ProxyEnvResult } from '@/api/types';

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

async function onToggle(e: Event) {
  const target = e.target as HTMLInputElement;
  const on = target.checked;
  try {
    const d = await api<ProxyEnvResult>('/proxy-env', { method: 'POST', body: { on } });
    toast(d.message, d.ok === false);
  } catch (err) {
    target.checked = !on; // 失败回弹
    toast(`切换失败: ${err instanceof Error ? err.message : err}`, true);
  }
  refreshStatus();
}
</script>

<template>
  <div class="grid">
    <div class="card">
      <h2>全局服务（systemd · TUN）</h2>
      <div class="row">
        <button class="primary" :disabled="busy" @click="doSvc('start')">启动</button>
        <button class="danger" :disabled="busy" @click="doSvc('stop')">停止</button>
        <button :disabled="busy" @click="doSvc('restart')">重启</button>
      </div>
      <div class="hint">stop / restart 会中断 TUN 全局透明代理，确认后执行</div>
    </div>

    <div class="card">
      <h2>终端代理（环境变量）</h2>
      <div class="toggle-box">
        <label class="switch">
          <input type="checkbox" :checked="props.status?.proxyOn ?? false" @change="onToggle" />
          <span class="slider"></span>
        </label>
        <div>
          <div class="proxy-state">{{ props.status ? (props.status.proxyOn ? '已开启' : '已关闭') : '…' }}</div>
          <div class="hint">写入 ~/.clash_proxy_on，影响新开终端的 shell 程序</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.proxy-state {
  font-weight: 600;
}
</style>
