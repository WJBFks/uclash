export class ApiError extends Error {}
interface ApiOptions { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; timeout?: number }
interface Envelope<T> { ok?: boolean; error?: string; data?: T & { error?: string; message?: string } }
export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const timeout = opts.timeout ?? 8000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const token = sessionStorage.getItem('cw-token');
    const res = await fetch('/api' + path, {
      method: opts.method ?? 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, signal: ctrl.signal,
    });
    if (res.status === 401) window.dispatchEvent(new Event('cw-auth-required'));
    const j = await res.json() as Envelope<T>;
    if (!j.ok) throw new ApiError(j.data?.error || j.data?.message || j.error || `HTTP ${res.status}`);
    return j.data as T;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new ApiError(`请求超时（${Math.round(timeout / 1000)}s），请刷新确认操作结果后再重试`);
    throw e instanceof Error ? e : new ApiError(String(e));
  } finally { clearTimeout(timer); }
}
