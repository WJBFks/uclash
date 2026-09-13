/**
 * /api/* 路由处理器。
 * 键格式：`METHOD /path`，与 index.js 的分发逻辑一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { run, httpJson, fetchExitIp, getConnectionsSnapshot, getTrafficSnapshot, sleep } from './mihomo.js';
import { syncSubscriptionGroups, readProviderRules, readConfigProviders, findProviderRefs, parseProviderFile, parseYamlRules, getSelectedSource, setSelectedSource, ensureBaseBackup, restoreDefaultConfig, readBaseSectionCounts, readBaseGroupNames, readProviderGroups } from './lib/group-sync.js';

import { fetchSubscription } from './lib/fetch-subscription.js';
import { editProvider, providerName, subscriptionUrl } from './lib/subscriptions.js';
import { createConnectionResponseCache, createConnectionTracker } from './lib/connections.js';
const trackConnections = createConnectionTracker();
const normalizeConnections = createConnectionResponseCache(trackConnections);
import { managementHandlers } from './management.js';
import { serial, transaction, backup, reloadValidatedConfig, stateFile, readJson, writeJson, readConfig, atomicWrite, setSection, readOverlay, readDraft, markRuntimeTouched } from './lib/config-store.js';

const { mihomoApi, mihomoBin, mihomoCfg } = config;
const PROVIDERS_DIR = path.join(path.dirname(mihomoCfg), 'providers');

// ---- 订阅用量（subscription-userinfo 响应头，经 mihomo 出口拉取，10 分钟缓存）----
const userinfoCache = new Map(); // name -> { at, info }
const USERINFO_TTL = 10 * 60 * 1000;

function parseUserinfoHeaders(hu, hm) {
  const num = (s, k) => {
    const m = s.match(new RegExp(k + '=([^;\\s]+)'));
    return m ? Number(m[1]) : null;
  };
  const info = { upload: null, download: null, total: null, expire: null };
  if (hu) {
    info.upload = num(hu, 'upload');
    info.download = num(hu, 'download');
    info.total = num(hu, 'total');
    info.expire = num(hu, 'expire');
  }
  if (hm && info.expire == null) info.expire = Number(hm);
  return info.upload != null || info.expire != null ? info : null;
}

async function fetchUserinfo(name, url, force = false) {
  const hit = userinfoCache.get(name);
  if (!force && hit && Date.now() - hit.at < USERINFO_TTL) return hit.info;
  let info = null;
  try {
    const res = await fetchSubscription(url, { headersOnly: true, timeout: 15000 });
    info = parseUserinfoHeaders(res.headers.get('subscription-userinfo') || '', res.headers.get('subscription-expire') || '');
  } catch {
    info = null;
  }
  userinfoCache.set(name, { at: Date.now(), info });
  return info;
}

const handlers = {
  // 状态总览
  async 'GET /api/status'() {
    const [svc, proxyR, exitIp, verR, cfgR] = await Promise.all([
      run(config.systemctlBin, ['--user', 'is-active', config.serviceName], 10000),
      httpJson(mihomoApi + '/proxies/PROXY'),
      fetchExitIp(),
      run(mihomoBin, ['-v'], 10000),
      httpJson(mihomoApi + '/configs'),
    ]);
    return {
      service: svc.code === 0 && svc.stdout === 'active' ? 'active' : svc.stdout || 'unknown',
      tun: cfgR.ok && cfgR.json?.tun?.enable ? (cfgR.json.tun.device || 'TUN') : null,
      node: proxyR.ok && proxyR.json && typeof proxyR.json.now === 'string' ? proxyR.json.now.trim() : null,
      exitIp,
      version: verR.code === 0 && verR.stdout ? verR.stdout.split('\n')[0] : null,
      mihomoAlive: Boolean(cfgR.ok && cfgR.json),
      mode: cfgR.ok && cfgR.json ? (cfgR.json.mode || 'rule') : null,
    };
  },

  // 服务 start / stop / restart
  async 'POST /api/service'({ action }) {
    if (!['start', 'stop', 'restart'].includes(action)) return { ok: false, error: 'invalid action' };
    const operation = await run(config.systemctlBin, ['--user', action, config.serviceName], 60000);
    if (operation.code !== 0) return { ok: false, error: '服务操作失败：' + (operation.stderr || operation.stdout || operation.code) };
    await sleep(2000);
    const svc = await run(config.systemctlBin, ['--user', 'is-active', config.serviceName], 10000);
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

  // 全量代理组视图（Clash Verge 代理页同款数据源）：所有可切换组 + 节点 meta + 订阅未生效组
  async 'GET /api/proxies'() {
    const r = await httpJson(mihomoApi + '/proxies');
    if (!r.ok || !r.json || !r.json.proxies) return { ok: false, error: '获取节点列表失败（mihomo 服务未运行？）' };
    const prox = r.json.proxies;
    // PROXY/GLOBAL 卡片虽已被按源过滤，但两者仍是真实生效的组
    // （PROXY 是 MATCH 兜底目标，GLOBAL 是全局模式入口），当前选择单独导出供概览文案用
    const proxyNow = (prox['PROXY'] && prox['PROXY'].now) || '';
    const globalNow = (prox['GLOBAL'] && prox['GLOBAL'].now) || '';
    const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance']);
    // 代理组页只显示「当前选中源」拥有的组：
    //   选中订阅源 → 该源 yaml proxy-groups 定义的组；选中默认配置 → 主配置注入块外的组（PROXY/Auto）。
    //   内置组（GLOBAL/DIRECT/REJECT…）与其他源/其他配置的组一律不显示。
    const sel = getSelectedSource();
    // 按「当前选中源」配置文件里 proxy-groups 的定义顺序展示（不再 GLOBAL/PROXY 优先）
    const orderedVisibleNames = sel === 'default'
      ? readBaseGroupNames()
      : readProviderGroups([sel]).map((g) => g.name);
    const visibleGroupNames = new Set(orderedVisibleNames);
    const orderIndex = new Map(orderedVisibleNames.map((n, i) => [n, i]));
    // 注意：节点名保留原样（部分节点名含前导/尾随空格，trim 后 PUT 会 400）
    const groups = Object.values(prox)
      .filter((p) => p && GROUP_TYPES.has(p.type) && visibleGroupNames.has(p.name))
      .map((p) => ({
        name: p.name,
        type: p.type,
        now: p.now || '',
        all: (p.all || []).map((n) => String(n)),
        udp: !!p.udp,
      }))
      .sort((a, b) => (orderIndex.get(a.name) ?? 1e9) - (orderIndex.get(b.name) ?? 1e9));
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
    // 组页面只展示「当前选中」订阅源（订阅页选中的源）的未生效组与规则；选中默认配置时为空
    const activeFilter = sel === 'default' ? [] : [sel];
    // 订阅源定义、但 mihomo 未激活的组（provider 只导入节点不导入组）
    const seen = new Set(groups.map((g) => g.name));
    const orphanGroups = readProviderGroups(activeFilter).filter((g) => !seen.has(g.name));
    // 选中源 yaml 里定义、未合并进主配置的规则（已合并的会同时出现在 rules 里，前端优先显示生效态）
    let subRules = [];
    try {
      subRules = readProviderRules(activeFilter);
    } catch {}
    // 全局模式「全局代理」扁平页数据
    // 1) 选中源的全部物理节点（按 provider 文件顺序），默认配置则回退到基础组引用的节点
    let flatNodes = [];
    if (sel !== 'default') {
      try {
        const cp = readConfigProviders().find((x) => x.name === sel);
        const file = cp && cp.path
          ? path.resolve(path.dirname(mihomoCfg), cp.path)
          : path.join(path.dirname(mihomoCfg), 'providers', sel + '.yaml');
        flatNodes = [...parseProviderFile(fs.readFileSync(file, 'utf8')).nodes];
      } catch {}
    }
    if (!flatNodes.length) {
      const nodeSeen = new Set(groups.map((g) => g.name));
      for (const g of groups) for (const n of g.all) {
        if (!nodeSeen.has(n) && !flatNodes.includes(n)) flatNodes.push(n);
      }
    }
    // 2) GLOBAL 当前出口链路：GLOBAL → 组… → 叶子节点/直连，用于高亮当前出口
    const flatChain = ['GLOBAL'];
    {
      let cur = (prox['GLOBAL'] && prox['GLOBAL'].now) || '';
      let guard = 0;
      while (cur && guard++ < 10 && prox[cur] && GROUP_TYPES.has(prox[cur].type)) {
        flatChain.push(cur);
        cur = prox[cur].now || '';
      }
      if (cur) flatChain.push(cur);
    }
    return { ok: true, mode, groups, meta, orphanGroups, rules, subRules, proxyNow, globalNow, flatNodes, flatChain };
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
    const testOne = async (name) => {
      const endpoint = '/providers/proxies/' + encodeURIComponent(owner[name]) + '/' + encodeURIComponent(name) + '/healthcheck?url=' + encodeURIComponent(testUrl) + '&timeout=' + PER_TEST_TIMEOUT;
      const r = await httpJson(mihomoApi + endpoint, 'GET', null, PER_TEST_TIMEOUT + 3000);
      const delay = r.json?.delay;
      return { name, ok: r.ok && typeof delay === 'number' && delay >= 0, latency: delay ?? null, http: r.status, error: r.ok ? null : '测速失败' };
    };

    // 全并发（mihomo 侧各自独立出站测试，不抢选择器，可安全并发）
    const results = await Promise.all(names.map(testOne));
    return { ok: true, url: testUrl, count: results.length, method: 'healthcheck', results };
  },

  // 订阅源卡片列表：显示所有订阅（config.yaml 声明 ∪ providers/ 缓存文件，含未声明的）。
  // mihomo /providers/proxies 只补充运行时节点数（v1.19 会把注入组混入该接口，不可信）。
  async 'GET /api/subscriptions'() {
    const selected = getSelectedSource();
    const cfgProvs = readConfigProviders();
    const cfgMap = new Map(cfgProvs.map((p) => [p.name, p]));
    let files = [];
    try {
      files = fs.readdirSync(PROVIDERS_DIR).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    } catch {}
    const names = [...new Set([...cfgMap.keys(), ...files.map((f) => f.replace(/\.ya?ml$/, ''))])];
    let miMap = new Map();
    try {
      const r = await httpJson(mihomoApi + '/providers/proxies');
      if (r.ok && r.json) {
        const provObj = r.json.providers || {};
        const arr = Array.isArray(provObj) ? provObj : Object.keys(provObj).map((n) => ({ name: n, ...provObj[n] }));
        miMap = new Map(arr.map((p) => [p.name, p]));
      }
    } catch {}
    const providers = names.map((name) => {
      const cp = cfgMap.get(name);
      const mi = miMap.get(name);
      const filePath = cp && cp.path
        ? path.resolve(path.dirname(mihomoCfg), cp.path)
        : path.join(PROVIDERS_DIR, `${name}.yaml`);
      let updated = 0;
      let text = '';
      try {
        text = fs.readFileSync(filePath, 'utf8');
        updated = fs.statSync(filePath).mtimeMs;
      } catch {}
      let url = cp && cp.url ? cp.url : '';
      if (!url) {
        const m = text.match(/^#!MANAGED-CONFIG\s+(.+?)\s*$/m);
        if (m) url = m[1].trim();
      }
      let groupCount = 0, ruleCount = 0, nodes = 0;
      if (text) {
        const parsed = parseProviderFile(text);
        groupCount = parsed.groups.length;
        ruleCount = parseYamlRules(text).length;
        nodes = parsed.nodes.size; // parseProviderFile 的 nodes 是 Set
      }
      if (!nodes && mi && Array.isArray(mi.proxies)) nodes = mi.proxies.length;
      if (!updated && mi && mi.updated) updated = Number(mi.updated) || 0;
      const hit = userinfoCache.get(name);
      return {
        name,
        displayName: readJson(stateFile('subscription-labels.json'), {})[name] || name,
        refreshStatus: readJson(stateFile('subscription-updates.json'), {})[name] || null,
        url,
        interval: cp ? cp.interval : 0,
        nodes,
        updated: Math.floor(updated),
        groupCount,
        ruleCount,
        declared: Boolean(cp),
        active: selected === name,
        userinfo: hit && Date.now() - hit.at < USERINFO_TTL ? hit.info : null,
      };
    });
    // 内置「默认配置」卡片：不可删除；选中 = 主配置处于原始状态（无注入的订阅组/规则），兼作备份与测试
    const base = readBaseSectionCounts();
    const defaultCard = {
      name: 'default',
      builtin: true,
      url: '',
      interval: 0,
      nodes: 0,
      updated: 0,
      groupCount: base.groups,
      ruleCount: base.rules,
      declared: true,
      active: selected === 'default',
      userinfo: null,
    };
    return { ok: true, subscriptions: ['default', ...providers.map((p) => p.name)], providers: [defaultCard, ...providers] };
  },

  // 订阅用量/到期：拉取订阅 URL 读 subscription-userinfo 响应头（经 mihomo 出口），10 分钟缓存
  async 'GET /api/subscriptions/userinfo'({ name, force }) {
    name = String(name || '').trim();
    if (name === 'default') return { ok: true, name, userinfo: null }; // 默认配置无订阅用量
    const cp = readConfigProviders().find((x) => x.name === name);
    if (!cp || !cp.url) return { ok: false, error: `未找到订阅源「${name || '?'}」或其 URL` };
    const info = await fetchUserinfo(name, cp.url, force === '1');
    return { ok: true, name, userinfo: info };
  },

  // 注入/激活订阅源（独占）：让主配置组（PROXY/Auto 等注入块之外的组）的 use: 指向该源；
  // 未声明的先补声明。流程：备份 → YAML 结构修改 → 同步订阅组并热加载（失败回滚）
  async 'POST /api/subscriptions/activate'({ name }) {
    name = String(name || '').trim();
    if (!name) return { ok: false, error: '请提供要激活的订阅源名称' };
    if (name !== 'default') providerName(name);
    if (name === 'default') {
      // 恢复默认配置：回到原始规则/组快照（兼作备份与测试）
      backup('恢复默认配置前');
      const r = await restoreDefaultConfig();
      if (!r.ok) return { ok: false, error: r.error, rolledBack: r.rolledBack };
      return { ok: true, message: r.changed
        ? '已恢复默认配置（原始规则与组，已移除注入的订阅组/规则；订阅源与缓存均保留，可随时重新激活）'
        : '当前已是默认配置' };
    }
    const cp = readConfigProviders().find((x) => x.name === name);
    const filePath = cp && cp.path
      ? path.resolve(path.dirname(mihomoCfg), cp.path)
      : path.join(PROVIDERS_DIR, `${name}.yaml`);
    if (!fs.existsSync(filePath)) return { ok: false, error: `订阅源「${name}」没有本地缓存文件，无法激活` };

    let url = cp && cp.url ? cp.url : '';
    if (!url) {
      try {
        const m = fs.readFileSync(filePath, 'utf8').match(/^#!MANAGED-CONFIG\s+(.+?)\s*$/m);
        if (m) url = m[1].trim();
      } catch {}
    }
    if (!cp && !url) return { ok: false, error: `订阅源「${name}」未声明且无 URL，请先用顶部输入框导入` };
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '');
    const bak = `${mihomoCfg}.bak.${ts}.${Math.random().toString(36).slice(2, 8)}`;
    fs.copyFileSync(mihomoCfg, bak);
    ensureBaseBackup(); // 首次激活前保存原始配置快照（默认配置的备份/恢复点）
    backup('应用订阅前');
    editProvider({ name, url, switchTo: true });
    // 统一由 sync 重建注入块（组 + 规则合并）并热加载（被 mihomo 拒则自动回滚）
    let tail = '';
    try {
      const gs = await syncSubscriptionGroups(name);
      if (gs.ok === false) throw new Error(gs.error);
      else if (gs.changed) tail += `；已重建 ${gs.injected} 个订阅组，合并 ${gs.rules} 条订阅规则`;
      else {
        // 注入块无变化，但 use: 引用可能已切换 → 仍需重载让 mihomo 生效
        const rr = await reloadValidatedConfig();
        if (!rr.ok) throw new Error(rr.error || '热加载未成功');
        else { await sleep(2000); tail += '；已热加载'; }
      }
    } catch (e) { throw e; }
    return { ok: true, message: `已激活订阅源「${name}」（PROXY/Auto 等主配置组已指向它）${tail}` };
  },

  // 删除订阅源：备份 → 删 provider 声明 + 缓存文件 → 热加载 → 重建注入组（失败回滚）
  async 'POST /api/subscriptions/delete'({ name }) {
    name = String(name || '').trim();
    if (!name) return { ok: false, error: '请提供要删除的订阅源名称' };
    if (name === 'default') return { ok: false, error: '默认配置是内置备份（原始规则/组快照），不能删除' };
    providerName(name);
    const cfgProvs = readConfigProviders();
    const cp = cfgProvs.find((x) => x.name === name);
    const filePath = cp && cp.path
      ? path.resolve(path.dirname(mihomoCfg), cp.path)
      : path.join(PROVIDERS_DIR, `${name}.yaml`);
    if (!cp && !fs.existsSync(filePath)) return { ok: false, error: `未找到订阅源「${name}」（配置声明与本地缓存均无）` };
    if (cp) {
      const refs = findProviderRefs(name);
      if (refs.length) return { ok: false, error: `订阅源「${name}」被主配置组 ${refs.join('、')} 引用，删除会导致配置无效；请先改这些组的 use` };
      const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '');
      const bak = `${mihomoCfg}.bak.${ts}.${Math.random().toString(36).slice(2, 8)}`;
      fs.copyFileSync(mihomoCfg, bak);
      const cacheBak = `${filePath}.bak.${ts}`;
      try { fs.copyFileSync(filePath, cacheBak); } catch {}
      backup('删除订阅前');
      editProvider({ name, remove: true });
      // 顺序关键：先删缓存文件再同步组（重建注入块时不再引用被删源）；
      // 若先热加载，注入块仍引用被删源 → mihomo 400 且文件遗留悬空引用
      try { fs.rmSync(filePath, { force: true }); } catch {}
      userinfoCache.delete(name);
      if (getSelectedSource() === name) setSelectedSource('default'); // 被删源恰为选中源 → 回到默认配置态
      let tail = '';
      try {
        const gs = await syncSubscriptionGroups();
        if (gs.ok === false) {
          // 同步失败：文件可能处于「声明已删、注入块未重建」中间态 → 整体回滚
          try { fs.copyFileSync(bak, mihomoCfg); } catch {}
          try { fs.copyFileSync(cacheBak, filePath); } catch {}
          return { ok: false, error: `删除「${name}」未生效：${gs.error}；配置与缓存已整体回滚，订阅源仍保留`, rolledBack: true };
        }
        if (gs.changed) tail += '；已重建订阅组（清理被删源的组）';
        else {
          // 注入块无变化时 sync 会跳过热加载 → 手动重载让 mihomo 丢弃被删源
          const rr = await reloadValidatedConfig();
          if (!rr.ok) throw new Error(rr.error || '热加载未成功');
          else await sleep(2000);
        }
      } catch (e) {
        try { fs.copyFileSync(bak, mihomoCfg); } catch {}
        try { fs.copyFileSync(cacheBak, filePath); } catch {}
        return { ok: false, error: `删除「${name}」未生效：同步异常 ${e.message || e}；配置与缓存已整体回滚`, rolledBack: true };
      }
      try { fs.rmSync(cacheBak, { force: true }); } catch {}
      return { ok: true, message: `已删除订阅源「${name}」${tail}` };
    }
    // 未声明的源（仅本地缓存）：删缓存文件 + 热加载让 mihomo 内存与文件一致。
    // 若 mihomo 内存仍持有该源（声明曾被非热加载方式移除），不重载会让它按 interval 重新拉取、重建缓存文件（「删了又出现」的根因之一）。
    try { fs.rmSync(filePath, { force: true }); } catch (e) { return { ok: false, error: '删除缓存文件失败：' + (e.message || e) }; }
    userinfoCache.delete(name);
    let tail = '';
    try {
      const rr = await reloadValidatedConfig();
      if (rr.ok) await sleep(1500);
      else throw new Error(rr.error || '热加载未成功');
    } catch (e) { throw e; }
    return { ok: true, message: `已删除订阅源「${name}」（仅本地缓存，未在 config.yaml 声明）${tail}` };
  },

  // 单源或逐源更新节点，不自动重载主配置。
  async 'POST /api/subscriptions/refresh'({ name }) {
    const configured = readConfigProviders();
    const names = name ? configured.filter((p) => p.name === name).map((p) => p.name) : configured.map((p) => p.name);
    if (!names.length) return { ok: false, error: '订阅源不存在或未声明' };
    const status = readJson(stateFile('subscription-updates.json'), {});
    const results = [];
    for (const n of names) {
      const r = await httpJson(mihomoApi + '/providers/proxies/' + encodeURIComponent(n), 'PUT', null, 30000);
      const error = r.ok ? null : r.status === 404 ? '当前内核不支持单源更新，请升级内核；未执行全量重载' : r.error || `更新失败 HTTP ${r.status}`;
      status[n] = { attemptedAt: Date.now(), successAt: r.ok ? Date.now() : status[n]?.successAt || null, error };
      results.push({ name: n, ok: r.ok, error });
      userinfoCache.delete(n);
    }
    writeJson(stateFile('subscription-updates.json'), status);
    const count = results.filter((r) => r.ok).length;
    // Updating a provider must not trigger a global configuration reload.
    return { ok: true, results, summary: `已更新 ${count}/${names.length} 个订阅。代理组与规则需要时请重新应用订阅。` };
  },

  // 导入预览（只读，不改配置）：拉取订阅（UA clash.meta，同 mihomo）→ 识别订阅名 → 比对已导入订阅（URL 精确匹配）
  // 订阅名来源优先级：Content-Disposition filename*（RFC5987）> filename > body 顶层 name:；全部失败返回 null（前端回填日期）
  async 'POST /api/import/preview'({ url }) {
    url = subscriptionUrl(String(url || '').trim());
    if (!url || !/^https?:\/\/.+/i.test(url)) return { ok: false, error: '订阅 URL 无效（需 http(s):// 开头）' };
    let res = { headers: new Headers(), text: '' };
    let warning = null;
    try {
      res = await fetchSubscription(url);
    } catch (error) {
      warning = `无法预览订阅内容：${error instanceof Error ? error.message : '网络请求失败'}。可继续填写名称，确认后由 mihomo 拉取并校验。`;
    }
    const text = res.text;
    let name = null;
    const cd = res.headers.get('content-disposition') || '';
    let m = cd.match(/filename\*\s*=\s*[^']*''([^;]+)/i);
    if (m) { try { name = decodeURIComponent(m[1].trim()); } catch { name = null; } }
    if (!name) { m = cd.match(/filename\s*=\s*"?([^";]+)"?/i); if (m) name = m[1].trim(); }
    // 2) body 顶层 name:
    if (!name) { m = text.match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m); if (m) name = m[1].trim(); }
    if (name) name = name.replace(/[\\/\u0000-\u001f]/g, '').slice(0, 40) || null;
    // 节点数（尽力而为：只数 proxies 段内列表项）
    let nodes = null;
    const pm = text.split(/^proxies:\s*$/m);
    if (pm.length > 1) {
      const sec = pm[1].split(/^[a-z-]+:/m)[0];
      nodes = (sec.match(/^\s*-\s*(?:\{)?\s*name:/gm) || []).length;
    }
    // 比对已导入订阅源：config.yaml 声明的 + 仅缓存存在的（MANAGED-CONFIG 头）
    let existing = null;
    const provs = readConfigProviders();
    for (const cp of provs) {
      if (cp.url && String(cp.url).trim() === url) { existing = { name: cp.name, url: cp.url }; break; }
    }
    if (!existing) {
      let files = [];
      try { files = fs.readdirSync(PROVIDERS_DIR).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')); } catch {}
      for (const f of files) {
        const nm = f.replace(/\.ya?ml$/, '');
        if (provs.some((p) => p.name === nm)) continue;
        try {
          const t = fs.readFileSync(path.join(PROVIDERS_DIR, f), 'utf8');
          const mm = t.match(/^#!MANAGED-CONFIG\s+(.+?)\s*$/m);
          if (mm && mm[1].trim() === url) { existing = { name: nm, url: mm[1].trim() }; break; }
        } catch {}
      }
    }
    return { ok: true, name, existing, nodes, warning };
  },

  // 导入订阅源（= clash import：备份 → 改配置 → 热加载；失败回滚）
  // 修复：PUT /configs 必须带 { path } body（mihomo v1.19 对空 body 返回 400）；
  // 仅目标 provider 更新成功且已有缓存后才激活，失败由外层事务整体回滚。
  async 'POST /api/import'({ url, provider, reload = true }) {
    if (!url || !/^https?:\/\/.+/i.test(url)) return { ok: false, error: '订阅 URL 无效（需 http(s):// 开头）' };
    if (!fs.existsSync(mihomoCfg)) return { ok: false, error: `未找到 ${mihomoCfg}` };
    if (reload !== true) throw new Error('导入必须校验并应用，暂不支持未校验写盘');
    subscriptionUrl(url);
    const pname = providerName(provider || 'mysub');
    ensureBaseBackup();
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '');
    const bak = `${mihomoCfg}.bak.${ts}.${Math.random().toString(36).slice(2, 8)}`;
    fs.copyFileSync(mihomoCfg, bak);
    backup('导入订阅前');
    editProvider({ name: pname, url, switchTo: true });
    const info = `已导入订阅「${pname}」`;
    let reloaded = null;
    let subUpdated = null;
    let reloadError = null;
    let message = info; // 提前声明：热加载成功分支中会在 message 上追加同步结果（旧代码在此后声明，触发 TDZ 报错）
    if (reload) {
      const cp = readConfigProviders().find((p) => p.name === pname);
      const cacheFile = path.resolve(path.dirname(mihomoCfg), cp.path || `providers/${pname}.yaml`);
      const rr = await reloadValidatedConfig();
      if (!rr.ok) {
        reloaded = false;
        reloadError = rr.error
          ? `连接 mihomo 失败（${rr.error}），服务未运行？`
          : `请求被拒（HTTP ${rr.status}: ${(rr.body || '').slice(0, 120)}）`;
      } else {
        reloaded = true;
        await sleep(6000); // 等 mihomo 重新拉取订阅
        const update = await httpJson(mihomoApi + '/providers/proxies/' + encodeURIComponent(pname), 'PUT', null, 30000);
        subUpdated = update.ok && fs.existsSync(cacheFile);
        if (!subUpdated) throw new Error('订阅源未能成功拉取，未激活新订阅');
        // 导入/刷新后自动激活订阅里定义的组
        try {
          const gs = await syncSubscriptionGroups(pname);
          if (gs.ok === false) throw new Error(gs.error);
          else if (gs.changed) message += `，已激活 ${gs.injected} 个订阅组` + (gs.rules ? `，合并 ${gs.rules} 条订阅规则` : '');
        } catch (e) {
          throw e;
        }
      }
    }
    if (reloaded === null) message += '（未热加载）';
    else if (!reloaded) throw new Error('热加载失败：' + reloadError);
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
    const snapshot = await getConnectionsSnapshot();
    if (snapshot.error || !Array.isArray(snapshot.data?.connections)) return { ok: false, error: '获取连接列表失败（保留上次数据）' };
    return { ok: true, ...normalizeConnections(snapshot) };
  },

  // 关闭连接
  async 'DELETE /api/connections'({ id, ids }) {
    if (Array.isArray(ids)) {
      if (ids.length > 500 || ids.some((x) => typeof x !== 'string' || !x)) throw new Error('连接 ID 列表无效');
      const results = await Promise.all(ids.map(async (id) => ({ id, ok: (await httpJson(mihomoApi + '/connections/' + encodeURIComponent(id), 'DELETE')).ok })));
      return { ok: true, results, message: `已关闭 ${results.filter((x) => x.ok).length}/${ids.length} 个连接` };
    }
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
    const r = await run(config.journalctlBin, ['--user', '-u', config.serviceName, '-n', '200', '--no-pager'], 15000);
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
    const previous = await httpJson(mihomoApi + '/configs');
    if (!previous.ok) throw new Error('无法读取当前模式');
    const original = readConfig();
    backup('切换模式前');
    atomicWrite(mihomoCfg, setSection(original, 'mode', mode));
    try {
      const selections = await httpJson(mihomoApi + '/proxies');
      if (!selections.ok) throw new Error('无法读取节点选择');
      markRuntimeTouched(selections.json?.proxies, previous.json);
      const r = await httpJson(mihomoApi + '/configs', 'PATCH', { mode });
      const check = await httpJson(mihomoApi + '/configs');
      if (!r.ok || check.json?.mode !== mode) throw new Error('模式切换未确认');
      const overlay = readOverlay(); overlay.network.mode = mode;
      writeJson(stateFile('overrides.json'), overlay);
      const draft = readDraft();
      if (draft) { draft.overlay.network.mode = mode; writeJson(stateFile('draft.json'), draft); }
    } catch (e) {
      throw e;
    }
    return { ok: true, message: `已切换并保存${{ rule: '规则', global: '全局', direct: '直连' }[mode]}模式` };
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
    };
  },
};

Object.assign(handlers, managementHandlers);
const configMutations = new Set(['POST /api/subscriptions/activate', 'POST /api/subscriptions/delete', 'POST /api/subscriptions/edit', 'POST /api/import', 'POST /api/mode', 'POST /api/config/apply', 'POST /api/backups/restore']);
for (const [key, handler] of Object.entries(handlers)) {
  if (!key.startsWith('GET ') && !['POST /api/import/preview', 'POST /api/proxy-test'].includes(key)) {
    handlers[key] = (args) => serial(() => configMutations.has(key)
      ? transaction(key, () => handler(args))
      : handler(args));
  }
}
export { handlers };
