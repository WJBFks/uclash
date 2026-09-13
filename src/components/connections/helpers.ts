export interface CloseResult { id: string; ok: boolean }
export interface CloseResponse { results?: CloseResult[] }
export interface CloseOutcome {
  kind: 'all' | 'partial' | 'none';
  succeededIds: string[];
  failedIds: string[];
  message: string;
}

export function classifyCloseOutcome(ids: string[], response: CloseResponse): CloseOutcome {
  const resultById = new Map(response.results?.map((result) => [result.id, result.ok]));
  const succeededIds = response.results ? ids.filter((id) => resultById.get(id) === true) : [...ids];
  const failedIds = ids.filter((id) => !succeededIds.includes(id));
  if (!failedIds.length) return { kind: 'all', succeededIds, failedIds, message: `已关闭 ${ids.length} 个连接` };
  if (!succeededIds.length) return { kind: 'none', succeededIds, failedIds, message: `未能关闭 ${ids.length} 个连接` };
  return { kind: 'partial', succeededIds, failedIds, message: `已关闭 ${succeededIds.length}/${ids.length} 个连接；未关闭 ${failedIds.length} 个` };
}

export function reconcileSelection(selected: Set<string>, active: { id: string }[]) {
  const activeIds = new Set(active.map(({ id }) => id));
  return new Set([...selected].filter((id) => activeIds.has(id)));
}

export function deriveDetailConnection<T extends { id: string }>(id: string | null, active: T[], closed: T[]) {
  if (!id) return null;
  return active.find((connection) => connection.id === id) ?? closed.find((connection) => connection.id === id) ?? null;
}

export function formatSpeed(value: number | null | undefined, formatBytes: (value: number) => string) {
  return value == null || !Number.isFinite(value) ? '—' : `${formatBytes(value)}/s`;
}

export function processDisplay(connection: { processLabel?: string; process?: string }) {
  const label = connection.processLabel?.trim();
  if (label) return label;
  const basename = connection.process?.trim().split(/[\\/]/).filter(Boolean).pop();
  return basename || '进程信息不可用';
}
