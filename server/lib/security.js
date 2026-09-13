import { timingSafeEqual } from 'node:crypto';

export function authorize(req, config) {
  const local = ['127.0.0.1', '::1', 'localhost'].includes(config.host);
  if (!local && !config.token) return { status: 403, error: '远程管理需配置 CW_TOKEN' };
  const host = req.headers.host;
  const origin = req.headers.origin;
  // Do not trust Host alone on a tokenless loopback server (DNS rebinding).
  if (!config.token) {
    let hostname;
    try { hostname = new URL(`http://${host}`).hostname; } catch {}
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return { status: 403, error: 'Host 不被允许' };
  }
  if (origin && origin !== `http://${host}` && origin !== `https://${host}` && !config.allowedOrigins.includes(origin)) {
    return { status: 403, error: '请求来源不被允许' };
  }
  if (!origin && req.headers['sec-fetch-site'] === 'cross-site') return { status: 403, error: '拒绝跨站请求' };
  if (config.token && req.method !== 'OPTIONS') {
    const supplied = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${config.token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return { status: 401, error: '请输入有效的管理访问密钥' };
    }
  }
  return null;
}
