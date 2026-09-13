// Only infer closed connections from successful full snapshots.
export function createConnectionTracker(limit = 200) {
  let previous = new Map(), sampledAt = 0, closed = [];
  return (connections, now = Date.now()) => {
    const dt = (now - sampledAt) / 1000;
    const active = connections.map((c) => {
      const m = c.metadata || {}, old = previous.get(c.id);
      const process = [c.process, m.processPath, m.process].find((value) => typeof value === 'string' && value.trim()) || '';
      const processLabel = process.split(/[\\/]/).filter(Boolean).pop() || '';
      return { ...c, process,
        processAvailable: Boolean(process),
        processLabel: processLabel || '进程信息不可用',
        metadata: { ...m, source: m.source || [m.sourceIP, m.sourcePort].filter(Boolean).join(':'),
          destination: m.destination || [m.destinationIP, m.destinationPort].filter(Boolean).join(':') },
        uploadSpeed: old && dt > 0 ? Math.max(0, (c.upload - old.upload) / dt) : 0,
        downloadSpeed: old && dt > 0 ? Math.max(0, (c.download - old.download) / dt) : 0 };
    });
    const next = new Map(active.map((c) => [c.id, c]));
    for (const c of previous.values()) if (!next.has(c.id)) closed.unshift({ ...c, uploadSpeed: 0, downloadSpeed: 0, closedAt: now });
    closed = closed.filter((c) => !next.has(c.id)).slice(0, limit);
    previous = next; sampledAt = now;
    return { connections: active, closed, sampledAt };
  };
}

/** Normalize each raw snapshot generation once so speed deltas remain stable for cache hits. */
export function createConnectionResponseCache(track = createConnectionTracker()) {
  let generation = null;
  let response = null;
  return (snapshot) => {
    if (snapshot.generation !== generation) {
      response = track(snapshot.data.connections, snapshot.sampledAt);
      generation = snapshot.generation;
    }
    return response;
  };
}
