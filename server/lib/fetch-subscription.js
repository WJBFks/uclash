// A deadline includes the response body; cap untrusted subscription downloads.
export async function fetchSubscription(url, { headersOnly = false, timeout = 20000, limit = 4 * 1024 * 1024 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let reader;
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'clash.meta' } });
    if (!res.ok) { await res.body?.cancel(); throw new Error(`订阅请求失败 HTTP ${res.status}`); }
    if (headersOnly) { await res.body?.cancel(); return { headers: res.headers, text: '' }; }
    reader = res.body?.getReader();
    const chunks = []; let size = 0;
    if (reader) while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('订阅超过 4 MiB 限制');
      chunks.push(Buffer.from(value));
    }
    return { headers: res.headers, text: Buffer.concat(chunks).toString('utf8') };
  } finally {
    ctrl.abort(); clearTimeout(timer);
    if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); }
  }
}
