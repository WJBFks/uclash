<script setup lang="ts">
import { computed } from 'vue';
import { bytes } from '@/utils/format';
import { useTraffic } from '@/composables/useTraffic';
import type { TrafficPoint } from '@/api/types';

const W = 640;
const H = 150;
const PAD_X = 8;
const PAD_Y = 12;
const { data, lastUpdated, loading, error, stale, reload } = useTraffic();

function trafficBytes(value: number) { return bytes(value).replace(/\.0(?= )/, ''); }

const history = computed(() => data.value?.history ?? []);
const last = computed(() => history.value.at(-1) ?? null);
const hasChart = computed(() => history.value.length >= 2);
const peak = computed(() => Math.max(1024, ...history.value.map((point) => Math.max(point.up, point.down))));
const isZeroTraffic = computed(() => hasChart.value && last.value?.up === 0 && last.value.down === 0);
const latestSampleTime = computed(() => last.value ? new Date(last.value.t).toLocaleTimeString('zh-CN') : '尚无样本');
const chartState = computed(() => {
  if (error.value) return stale.value ? `数据已过期：${error.value}` : `无法加载流量数据：${error.value}`;
  if (!hasChart.value) return loading.value ? '正在获取首个流量样本…' : `正在收集样本，还需要 ${Math.max(0, 2 - history.value.length)} 个样本`;
  return isZeroTraffic.value ? '当前无流量，持续采样中' : '正在采样';
});
const chartDescription = computed(() => `流量趋势图。${chartState.value}。峰值刻度 ${trafficBytes(peak.value)}/s，最新样本 ${latestSampleTime.value}。`);
const metricBlocks = computed(() => [
  { key: 'up-rate', label: '上传速率', value: last.value ? `${trafficBytes(last.value.up)}/s` : '—', tone: 'up' },
  { key: 'down-rate', label: '下载速率', value: last.value ? `${trafficBytes(last.value.down)}/s` : '—', tone: 'down' },
  { key: 'up-total', label: '上传累计', value: data.value ? trafficBytes(data.value.live.up) : '—', tone: 'total' },
  { key: 'down-total', label: '下载累计', value: data.value ? trafficBytes(data.value.live.down) : '—', tone: 'total' },
]);

function xAt(index: number, count: number) { return PAD_X + (index * (W - PAD_X * 2)) / Math.max(1, count - 1); }
function yAt(value: number) { return H - PAD_Y - (Math.min(value, peak.value) / peak.value) * (H - PAD_Y * 2); }
function points(key: keyof Pick<TrafficPoint, 'up' | 'down'>) {
  return history.value.map((point, index) => `${xAt(index, history.value.length).toFixed(1)},${yAt(point[key]).toFixed(1)}`).join(' ');
}
function areaOf(key: keyof Pick<TrafficPoint, 'up' | 'down'>) {
  if (!history.value.length) return '';
  return `${PAD_X},${H - PAD_Y} ${points(key)} ${xAt(history.value.length - 1, history.value.length).toFixed(1)},${H - PAD_Y}`;
}
</script>

<template>
  <section class="card traffic-card" aria-labelledby="traffic-title">
    <div class="traffic-heading">
      <div>
        <h2 id="traffic-title">实时流量（2s 采样 · 最近 4 分钟）</h2>
        <p class="traffic-meta">峰值 {{ trafficBytes(peak) }}/s · 最新样本 {{ latestSampleTime }}</p>
      </div>
      <button class="traffic-reload" type="button" :disabled="loading" @click="reload">{{ loading ? '更新中…' : '刷新' }}</button>
    </div>
    <div class="traffic-read" aria-label="当前流量指标">
      <div v-for="metric in metricBlocks" :key="metric.key" class="traffic-metric" :class="metric.tone">
        <div class="t">{{ metric.label }}</div><div class="b">{{ metric.value }}</div>
      </div>
    </div>
    <svg class="chart" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" :aria-label="chartDescription">
      <title>实时流量趋势</title><desc>{{ chartDescription }}</desc>
      <g class="chart-grid" aria-hidden="true">
        <line v-for="position in [0.2, 0.4, 0.6, 0.8]" :key="position" :x1="PAD_X" :x2="W - PAD_X" :y1="PAD_Y + (H - PAD_Y * 2) * position" :y2="PAD_Y + (H - PAD_Y * 2) * position" />
        <line :x1="PAD_X" :x2="W - PAD_X" :y1="H - PAD_Y" :y2="H - PAD_Y" class="chart-baseline" />
      </g>
      <template v-if="hasChart">
        <polygon :points="areaOf('down')" class="chart-area down" /><polyline :points="points('down')" class="chart-line down" />
        <polygon :points="areaOf('up')" class="chart-area up" /><polyline :points="points('up')" class="chart-line up" />
      </template>
    </svg>
    <p v-if="!hasChart" class="chart-empty" aria-live="polite">{{ chartState }}</p>
    <div class="traffic-footer">
      <p class="traffic-state" :class="{ warning: stale || error }" aria-live="polite">{{ chartState }}</p>
      <div class="legend" aria-label="图例"><span><i class="up-c"></i>上传</span><span><i class="down-c"></i>下载</span></div>
      <span class="traffic-updated">{{ lastUpdated ? `面板更新 ${lastUpdated.toLocaleTimeString('zh-CN')}` : '等待数据' }}</span>
    </div>
  </section>
</template>

<style lang="scss" scoped>
.traffic-card { overflow: hidden; }
.traffic-heading { display: flex; align-items: start; justify-content: space-between; gap: 16px; }
.traffic-heading h2 { margin-bottom: 2px; }
.traffic-meta, .traffic-state, .traffic-updated { margin: 0; font-size: 12px; color: #6b7280; }
.traffic-reload { padding: 5px 9px; flex: 0 0 auto; font-size: 12px; }
.traffic-read { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 14px 0 10px; }
.traffic-metric { min-width: 0; padding: 8px 10px; border-left: 2px solid #d1d5db; background: #f8fafc; }
.traffic-metric .t { font-size: 12px; color: #6b7280; }
.traffic-metric .b { overflow: hidden; font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
.traffic-metric.up { border-color: #2563eb; }.traffic-metric.up .b { color: #2563eb; }
.traffic-metric.down { border-color: #16a34a; }.traffic-metric.down .b { color: #15803d; }
.chart { width: 100%; height: 150px; display: block; background: #fcfdff; }
.chart-grid line { stroke: #e5e7eb; stroke-width: 1; vector-effect: non-scaling-stroke; }.chart-grid .chart-baseline { stroke: #9ca3af; }
.chart-area { opacity: .55; }.chart-area.up { fill: #dbeafe; }.chart-area.down { fill: #dcfce7; }
.chart-line { fill: none; stroke-width: 2; vector-effect: non-scaling-stroke; }.chart-line.up { stroke: #2563eb; }.chart-line.down { stroke: #16a34a; }
.chart-empty { margin: 6px 0 0; min-height: 18px; color: #6b7280; font-size: 14px; text-align: center; }
.traffic-footer { display: flex; align-items: center; gap: 14px; margin-top: 7px; }.traffic-state.warning { color: #b45309; }
.traffic-updated { margin-left: auto; white-space: nowrap; }.legend { margin-top: 0; }
@media (max-width: 620px) { .traffic-read { grid-template-columns: repeat(2, minmax(0, 1fr)); }.traffic-footer { align-items: flex-start; flex-wrap: wrap; gap: 6px 12px; }.traffic-updated { width: 100%; margin-left: 0; } }
@media (prefers-reduced-motion: reduce) { .chart-line { transition: none; } }
</style>
