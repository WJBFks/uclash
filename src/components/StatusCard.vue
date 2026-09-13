<script setup lang="ts">
import { computed } from 'vue';
import type { StatusData } from '@/api/types';

const props = defineProps<{
  status: StatusData | null;
  statusError: boolean;
  lastUpdated: Date | null;
}>();
defineEmits<{ (e: 'refreshIp'): void }>();

const svcClass = computed(() => {
  const s = props.status?.service;
  if (s === 'active') return 'on';
  if (s === 'failed') return 'err';
  return 'off';
});
const svcText = computed(() => {
  if (!props.status) return props.statusError ? '无法连接后端' : '…';
  const s = props.status.service;
  if (s === 'active') return '运行中';
  if (s === 'failed') return '失败';
  return s || '未知';
});
const timeText = computed(() =>
  props.lastUpdated ? `· 更新于 ${props.lastUpdated.toLocaleTimeString('zh-CN', { hour12: false })}` : ''
);
const MODE_TEXT = { rule: '规则', global: '全局', direct: '直连' };
const modeText = computed(() => {
  const m = props.status?.mode;
  return m ? (MODE_TEXT[m as keyof typeof MODE_TEXT] || m) : '…';
});
</script>

<template>
  <div class="card">
    <h2>状态总览 <span class="muted normal">{{ timeText }}</span></h2>
    <div class="kv">
      <div class="item">
        <div class="k">服务状态</div>
        <div class="v"><span :class="['dot', svcClass]" aria-hidden="true"></span>{{ svcText }}</div>
      </div>
      <div class="item">
        <div class="k">TUN 全局</div>
        <div class="v">
          <span :class="['dot', (status?.tun ? 'on' : 'off')]" aria-hidden="true"></span>
          {{ status?.tun ? `开启 (${status.tun})` : '关闭' }}
        </div>
      </div>
      <div class="item">
        <div class="k">当前节点</div>
        <div class="v">{{ status?.node || '未知' }}</div>
      </div>
      <div class="item">
        <div class="k">模式</div>
        <div class="v">{{ modeText }}</div>
      </div>
      <div class="item">
        <div class="k">出口 IP <button class="small" aria-label="刷新出口 IP" @click="$emit('refreshIp')">↻</button></div>
        <div class="v">{{ status?.exitIp || '获取中…' }}</div>
      </div>
    </div>
  </div>
</template>
