/**
 * /api/* 路由处理器。
 * 键格式：`METHOD /path`，与 index.js 的分发逻辑一致。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { config, PROXY_ON_CONTENT } from './config.js';
import { run, httpJson, fetchExitIp, getTrafficSnapshot, snapshotProviders, sleep } from './mihomo.js';
import { syncSubscriptionGroups, configProviderNames } from './lib/group-sync.js';

const { mihomoApi, mihomoBin, mihomoCfg, proxyOnFile, importScript } = config;
const PROVIDERS_DIR = path.join(path.dirname(mihomoCfg), 'providers');

/**
 * 解析 provider 缓存文件里的 proxy-groups（轻量行解析，与 import-sub.py 风格一致；零依赖不用 yaml 库）。
 * 订阅源 yaml 里定义的组 mihomo 不会激活（provider 只导入节点），这里提取出来供前端展示。
 */
function parseYamlGroups(text) {
  const groups = [];
  let inPG = false, cur = null, inMembers = false, itemIndent = -1;
  const unq = (s) => s.trim().replace(/^["']|["']$/g, '');
  for (const line of text.split(/\r?\n/)) {
    if (!inPG) {
      if (/^proxy-groups:\s*$/.test(line)) inPG = true;
      continue;
    }
    if (/^\S/.test(line)) break; // 顶层新键 = proxy-groups 段结束
    const indent = line.length - line.trimStart().length;
    const t = line.trim();
    const isDash = t === '-' || t.startsWith('- ');
    if (isDash && (itemIndent === -1 || indent === itemIndent)) {
      if (itemIndent === -1) itemIndent = indent;
      // 新组条目
      cur = { name: '', type: '', members: [] };
      groups.push(cur);
      inMembers = false;
      const rest = t.slice(1).trim();
      let m;
      if ((m = rest.match(/^name:\s*(.+)$/))) cur.name = unq(m[1]);
      else if ((m = rest.match(/^type:\s*(\w+)/))) cur.type = m[1];
      else if (/^proxies:\s*$/.test(rest)) inMembers = true;
      continue;
    }
    if (!cur) continue;
    let m;
    if ((m = t.match(/^name:\s*(.+)$/))) { cur.name = unq(m[1]); inMembers = false; }
    else if ((m = t.match(/^type:\s*(\w+)\s*$/))) { cur.type = m[1]; inMembers = false; }
    else if (/^proxies:\s*$/.test(t)) inMembers = true;
    else if (isDash && inMembers) cur.members.push(unq(t.slice(2)));
    else if (/^[\w-]+:/.test(t)) inMembers = false; // url/interval 等其他属性行
  }
  return groups.filter((g) => g.name);
}

// mtime 缓存，避免 3s 轮询反复读文件
const providerGroupsCache = new Map(); // file → { mtimeMs, groups }
function readProviderGroups() {
  const dir = path.join(path.dirname(mihomoCfg), 'providers');
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  } catch {
    return out;
  }
  for (const f of files) {
    const file = path.join(dir, f);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    const hit = providerGroupsCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) {
      out.push(...hit.groups);
      continue;
    }
    let groups = [];
    try {
      groups = parseYamlGroups(fs.readFileSync(file, 'utf8'));
    } catch {}
    providerGroupsCache.set(file, { mtimeMs: st.mtimeMs, groups });
    out.push(...groups);
  }
  return out;
}

const handlers = {
  // 状态总览（= clash status）
  async 'GET /api/status'() {
    const [svc, tun, proxyR, proxyOn, exitIp, verR, cfgR] = await Promise.all([
      run('systemctl', ['--user', 'is-active', 'mihomo'], 10000),
      run('bash', ['-c', "ip -br link 2>/dev/null | awk '{print $1}' | grep -E '^(Meta|tun)' | head -1"], 10000),
      httpJson(mihomoApi + '/proxies/PROXY'),
      Promise.resolve(fs.existsSync(proxyOnFile)),
      fetchExitIp(),
      run(mihomoBin, ['-v'], 10000),
      httpJson(mihomoApi + '/configs'),
    ]);
    return {
      service: svc.code === 0 && svc.stdout === 'active' ? 'active' : svc.stdout || 'unknown',
      tun: tun.stdout || null,
      node: proxyR.ok && proxyR.json && typeof proxyR.json.now === 'string' ? proxyR.json.now.trim() : null,
      proxyOn,
      exitIp,
      version: verR.code === 0 && verR.stdout ? verR.stdout.split('\n')[0] : null,
      mihomoAlive: Boolean(proxyR.ok && proxyR.json),
      mode: cfgR.ok && cfgR.json ? (cfgR.json.mode || 'rule') : null,
    };
  },

  // 服务 start / stop / restart
  async 'POST /api/service'({ action }) {
    if (!['start', 'stop', 'restart'].includes(action)) return { ok: false, error: 'invalid action' };
    await run('systemctl', ['--user', action, 'mihomo'], 60000);
    await sleep(2000);
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
      const r = await httpJson(mihomoApi + '/version');
      if (!r.ok) return { ok: false, error: 'mihomo 未在运行，无法开启终端代理（先启动全局服务）' };
      fs.writeFileSync(proxyOnFile, PROXY_ON_CONTENT);
      return { ok: true, message: 'clash 代理已开启（之后新开的终端均生效）' };
    }
    fs.rmSync(proxyOnFile, { force: true });
    return { ok: true, message: 'clash 终端代理已关闭（如需关闭全局 TUN，用停止服务）' };
  },

  // 全量代理组视图（Clash Verge 代理页同款数据源）：所有可切换组 + 节点 meta + 订阅未生效组
  async 'GET /api/proxies'() {
    const r = await httpJson(mihomoApi + '/proxies');
    if (!r.ok || !r.json || !r.json.proxies) return { ok: false, error: '获取节点列表失败（mihomo 服务未运行？）' };
    const prox = r.json.proxies;
    const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance']);
    // 注意：节点名保留原样（部分节点名含前导/尾随空格，trim 后 PUT 会 400）
    const rank = (n) => (n === 'GLOBAL' ? 0 : n === 'PROXY' ? 1 : 2);
    const groups = Object.values(prox)
      .filter((p) => p && GROUP_TYPES.has(p.type))
      .map((p) => ({
        name: p.name,
        type: p.type,
        now: p.now || '',
        all: (p.all || []).map((n) => String(n)),
        udp: !!p.udp,
      }))
      .sort((a, b) => rank(a.name) - rank(b.name));
    // 物理节点 meta（协议/UDP）：逐 provider 取
    const meta = {};
    const provR = await httpJson(mihomoApi + '/providers/proxies');
    if (provR.ok && provR.json && provR.json.providers) {
      const provObj = provR.json.providers;
      const provNames = Array.isArray(provObj) ? provObj.map((p) => p.name) : Object.keys(provObj);
      for (const pn of provNames) {
        try {
          const det = await httpJson(mihomoApi + '/providers/proxies/' + encodeURIComponent(pn));
          if (det.ok && det.json && Array.isArray(det.json.proxies)) {
            for (const p of det.json.proxies) {
              if (p && p.name && !GROUP_TYPES.has(p.type) && !['Direct', 'Reject', 'Pass', 'PassRule', 'RejectDrop', 'Compatible'].includes(p.type)) {
                meta[p.name] = { type: p.type || '', udp: !!p.udp };
              }
            }
          }
        } catch {}
      }
    }
    const modeR = await httpJson(mihomoApi + '/configs');
    const mode = modeR.ok && modeR.json ? (modeR.json.mode || 'rule') : 'rule';
    // 规则表（前端用它生成每个组的「流量路径」说明）
    let rules = [];
    try {
      const ruleR = await httpJson(mihomoApi + '/rules');
      if (ruleR.ok && ruleR.json && Array.isArray(ruleR.json.rules)) {
        rules = ruleR.json.rules
          .filter((x) => x && x.proxy)
          .map((x) => ({ type: x.type || '', payload: x.payload || '', proxy: x.proxy }));
      }
    } catch {}
    // 订阅源定义、但 mihomo 未激活的组（provider 只导入节点不导入组）
    const seen = new Set(groups.map((g) => g.name));
    const orphanGroups = readProviderGroups().filter((g) => !seen.has(g.name));
    return { ok: true, mode, groups, meta, orphanGroups, rules };
  },

  // 切换节点（= clash set）；group 默认 PROXY，全局模式下前端传 GLOBAL
  async 'POST /api/proxy-set'({ name, group }) {
    if (!name || typeof name !== 'string') return { ok: false, error: '节点名不能为空' };
    const g = typeof group === 'string' && group ? group : 'PROXY';
    const putR = await httpJson(mihomoApi + '/proxies/' + encodeURIComponent(g), 'PUT', { name });
    if (!putR.ok) return { ok: false, error: `切换失败（组 ${g}，mihomo API 无响应或名字无效）` };
    return { ok: true, message: `组 ${g} 已切换到: ${name}` };
  },

  // 节点延迟测试：mihomo 原生 healthcheck 端点，全并发，不切换当前选择器、互不干扰
  async 'POST /api/proxy-test'({ url, nodes }) {
    if (!Array.isArray(nodes) || nodes.length === 0) return { ok: false, error: 'nodes 不能为空' };
    let testUrl = (url || '').trim() || 'https://www.google.com/generate_204';
    if (!/^https?:\/\/.+/i.test(testUrl)) return { ok: false, error: '测试 URL 无效（需 http(s):// 开头）' };
    const names = [...new Set(nodes.map((n) => String(n)).filter((n) => n.trim() !== ''))];

    // 节点属于哪个 provider（/proxies 顶层只有组，具体节点要走 /providers/proxies/{provider}/...）
    const provR = await httpJson(mihomoApi + '/providers/proxies');
    const provObj = (provR.ok && provR.json && provR.json.providers) || {};
    const providerNames = Array.isArray(provObj) ? provObj.map((p) => p.name) : Object.keys(provObj);
    const byProvider = {};
    for (const pname of providerNames) {
      try {
        const det = await httpJson(mihomoApi + '/providers/proxies/' + encodeURIComponent(pname));
        if (det.ok && det.json && Array.isArray(det.json.proxies)) {
          byProvider[pname] = new Set(det.json.proxies.map((x) => x.name));
        }
      } catch {}
    }
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

    // 全并发（mihomo 侧各自独立出站测试，不抢选择器，可安全并发）
    const results = await Promise.all(names.map(testOne));
    return { ok: true, url: testUrl, count: results.length, method: 'healthcheck', results };
  },

  // 订阅（provider）列表。mihomo v1.19 无 /subscriptions 端点，改用 /providers/proxies。
  async 'GET /api/subscriptions'() {
    const r = await httpJson(mihomoApi + '/providers/proxies');
    if (!r.ok || !r.json) return { ok: false, error: '获取订阅列表失败（mihomo 服务未运行或无订阅配置）' };
    const provObj = r.json.providers || {};
    // mihomo v1.19 会把注入的订阅组也列进 /providers/proxies，过滤掉只留真实 provider
    const realNames = configProviderNames();
    const providers = (Array.isArray(provObj)
      ? provObj
      : Object.keys(provObj).map((name) => ({ name, ...provObj[name] }))
    ).filter((p) => realNames.has(p.name));
    return { ok: true, subscriptions: providers.map((p) => p.name || p.provider || '').filter(Boolean), providers };
  },

  // 刷新全部订阅（= clash update）：热加载 + 比对 providers 缓存文件变化来判定是否真的拉到
  async 'POST /api/subscriptions/refresh'() {
    const r = await httpJson(mihomoApi + '/providers/proxies');
    if (!r.ok || !r.json) return { ok: false, error: '获取订阅列表失败（mihomo 服务未运行或无订阅配置）' };
    const provObj = r.json.providers || {};
    // 只刷新真实订阅源（过滤掉 mihomo 列进来的注入组）
    const realNames = configProviderNames();
    const allNames = Array.isArray(provObj) ? provObj.map((p) => p.name) : Object.keys(provObj);
    const names = allNames.filter((n) => realNames.has(n));
    if (names.length === 0) return { ok: false, error: '未配置任何订阅源' };
    const before = snapshotProviders();
    const rr = await httpJson(mihomoApi + '/configs', 'PUT', { path: mihomoCfg }, 30000);
    if (!rr.ok) {
      return { ok: false, error: '热加载失败：' + (rr.error ? rr.error + '（服务未运行？）' : `HTTP ${rr.status}: ${rr.body.slice(0, 120)}`) };
    }
    await sleep(6000); // 等 mihomo 重新拉取 http 订阅
    const after = snapshotProviders();
    const results = names.map((n) => {
      const file = n + '.yaml';
      if (!(file in before) && !(file in after)) return { name: n, ok: true, error: null, note: '无缓存文件（内置 provider）' };
      const changed = (after[file] || 0) > (before[file] || 0);
      return { name: n, ok: changed, error: changed ? null : '无变化（订阅 URL 可能不可达，仍在用旧节点）' };
    });
    const okCount = results.filter((x) => x.ok).length;
    // 订阅更新后自动激活订阅里定义的组（注入 config.yaml + 二次热加载 + 恢复选择）
    let groups;
    try {
      groups = await syncSubscriptionGroups();
    } catch (e) {
      groups = { ok: false, error: '订阅组同步异常: ' + (e.message || e) };
    }
    let summary = `完成: ${okCount}/${names.length} 个订阅源已更新`;
    if (groups.ok === false) summary += `；订阅组同步失败: ${groups.error}`;
    else if (groups.changed) summary += `；已激活 ${groups.injected} 个订阅组`;
    else summary += '；订阅组无变化';
    return { ok: true, results, summary, groups };
  },

  // 导入订阅源（= clash import：备份 → 改配置 → 热加载；失败回滚）
  // 修复：PUT /configs 必须带 { path } body（mihomo v1.19 对空 body 返回 400）；
  // 热加载后比对 providers 缓存文件 mtime 判定订阅是否真的拉到，区分「服务未运行」「请求被拒」「拉取失败」。
  async 'POST /api/import'({ url, provider, reload = true }) {
    if (!url || !/^https?:\/\/.+/i.test(url)) return { ok: false, error: '订阅 URL 无效（需 http(s):// 开头）' };
    if (!fs.existsSync(mihomoCfg)) return { ok: false, error: `未找到 ${mihomoCfg}` };
    const pname = provider && String(provider).trim() ? String(provider).trim() : '';
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '');
    const bak = `${mihomoCfg}.bak.${ts}`;
    fs.copyFileSync(mihomoCfg, bak);
    const p = await run('python3', [importScript], 30000, { CFG: mihomoCfg, URL: url, PNAME: pname });
    if (p.code !== 0) {
      try { fs.copyFileSync(bak, mihomoCfg); } catch {}
      return { ok: false, error: '导入失败，已回滚到备份\n' + (p.stderr || p.stdout), rolledBack: true };
    }
    const info = p.stdout.split('\n').filter(Boolean).pop();
    let reloaded = null;
    let subUpdated = null;
    let reloadError = null;
    if (reload) {
      const before = snapshotProviders();
      const rr = await httpJson(mihomoApi + '/configs', 'PUT', { path: mihomoCfg }, 30000);
      if (!rr.ok) {
        reloaded = false;
        reloadError = rr.error
          ? `连接 mihomo 失败（${rr.error}），服务未运行？`
          : `请求被拒（HTTP ${rr.status}: ${(rr.body || '').slice(0, 120)}）`;
      } else {
        reloaded = true;
        await sleep(6000); // 等 mihomo 重新拉取订阅
        const after = snapshotProviders();
        subUpdated = Object.keys(after).some((f) => after[f] > (before[f] || 0));
        // 导入/刷新后自动激活订阅里定义的组
        try {
          const gs = await syncSubscriptionGroups();
          if (gs.ok === false) message += `，但订阅组同步失败：${gs.error}`;
          else if (gs.changed) message += `，已激活 ${gs.injected} 个订阅组`;
        } catch (e) {
          message += `，但订阅组同步异常：${e.message || e}`;
        }
      }
    }
    let message = info;
    if (reloaded === null) message += '（未热加载）';
    else if (!reloaded) message += '，但热加载失败：' + reloadError;
    else if (subUpdated) message += '，已热加载生效，订阅已更新';
    else message += '，已热加载生效，但订阅缓存未变化（新源可能不可达，节点仍为旧数据）';
    return { ok: true, message, backup: bak, reloaded, subUpdated };
  },

  // 实时流量（历史 + 累计）——只读后端 2s 采样的内存缓存，不转发 mihomo /traffic
  // （mihomo /traffic 高负载下单次要 12s+，逐次转发会把 API 队列堵死，导致切换/测试卡死）
  async 'GET /api/traffic'() {
    return { ok: true, ...getTrafficSnapshot() };
  },

  // 连接列表
  async 'GET /api/connections'() {
    const r = await httpJson(mihomoApi + '/connections');
    if (!r.ok || !r.json) return { ok: false, error: '获取连接列表失败（mihomo 服务未运行？）' };
    return { ok: true, connections: r.json.connections || [] };
  },

  // 关闭连接
  async 'DELETE /api/connections'({ id }) {
    if (!id) return { ok: false, error: 'id 不能为空' };
    const r = await httpJson(mihomoApi + '/connections/' + encodeURIComponent(id), 'DELETE');
    return r.ok ? { ok: true } : { ok: false, error: '关闭失败' };
  },

  // mihomo 版本
  async 'GET /api/version'() {
    const r = await run(mihomoBin, ['-v'], 10000);
    if (r.code === 0 && r.stdout) return { ok: true, version: r.stdout.split('\n')[0] };
    const api = await httpJson(mihomoApi + '/version');
    if (api.ok && api.json) return { ok: true, version: api.json.version || null };
    return { ok: false, error: '无法获取 mihomo 版本' };
  },

  // mihomo 最近日志（设置页用）
  async 'GET /api/logs'({}) {
    const r = await run('journalctl', ['--user', '-u', 'mihomo', '-n', '200', '--no-pager'], 15000);
    if (r.code !== 0) return { ok: false, error: '读取日志失败：' + ((r.stderr || '').slice(-200) || '未知错误') };
    return { ok: true, lines: r.stdout.split('\n') };
  },

  // 代理模式（rule / global / direct，对应 Clash Verge 的 规则/全局/直连）
  async 'GET /api/mode'() {
    const r = await httpJson(mihomoApi + '/configs');
    if (!r.ok || !r.json) return { ok: false, error: '获取模式失败（mihomo 未运行？）' };
    return { ok: true, mode: r.json.mode || 'rule' };
  },

  async 'POST /api/mode'({ mode }) {
    if (!['rule', 'global', 'direct'].includes(mode)) return { ok: false, error: 'invalid mode' };
    // mihomo v1.19：切模式必须用 PATCH /configs（运行时生效）；
    // PUT /configs 会触发完整配置重载，mode 会被 config.yaml 里的值覆盖回原状（v1.19 实测）
    const r = await httpJson(mihomoApi + '/configs', 'PATCH', { mode });
    if (!r.ok) return { ok: false, error: '切换失败（mihomo API 无响应）' };
    const chk = await httpJson(mihomoApi + '/configs');
    const actual = chk.ok && chk.json ? chk.json.mode : null;
    const label = { rule: '规则', global: '全局', direct: '直连' }[mode];
    if (actual !== mode) return { ok: false, error: `切换到${label}模式未生效（当前仍为: ${actual || '未知'}）` };
    return { ok: true, message: `已切换到${label}模式` };
  },

  // 系统配置信息（设置页用）
  async 'GET /api/config-info'() {
    return {
      ok: true,
      webPort: config.port,
      mihomoApi: config.mihomoApi,
      mihomoBin: config.mihomoBin,
      mihomoCfg: config.mihomoCfg,
      providersDir: path.join(path.dirname(config.mihomoCfg), 'providers'),
      proxyOnFile: config.proxyOnFile,
    };
  },
};

export { handlers };
