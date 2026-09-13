<script setup lang="ts">
import { nextTick, onUnmounted, useTemplateRef, watch } from 'vue';
import type { ConnectionItem } from '@/api/types';
import { processDisplay } from './helpers';
const props = defineProps<{ connection: ConnectionItem | null; busy?: boolean }>();
const emit = defineEmits<{ close: []; addRule: [connection: ConnectionItem]; disconnect: [connection: ConnectionItem] }>();
const dialog = useTemplateRef<HTMLElement>('dialog');
let previousFocus: HTMLElement | null = null, previousOverflow = '';
const value = (item: string | number | undefined) => item === undefined || item === '' ? '—' : String(item);
const chain = (c: ConnectionItem) => c.chains?.slice().reverse().join(' → ') || '—';
const endpoint = (c: ConnectionItem, side: 'source' | 'destination') => {
  const meta = c.metadata;
  const known = meta?.[side];
  if (known) return known;
  const ip = meta?.[`${side}IP`], port = meta?.[`${side}Port`];
  return ip && port !== undefined && port !== '' ? `${ip}:${port}` : ip || '—';
};
function close() { emit('close'); }
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); close(); return; }
  if (event.key !== 'Tab') return;
  const nodes = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])].filter((node) => node.offsetParent !== null);
  if (!nodes.length) return;
  const first = nodes[0], last = nodes.at(-1)!;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
watch(() => Boolean(props.connection), async (open) => {
  if (open) { previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; await nextTick(); dialog.value?.querySelector<HTMLElement>('[data-dialog-close]')?.focus(); }
  else {
    document.body.style.overflow = previousOverflow;
    if (previousFocus?.isConnected) previousFocus.focus();
    else document.querySelector<HTMLElement>('#main-content, [data-stable-panel]')?.focus();
    previousFocus = null;
  }
});
onUnmounted(() => { document.body.style.overflow = previousOverflow; });
</script>
<template><Teleport to="body"><div v-if="connection" class="connection-modal-mask" @click.self="close"><section ref="dialog" class="card connection-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-detail-title" tabindex="-1" @keydown="onKeydown"><div class="dialog-heading"><h2 id="connection-detail-title">连接详情</h2><button data-dialog-close aria-label="关闭详情" @click="close">关闭详情</button></div><dl class="detail-grid"><dt>域名</dt><dd>{{ value(connection.metadata?.host || connection.metadata?.sni) }}</dd><dt>进程</dt><dd>{{ processDisplay(connection) }}</dd><dt>来源</dt><dd>{{ endpoint(connection, 'source') }}</dd><dt>目标</dt><dd>{{ endpoint(connection, 'destination') }}</dd><dt>协议 / 入站</dt><dd>{{ value(connection.metadata?.network) }} / {{ value(connection.metadata?.type) }}</dd><dt>建立时间</dt><dd>{{ value(connection.start) }}</dd><dt>命中规则</dt><dd>{{ value(connection.rule) }} {{ connection.rulePayload || '' }}</dd><dt>代理链</dt><dd>{{ chain(connection) }}</dd></dl><div class="toolbar"><button @click="emit('addRule', connection)">为此域名添加规则</button><button v-if="!connection.closedAt" class="danger" :disabled="busy" @click="emit('disconnect', connection)">断开此连接</button></div></section></div></Teleport></template>
<style scoped>
.connection-modal-mask { position: fixed; inset: 0; z-index: 200; display: grid; place-items: center; padding: 16px; background: rgba(15, 23, 42, .45); overscroll-behavior: contain; }.connection-dialog { width: min(900px, 100%); max-height: calc(100vh - 32px); overflow: auto; }.dialog-heading { display: flex; justify-content: space-between; gap: 12px; align-items: center; }.dialog-heading h2 { margin: 0; }
</style>
