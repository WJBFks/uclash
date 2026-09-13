#!/usr/bin/env node
/**
 * UClash v2 — 通用代理管理 Web UI 后端
 *
 * Node ESM 后端，配置编辑使用 yaml 解析器：
 *   - /api/*  JSON API（mihomo REST 封装）
 *   - 其余    静态文件（dist/，由 Vite 构建产物）
 *
 * 启动：node server/index.js   （或 npm start）
 * 开发：npm run dev            （vite 5173 + node server 15924，vite 代理 /api）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { handlers } from './routes.js';
import { authorize } from './lib/security.js';
import { startTrafficSampler } from './mihomo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const VITE_DEV_URL = 'http://127.0.0.1:5173';
// 开发模式（npm run dev 设置 CW_DEV=1）：一律转发到 vite dev server（带 HMR）
// 生产模式（npm start）：dist/ 存在则静态托管，否则也转发（vite 未起时给出明确提示）
const FRONTEND_MODE = process.env.CW_DEV ? 'vite' : (fs.existsSync(path.join(DIST_DIR, 'index.html')) ? 'static' : 'vite');
const PORT = config.port;
const HOST = config.host;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

async function readBody(req, limit = 8 * 1024 * 1024) {
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
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 前端分发：
 *  - CW_DEV=1（npm run dev）→ 一律转发到 vite dev server（带 HMR，无需 build）
 *  - 否则 dist/ 已构建 → 静态托管（生产模式）
 *  HMR websocket 不经此转发（vite hmr.clientPort=5173 直连）
 */
function serveFrontend(req, res, u) {
  if (FRONTEND_MODE === 'static') {
    return serveStatic(req, res, u.pathname, DIST_DIR);
  }
  const proxyReq = http.request(
    { host: '127.0.0.1', port: 5173, path: u.pathname + u.search, method: req.method, headers: { ...req.headers, host: '127.0.0.1:5173' } },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('前端不可用：dist/ 未构建且 vite dev server（127.0.0.1:5173）未启动。请先运行 npm run dev');
  });
  req.pipe(proxyReq);
}

/** 静态文件服务；SPA fallback 到 index.html */
function serveStatic(req, res, pathname, rootDir) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let full = path.join(rootDir, path.normalize(rel));
  // 防目录穿越
  if (!full.startsWith(rootDir + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    const indexFile = path.join(rootDir, 'index.html');
    if (fs.existsSync(indexFile)) full = indexFile;
    else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  if (u.pathname.startsWith('/api/')) {
    const denied = authorize(req, config);
    if (denied) return sendJson(res, denied.status, { ok: false, error: denied.error });
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }

  try {
    if (u.pathname.startsWith('/api/')) {
      const handler = handlers[`${req.method} ${u.pathname}`];
      if (!handler) return sendJson(res, 404, { ok: false, error: `unknown api: ${req.method} ${u.pathname}` });
      let args = Object.fromEntries(u.searchParams); // query 参数（如 ?name=mysub）
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
        try {
          args = { ...args, ...(await readBody(req)) };
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.message });
        }
      }
      const result = (await handler(args)) || {};
      return sendJson(res, result.ok === false ? 502 : 200, { ok: result.ok !== false, data: result });
    }
    serveFrontend(req, res, u);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e.message || e) });
  }
});

if (!['127.0.0.1', 'localhost', '::1'].includes(HOST) && config.token.length < 24) {
  throw new Error('远程监听需要至少 24 字符的 CW_TOKEN');
}
server.listen(PORT, HOST, () => {
  startTrafficSampler();
  console.log(`[UClash v2] listening on http://localhost:${server.address().port}  (mihomo api: ${config.mihomoApi})`);
  console.log(`[UClash v2] 前端: ${FRONTEND_MODE === 'static' ? '静态托管 dist/（生产模式）' : '转发到 vite dev server ' + VITE_DEV_URL + '（开发模式）'}`);
});
