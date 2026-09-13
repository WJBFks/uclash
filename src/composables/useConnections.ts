import { computed, onMounted, onUnmounted, shallowRef, watch } from 'vue';
import { api } from '@/api/client';
import type { ConnectionItem, ConnectionsData } from '@/api/types';
import { classifyCloseOutcome, reconcileSelection, type CloseOutcome, type CloseResponse } from '@/components/connections/helpers';

export type ConnectionState = 'active' | 'closed';
export type ConnectionSort = 'downloadSpeed' | 'uploadSpeed' | 'download' | 'upload';
const PAGE_SIZE = 50;

export function useConnections(compact = false) {
  const data = shallowRef<ConnectionsData>({ connections: [], closed: [] });
  const error = shallowRef(''), query = shallowRef(''), paused = shallowRef(false), busy = shallowRef(false), loading = shallowRef(true), page = shallowRef(1);
  const state = shallowRef<ConnectionState>('active');
  const sort = shallowRef<ConnectionSort>('downloadSpeed');
  const selected = shallowRef(new Set<string>());
  let inflight = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const filtered = computed(() => {
    const source = state.value === 'active' ? data.value.connections : data.value.closed ?? [];
    const needle = query.value.trim().toLocaleLowerCase();
    return source.filter((connection) => searchable(connection).includes(needle)).slice().sort((a, b) => (b[sort.value] ?? 0) - (a[sort.value] ?? 0));
  });
  const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)));
  const rows = computed(() => compact ? filtered.value.slice(0, 8) : filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE));
  async function load() {
    if (inflight || paused.value || document.hidden) return;
    inflight = true;
    try {
      data.value = await api<ConnectionsData>('/connections');
      selected.value = reconcileSelection(selected.value, data.value.connections);
      error.value = '';
    }
    catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
    finally { inflight = false; loading.value = false; }
  }
  function toggleSelection(id: string) { const next = new Set(selected.value); next.has(id) ? next.delete(id) : next.add(id); selected.value = next; }
  function selectPage() { selected.value = new Set(rows.value.map(({ id }) => id)); }
  function clearSelection() { selected.value = new Set(); }
  async function close(ids: string[]) {
    if (!ids.length || busy.value) return null;
    busy.value = true;
    try {
      const response = await api<CloseResponse>('/connections', { method: 'DELETE', body: { ids } });
      const outcome: CloseOutcome = classifyCloseOutcome(ids, response);
      selected.value = new Set(outcome.failedIds);
      await load();
      return outcome;
    }
    finally { busy.value = false; }
  }
  function onVisibilityChange() { if (!document.hidden) void load(); }
  watch([query, state, sort], () => { page.value = 1; clearSelection(); });
  watch(pages, (count) => { if (page.value > count) page.value = count; });
  onMounted(() => { void load(); timer = setInterval(() => void load(), 2000); document.addEventListener('visibilitychange', onVisibilityChange); });
  onUnmounted(() => { if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', onVisibilityChange); });
  return { data, error, query, state, sort, paused, busy, loading, page, selected, filtered, pages, rows, load, close, selectPage, toggleSelection };
}

function searchable(connection: ConnectionItem) {
  return [connection.process, connection.processLabel, connection.metadata?.host, connection.metadata?.sni, connection.metadata?.source, connection.metadata?.destination, connection.rule, connection.rulePayload, ...(connection.chains ?? [])].filter(Boolean).join(' ').toLocaleLowerCase();
}
