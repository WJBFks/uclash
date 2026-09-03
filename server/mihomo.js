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
    let done = false;
    const u = new URL(url);
    const data = body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      {
        host: u.hostname, port: u.port, path: u.pathname + u.search, method, timeout: timeoutMs,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      },
      (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => {
          if (done) return;
          done = true;
          let json = null;
          try { json = JSON.parse(b); } catch {}
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body: b, json });
        });
      }
    );
    req.on('timeout', () => {
      if (done) return;
      done = true;
      req.destroy();
      resolve({ status: 0, ok: false, body: '', json: null, error: 'timeout' });
    });
    req.on('error', (e) => {
      if (done) return;
      done = true;
      resolve({ status: 0, ok: false, body: '', json: null, error: String(e.message || e) });
    });
    if (data) req.write(data);
    req.end();
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
let trafficHistory = []; // [{ t, up, down }] bps
let lastTraffic = null;
let lastCumulative = { up: 0, down: 0, t: 0 };
let sampling = false;

async function sampleTraffic() {
  if (sampling) return; // in-flight 守卫：mihomo /traffic 慢时（可达 12s+）不让采样自身堆积
  sampling = true;
  try {
    const r = await httpJson(MIHOMO_API + '/traffic', 'GET', null, 20000);
    if (!r.ok || !r.json) return;
    lastCumulative = { up: Number(r.json.upload || 0), down: Number(r.json.download || 0), t: Date.now() };
    const cur = { up: lastCumulative.up, down: lastCumulative.down };
    let upRate = 0, downRate = 0;
    if (lastTraffic) {
      const dt = (Date.now() - lastTraffic.t) / 1000;
      if (dt > 0) {
        upRate = Math.max(0, (cur.up - lastTraffic.up) / dt);
        downRate = Math.max(0, (cur.down - lastTraffic.down) / dt);
      }
    }
    lastTraffic = { up: cur.up, down: cur.down, t: Date.now() };
    trafficHistory.push({ t: Date.now(), up: Math.round(upRate), down: Math.round(downRate) });
    if (trafficHistory.length > TRAFFIC_MAX) trafficHistory = trafficHistory.slice(-TRAFFIC_MAX);
  } finally {
    sampling = false;
  }
}

export function startTrafficSampler() {
  setInterval(sampleTraffic, 2000);
  sampleTraffic();
}

export function getTrafficSnapshot() {
  return {
    history: trafficHistory,
    live: { up: lastCumulative.up, down: lastCumulative.down },
    intervalMs: 2000,
    maxPoints: TRAFFIC_MAX,
  };
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
