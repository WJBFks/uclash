export class ApiError extends Error {}

interface ApiOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  /** 超时毫秒，默认 8s：mihomo 慢/无响应时最多 8s 出明确报错，不再"无回音卡死" */
  timeout?: number;
}

interface Envelope<T> {
  ok?: boolean;
  error?: string;
  data?: T & { error?: string; message?: string };
}

/** 调用后端 /api/*（开发模式由 vite 代理，生产模式同源） */
export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const timeout = opts.timeout ?? 8000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method: opts.method ?? 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new ApiError(`请求超时（${Math.round(timeout / 1000)}s），mihomo 可能正忙，请稍后重试`);
    }
    throw new ApiError(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
  const j = (await res.json().catch(() => ({ ok: false, error: 'invalid response' }))) as Envelope<T>;
  if (!j.ok) {
    throw new ApiError((j.data && (j.data.error || j.data.message)) || j.error || `HTTP ${res.status}`);
  }
  return j.data as T;
}
