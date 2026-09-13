function safeFetchError(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return new Error('订阅请求超时');
  if (error?.safeMessage) return new Error(error.safeMessage);
  const code = error?.cause?.code || error?.code;
  return new Error(`订阅网络请求失败${code ? `（${String(code).slice(0, 80)}）` : ''}`);
}

function wait(ms) {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

// A deadline includes retries and the response body; cap untrusted subscription downloads.
export async function fetchSubscription(url, {
  headersOnly = false,
  timeout = 20000,
  limit = 4 * 1024 * 1024,
  attempts = 3,
  retryDelay = 250,
  fetchImpl = fetch,
} = {}) {
  const deadline = Date.now() + timeout;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('订阅请求超时');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), remaining);
    let reader;
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'clash.meta' } });
      if (!res.ok) {
        await res.body?.cancel();
        const error = new Error(`HTTP ${res.status}`);
        error.safeMessage = `订阅请求失败 HTTP ${res.status}`;
        error.retryable = res.status === 429 || res.status >= 500;
        throw error;
      }
      if (headersOnly) {
        await res.body?.cancel();
        return { headers: res.headers, text: '' };
      }
      reader = res.body?.getReader();
      const chunks = [];
      let size = 0;
      if (reader) while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          const error = new Error('订阅超过 4 MiB 限制');
          error.safeMessage = error.message;
          error.retryable = false;
          throw error;
        }
        chunks.push(Buffer.from(value));
      }
      return { headers: res.headers, text: Buffer.concat(chunks).toString('utf8') };
    } catch (error) {
      lastError = error;
      const canRetry = error?.retryable !== false
        && attempt < attempts
        && Date.now() + retryDelay < deadline;
      if (!canRetry) throw safeFetchError(error);
    } finally {
      clearTimeout(timer);
      ctrl.abort();
      if (reader) {
        try { await reader.cancel(); } catch {}
        reader.releaseLock();
      }
    }
    await wait(retryDelay);
  }

  throw safeFetchError(lastError);
}
