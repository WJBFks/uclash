<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '@/api/client';
import { bytes } from '@/utils/format';
import type { TrafficData } from '@/api/types';

const W = 640;
const H = 120;
const PAD = 4;

const data = ref<TrafficData | null>(null);
let inflight = false;
let timer: ReturnType<typeof setInterval> | null = null;

async function load() {
  if (inflight) return; // in-flight 合并：上一发没回来就不重复发，防 mihomo 卡时堆积
  inflight = true;
  try {
    data.value = await api<TrafficData>('/traffic');
  } catch {
    /* 静默 */
  } finally {
    inflight = false;
  }
}

const maxVal = computed(() => {
  const h = data.value?.history ?? [];
  if (!h.length) return 1024;
  return Math.max(1024, ...h.map((p) => Math.max(p.up, p.down)));
});

function xAt(i: number, n: number): number {
  return PAD + (i * (W - 2 * PAD)) / Math.max(1, n - 1);
}
function yAt(v: number): number {
  return H - PAD - (Math.min(v, maxVal.value) / maxVal.value) * (H - 2 * PAD);
}
function points(key: 'up' | 'down'): string {
  const h = data.value?.history ?? [];
  if (!h.length) return '';
  return h.map((p, i) => `${xAt(i, h.length).toFixed(1)},${yAt(p[key]).toFixed(1)}`).join(' ');
}
function areaOf(key: 'up' | 'down'): string {
  const h = data.value?.history ?? [];
  if (!h.length) return '';
  return `${PAD},${H - PAD} ${points(key)} ${xAt(h.length - 1, h.length).toFixed(1)},${H - PAD}`;
}
const last = computed(() => {
  const h = data.value?.history;
  return h && h.length ? h[h.length - 1] : null;
});

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
    <h2>实时流量（2s 采样 · 最近 4 分钟）</h2>
    <div class="traffic-read">
      <div class="up"><div class="t">↑ 上传速率</div><div class="b">{{ last ? bytes(last.up) + '/s' : '—' }}</div></div>
      <div class="down"><div class="t">↓ 下载速率</div><div class="b">{{ last ? bytes(last.down) + '/s' : '—' }}</div></div>
      <div><div class="t">↑ 累计</div><div class="b total">{{ data ? bytes(data.live.up) : '—' }}</div></div>
      <div><div class="t">↓ 累计</div><div class="b total">{{ data ? bytes(data.live.down) : '—' }}</div></div>
    </div>
    <svg class="chart" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none">
      <template v-if="data && data.history.length">
        <polygon :points="areaOf('down')" fill="rgba(22,163,74,.07)" />
        <polyline :points="points('down')" fill="none" stroke="#16a34a" stroke-width="2" />
        <polygon :points="areaOf('up')" fill="rgba(37,99,235,.07)" />
        <polyline :points="points('up')" fill="none" stroke="#2563eb" stroke-width="2" />
      </template>
    </svg>
    <div class="legend">
      <span><i class="up-c"></i>上传</span>
      <span><i class="down-c"></i>下载</span>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.b.total {
  font-size: 14px;
}
</style>
