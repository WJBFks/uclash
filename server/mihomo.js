/**
 * mihomo 交互原语：子进程执行、本地 API HTTP 客户端、出口 IP、流量采样器、providers 快照
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';

const MIHOMO_API = config.mihomoApi;

/** 带超时的子进程执行（永不 reject，超时 code=124，失败 code=-1） */
export function run(cmd, args, timeoutMs = 30000, env = {}) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { proc.kill('SIGKILL'); } catch {}
      resolve({ code: 124, stdout: '', stderr: 'timeout' });
    }, timeoutMs);
    const proc = spawn(cmd, args, { env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    proc.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: String(e.message || e) });
    });
  });
}

/** mihomo 本地 API JSON 请求（永不 reject） */
export function httpJson(url, method = 'GET', body = null, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false, req, timer;
    const finish = (result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(result);
    };
    const fail = (error) => finish({ status: 0, ok: false, body: '', json: null, error });
    try {
      const u = new URL(url);
      if (!['http:', 'https:'].includes(u.protocol)) return fail('unsupported protocol');
      const data = body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
      req = (u.protocol === 'https:' ? https : http).request(u, {
        method,
        headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(config.mihomoSecret && u.origin === new URL(MIHOMO_API).origin ? { Authorization: `Bearer ${config.mihomoSecret}` } : {}) },
      }, (res) => {
        const chunks = []; let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) { fail('response too large'); req.destroy(); return; }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null; try { json = JSON.parse(text); } catch {}
          finish({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body: text, json });
        });
        res.on('error', (e) => fail(e.message));
        res.on('aborted', () => fail('response aborted'));
      });
      // Absolute deadline: a streaming response cannot keep this request alive
      // indefinitely merely by sending another byte before an idle timeout.
      timer = setTimeout(() => { fail('timeout'); req.destroy(); }, timeoutMs);
      req.on('error', (e) => fail(e.message));
      if (data) req.write(data);
      req.end();
    } catch (e) { fail(e.message); req?.destroy(); }
  });
}

/**
 * 取当前出口 IP（api.ipify.org）。
 * 注意：本进程出站会被 TUN 抓取，按 mihomo 规则走当前代理/直连 —— 即“当前出口 IP”。
 */
export function fetchExitIp(timeoutMs = 12000) {
  return new Promise((resolve) => {
    let done = false;
    const req = https.get({ host: 'api.ipify.org', port: 443, path: '/', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        if (done) return;
        done = true;
        resolve(body.trim() || 'N/A');
      });
    });
    req.on('timeout', () => {
      if (done) return;
      done = true;
      req.destroy();
      resolve('N/A');
    });
    req.on('error', () => {
      if (done) return;
      done = true;
      resolve('N/A');
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 流量历史（环形缓冲，2s 采样，保留 120 点 ≈ 4 分钟） ----------
const TRAFFIC_MAX = 120;

/** Calculate byte-per-second rates from consecutive cumulative traffic samples. */
export function calculateTrafficRates(previous, current) {
  if (!previous || !current) return { up: 0, down: 0 };
  const elapsedSeconds = (Number(current.t) - Number(previous.t)) / 1000;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return { up: 0, down: 0 };

  const rate = (key) => {
    const delta = Number(current[key]) - Number(previous[key]);
    const value = delta / elapsedSeconds;
    return Number.isFinite(value) && delta >= 0 && value >= 0 ? value : 0;
  };
  return { up: rate('up'), down: rate('down') };
}

/** Shared, bounded-stale raw /connections snapshot for all local readers. */
export function createConnectionsSnapshot({
  request,
  now = () => Date.now(),
  ttlMs = 2000,
}) {
  let value = null;
  let sampledAt = 0;
  let generation = 0;
  let pending = null;

  const result = (fresh, error = null) => ({ data: value, generation, sampledAt, fresh, error });
  const read = async () => {
    if (value && now() - sampledAt < ttlMs) return result(false);
    if (!pending) {
      pending = Promise.resolve(request())
        .then((next) => {
          if (!next) return result(false, 'request failed');
          value = next; sampledAt = now(); generation++;
          return result(true);
        })
        .catch(() => result(false, 'request failed'))
        .finally(() => { pending = null; });
    }
    return pending;
  };

  return { read };
}

const connectionsSnapshot = createConnectionsSnapshot({
  request: async () => {
    const result = await httpJson(MIHOMO_API + '/connections', 'GET', null, 10000);
    return result.ok && result.json ? result.json : null;
  },
});

export function getConnectionsSnapshot() {
  return connectionsSnapshot.read();
}

export function createTrafficSampler({
  readTotals,
  now = () => Date.now(),
  schedule = (callback, intervalMs) => setInterval(callback, intervalMs),
  cancel = (timer) => clearInterval(timer),
}) {
  let trafficHistory = []; // [{ t, up, down }] bps
  let lastTraffic = null;
  let lastCumulative = { up: 0, down: 0, t: 0 };
  let lastGeneration = null;
  let sampling = false;

  const sample = async () => {
    if (sampling) return; // in-flight 守卫：mihomo /connections 慢时不让采样自身堆积
    sampling = true;
    try {
      const read = await readTotals();
      const isSnapshot = read && typeof read === 'object' && 'generation' in read && 'data' in read;
      if (isSnapshot && (read.error || read.generation === lastGeneration)) return;
      if (isSnapshot) lastGeneration = read.generation;
      const totals = isSnapshot ? read.data : read;
      if (!totals) return;
      const t = isSnapshot ? read.sampledAt : now();
      if (!Number.isFinite(totals.uploadTotal) || totals.uploadTotal < 0 ||
          !Number.isFinite(totals.downloadTotal) || totals.downloadTotal < 0) return;
      const current = { up: totals.uploadTotal, down: totals.downloadTotal, t };
      lastCumulative = current;
      const rates = calculateTrafficRates(lastTraffic, current);
      lastTraffic = current;
      trafficHistory.push({ t, up: Math.round(rates.up), down: Math.round(rates.down) });
      if (trafficHistory.length > TRAFFIC_MAX) trafficHistory = trafficHistory.slice(-TRAFFIC_MAX);
    } finally {
      sampling = false;
    }
  };

  return {
    sample,
    start() {
      const timer = schedule(sample, 2000);
      return () => cancel(timer);
    },
    getSnapshot() {
      return {
        history: trafficHistory,
        live: { up: lastCumulative.up, down: lastCumulative.down },
        intervalMs: 2000,
        maxPoints: TRAFFIC_MAX,
      };
    },
  };
}

const trafficSampler = createTrafficSampler({
  readTotals: getConnectionsSnapshot,
});

export function startTrafficSampler() {
  const stop = trafficSampler.start();
  trafficSampler.sample();
  return stop;
}

export function getTrafficSnapshot() {
  return trafficSampler.getSnapshot();
}

// ---------- providers 缓存文件快照（验证订阅是否真的被 mihomo 拉取） ----------
// mihomo 拉取 http 订阅成功后必然重写 ~/.config/mihomo/providers/<name>.yaml，
// 用文件 mtime 变化作为「订阅已更新」的唯一事实依据（API 调通 ≠ 拉取成功）。
const PROVIDERS_DIR = path.join(path.dirname(config.mihomoCfg), 'providers');

export function snapshotProviders() {
  try {
    const m = {};
    for (const f of fs.readdirSync(PROVIDERS_DIR)) {
      const st = fs.statSync(path.join(PROVIDERS_DIR, f));
      if (st.isFile()) m[f] = Math.floor(st.mtimeMs);
    }
    return m;
  } catch {
    return {};
  }
}
