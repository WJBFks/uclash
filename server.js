#!/usr/bin/env node
/**
 * clash-web — mihomo 代理管理 Web UI
 * 零依赖 Node 后端：静态文件托管 + /api/* JSON 路由，统一监听 15924 端口
 * 操作语义与 ~/.zshrc 中 clash() 命令集一致（on/off/start/stop/restart/list/set/update/import/status/version）
 */
'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT || 15924);
const HOST = '0.0.0.0';
const MIHOMO_API = 'http://127.0.0.1:9090';
const HOME = os.homedir();
const PROXY_ON_FILE = path.join(HOME, '.clash_proxy_on');
const MIHOMO_BIN = '/usr/local/bin/mihomo';
const MIHOMO_CFG = path.join(HOME, '.config/mihomo/config.yaml');
const IMPORT_SCRIPT = path.join(__dirname, 'lib', 'import-sub.py');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ~/.clash_proxy_on 内容（与 zshrc 完全一致）
const PROXY_ON_CONTENT =
  'export http_proxy="http://127.0.0.1:7890"\n' +
  'export https_proxy="http://127.0.0.1:7890"\n' +
  'export all_proxy="socks5://127.0.0.1:7890"\n' +
  'export no_proxy="localhost,127.0.0.1,::1"\n';

// ---------- 基础工具 ----------
function run(cmd, args, timeoutMs = 30000, env = {}) {
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

function httpJson(url, method = 'GET', body = null, timeoutMs = 15000) {
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

// 通用 HTTP 请求（测延迟用；跟随 TUN 系统代理，不读环境变量代理）
function httpRaw(protocol, host, port, p, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let done = false;
    const mod = protocol === 'https:' ? require('node:https') : require('node:http');
    const req = mod.get(
      { host, port, path: p, timeout: timeoutMs, servername: host.replace(/^\[|\]$/g, '') },
      (res) => {
        res.resume();
        res.on('end', () => {
          if (done) return;
          done = true;
          resolve({ status: res.statusCode });
        });
      }
    );
    req.on('timeout', () => {
      if (done) return;
      done = true;
      req.destroy();
      resolve({ status: 0, error: '请求超时' });
    });
    req.on('error', (e) => {
      if (done) return;
      done = true;
      resolve({ status: 0, error: String(e.message || e) });
    });
  });
}

// 禁用代理强制直连，取真实出口 IP（与 zshrc status 子命令一致）
function fetchExitIp(timeoutMs = 12000) {
  return new Promise((resolve) => {
    let done = false;
    const req = https.get(
      { host: 'api.ipify.org', port: 443, path: '/', timeout: timeoutMs, agent: new https.Agent({ noProxy: true }) },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (done) return;
          done = true;
          resolve(body.trim() || 'N/A');
        });
      }
    );
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
setInterval(sampleTraffic, 2000);
sampleTraffic();

// ---------- API 处理器 ----------
const handlers = {
  // 状态总览（= clash status）
  async 'GET /api/status'() {
    const [svc, tun, proxyR, proxyOn, exitIp, verR] = await Promise.all([
      run('systemctl', ['--user', 'is-active', 'mihomo'], 10000),
      run('bash', ['-c', "ip -br link 2>/dev/null | awk '{print $1}' | grep -E '^(Meta|tun)' | head -1"], 10000),
      httpJson(MIHOMO_API + '/proxies/PROXY'),
      Promise.resolve(fs.existsSync(PROXY_ON_FILE)),
      fetchExitIp(),
      run(MIHOMO_BIN, ['-v'], 10000),
    ]);
    return {
      service: svc.code === 0 && svc.stdout === 'active' ? 'active' : svc.stdout || 'unknown',
      tun: tun.stdout || null,
      node: proxyR.ok && proxyR.json && typeof proxyR.json.now === 'string' ? proxyR.json.now.trim() : null,
      proxyOn,
      exitIp,
      version: verR.code === 0 && verR.stdout ? verR.stdout.split('\n')[0] : null,
      mihomoAlive: Boolean(proxyR.ok && proxyR.json),
    };
  },

  // 服务 start / stop / restart
  async 'POST /api/service'({ action }) {
    if (!['start', 'stop', 'restart'].includes(action)) return { ok: false, error: 'invalid action' };
    await run('systemctl', ['--user', action, 'mihomo'], 60000);
    await new Promise((r) => setTimeout(r, 2000));
    const svc = await run('systemctl', ['--user', 'is-active', 'mihomo'], 10000);
    const active = svc.stdout === 'active';
    return {
      ok: action === 'stop' ? !active : active,
      service: svc.stdout || 'unknown',
      message:
        action === 'start' ? (active ? '全局代理服务已启动（TUN 透明代理接管所有流量）' : '启动失败，检查: systemctl --user status mihomo')
        : action === 'stop' ? (!active ? '全局代理服务已停止（TUN 已关闭，流量回直连）' : '停止失败')
        : active ? '全局代理服务已重启（TUN 重新接管）' : '重启失败',
    };
  },

  // 终端代理开关（= clash on / off）
  async 'POST /api/proxy-env'({ on }) {
    if (on) {
      const r = await httpJson(MIHOMO_API + '/version');
      if (!r.ok) return { ok: false, error: 'mihomo 未在运行，无法开启终端代理（先启动全局服务）' };
      fs.writeFileSync(PROXY_ON_FILE, PROXY_ON_CONTENT);
      return { ok: true, message: 'clash 代理已开启（之后新开的终端均生效）' };
    }
    fs.rmSync(PROXY_ON_FILE, { force: true });
    return { ok: true, message: 'clash 终端代理已关闭（如需关闭全局 TUN，用停止服务）' };
  },

  // 节点列表（= clash list）
  async 'GET /api/proxies'() {
    const r = await httpJson(MIHOMO_API + '/proxies/PROXY');
    if (!r.ok || !r.json) return { ok: false, error: '获取节点列表失败（mihomo 服务未运行？）' };
    // 注意：节点名保留原样（部分节点名含前导/尾随空格，trim 后 PUT 会 400）
    return { ok: true, now: (r.json.now || '').trim(), all: (r.json.all || []).map((n) => String(n)) };
  },

  // 切换节点（= clash set）
  async 'POST /api/proxy-set'({ name }) {
    if (!name || typeof name !== 'string') return { ok: false, error: '节点名不能为空' };
    const putR = await httpJson(MIHOMO_API + '/proxies/PROXY', 'PUT', { name });
    if (!putR.ok) return { ok: false, error: '切换失败（mihomo API 无响应）' };
    return { ok: true, message: `已切换到: ${name}` };
  },

  // 节点延迟测试：mihomo 原生 healthcheck 端点，24 并发，不切换当前选择器、互不干扰
  async 'POST /api/proxy-test'({ url, nodes }) {
    if (!Array.isArray(nodes) || nodes.length === 0) return { ok: false, error: 'nodes 不能为空' };
    let testUrl = (url || '').trim() || 'https://www.google.com/generate_204';
    if (!/^https?:\/\/.+/i.test(testUrl)) return { ok: false, error: '测试 URL 无效（需 http(s):// 开头）' };
    const names = [...new Set(nodes.map((n) => String(n)).filter((n) => n.trim() !== ''))];

    // 节点属于哪个 provider（/proxies 顶层只有组，具体节点要走 /providers/proxies/{provider}/...）
    // 注意：/providers/proxies 返回 { providers: { <name>: {name, proxies:[...]} } } —— 是对象不是数组
    const provR = await httpJson(MIHOMO_API + '/providers/proxies');
    const provObj = (provR.ok && provR.json && provR.json.providers) || {};
    const providerNames = Array.isArray(provObj) ? provObj.map((p) => p.name) : Object.keys(provObj);
    const byProvider = {};
    for (const pname of providerNames) {
      try {
        const det = await httpJson(MIHOMO_API + '/providers/proxies/' + encodeURIComponent(pname));
        if (det.ok && det.json && Array.isArray(det.json.proxies)) {
          byProvider[pname] = new Set(det.json.proxies.map((x) => x.name));
        }
      } catch {}
    }
    // 归属表：节点名 -> provider（都找不到时回退到第一个 provider）
    const owner = {};
    for (const n of names) {
      owner[n] = Object.keys(byProvider).find((pr) => byProvider[pr].has(n)) || providerNames[0] || 'mysub';
    }

    // 单项 healthcheck：GET /providers/proxies/{provider}/{name}/healthcheck?url=..&timeout=10000
    const PER_TEST_TIMEOUT = 10000;
    const testOne = (name) =>
      new Promise((resolve) => {
        const provider = owner[name];
        const encName = encodeURIComponent(name);
        const p = `/providers/proxies/${encodeURIComponent(provider)}/${encName}/healthcheck?url=${encodeURIComponent(testUrl)}&timeout=${PER_TEST_TIMEOUT}`;
        const done = (val) => resolve(val);
        const req = http.request(
          { host: '127.0.0.1', port: 9090, path: p, method: 'GET', timeout: PER_TEST_TIMEOUT + 3000 },
          (res) => {
            let b = '';
            res.on('data', (d) => (b += d));
            res.on('end', () => {
              let delay = null;
              try {
                if (res.statusCode === 200) delay = JSON.parse(b).delay;
              } catch {}
              done({ name, ok: res.statusCode === 200 && delay !== null && delay >= 0, latency: delay, http: res.statusCode, error: res.statusCode === 200 ? null : '测速失败（节点不通或 DNS 解析失败）' });
            });
          }
        );
        req.on('timeout', () => req.destroy());
        req.on('error', () => done({ name, ok: false, latency: null, http: null, error: 'mihomo API 无响应' }));
        req.end();
      });

    // 24 并发（mihomo 侧各自独立出站测试，不抢选择器，可安全全量并发）
    const results = await Promise.all(names.map(testOne));
    return { ok: true, url: testUrl, count: results.length, method: 'healthcheck', results };
  },

  // 订阅列表
  async 'GET /api/subscriptions'() {
    const r = await httpJson(MIHOMO_API + '/subscriptions');
    if (!r.ok || !r.json) return { ok: false, error: '获取订阅列表失败（mihomo 服务未运行或无订阅配置）' };
    return { ok: true, subscriptions: r.json.subscriptions || [] };
  },

  // 刷新全部订阅（= clash update）
  async 'POST /api/subscriptions/refresh'() {
    const r = await httpJson(MIHOMO_API + '/subscriptions');
    if (!r.ok || !r.json) return { ok: false, error: '获取订阅列表失败（mihomo 服务未运行或无订阅配置）' };
    const names = r.json.subscriptions || [];
    if (names.length === 0) return { ok: false, error: '未配置任何订阅源' };
    const results = [];
    for (const n of names) {
      const rr = await httpJson(MIHOMO_API + '/subscriptions/' + encodeURIComponent(n), 'PUT', null, 60000);
      results.push({ name: n, ok: rr.ok, error: rr.ok ? null : rr.error || ('HTTP ' + rr.status) });
    }
    const okCount = results.filter((x) => x.ok).length;
    return { ok: true, results, summary: `完成: ${okCount}/${names.length} 个订阅已更新（节点组已自动刷新）` };
  },

  // 导入订阅源（= clash import：备份 → 改配置 → 热加载；失败回滚）
  async 'POST /api/import'({ url, provider, reload = true }) {
    if (!url || !/^https?:\/\/.+/i.test(url)) return { ok: false, error: '订阅 URL 无效（需 http(s):// 开头）' };
    if (!fs.existsSync(MIHOMO_CFG)) return { ok: false, error: `未找到 ${MIHOMO_CFG}` };
    const pname = provider && String(provider).trim() ? String(provider).trim() : '';
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '');
    const bak = `${MIHOMO_CFG}.bak.${ts}`;
    fs.copyFileSync(MIHOMO_CFG, bak);
    const p = await run('python3', [IMPORT_SCRIPT], 30000, { CFG: MIHOMO_CFG, URL: url, PNAME: pname });
    if (p.code !== 0) {
      try { fs.copyFileSync(bak, MIHOMO_CFG); } catch {}
      return { ok: false, error: '导入失败，已回滚到备份\n' + (p.stderr || p.stdout), rolledBack: true };
    }
    const info = p.stdout.split('\n').filter(Boolean).pop();
    let reloaded = null;
    if (reload) {
      const rr = await httpJson(MIHOMO_API + '/configs', 'PUT', {}, 30000);
      reloaded = rr.ok;
    }
    return {
      ok: true,
      message: info + (reloaded === null ? '（未热加载）' : reloaded ? '，已热加载生效' : '，但热加载失败（服务未运行？）'),
      backup: bak,
      reloaded,
    };
  },

  // 实时流量（历史 + 累计）——只读后端 2s 采样的内存缓存，不转发 mihomo /traffic
  // （mihomo /traffic 高负载下单次要 12s+，逐次转发会把 API 队列堵死，导致切换/测试卡死）
  async 'GET /api/traffic'() {
    return {
      ok: true,
      history: trafficHistory,
      live: { up: lastCumulative.up, down: lastCumulative.down },
      intervalMs: 2000,
      maxPoints: TRAFFIC_MAX,
    };
  },

  // 连接列表
  async 'GET /api/connections'() {
    const r = await httpJson(MIHOMO_API + '/connections');
    if (!r.ok || !r.json) return { ok: false, error: '获取连接列表失败（mihomo 服务未运行？）' };
    return { ok: true, connections: r.json.connections || [] };
  },

  // 关闭连接
  async 'DELETE /api/connections'({ id }) {
    if (!id) return { ok: false, error: 'id 不能为空' };
    const r = await httpJson(MIHOMO_API + '/connections/' + encodeURIComponent(id), 'DELETE');
    return r.ok ? { ok: true } : { ok: false, error: '关闭失败' };
  },

  // mihomo 版本
  async 'GET /api/version'() {
    const r = await run(MIHOMO_BIN, ['-v'], 10000);
    if (r.code === 0 && r.stdout) return { ok: true, version: r.stdout.split('\n')[0] };
    const api = await httpJson(MIHOMO_API + '/version');
    if (api.ok && api.json) return { ok: true, version: api.json.version || null };
    return { ok: false, error: '无法获取 mihomo 版本' };
  },
};

// ---------- HTTP 服务器 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function readBody(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
      if (body.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  try {
    if (u.pathname.startsWith('/api/')) {
      const handler = handlers[`${req.method} ${u.pathname}`];
      if (!handler) return sendJson(res, 404, { ok: false, error: 'unknown api: ' + req.method + ' ' + u.pathname });
      let args = {};
      if (req.method === 'POST' || req.method === 'DELETE') {
        try { args = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
      }
      const result = await handler(args) || {};
      return sendJson(res, result.ok === false ? 502 : 200, { ok: result.ok !== false, data: result });
    }
    // 静态文件
    const fp = path.normalize(u.pathname === '/' ? '/index.html' : u.pathname).replace(/^([/\\])+/, '');
    const full = path.join(PUBLIC_DIR, fp);
    if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[clash-web] listening on http://localhost:${PORT}  (mihomo api: ${MIHOMO_API})`);
});
