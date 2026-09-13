/**
 * 订阅组同步：把订阅缓存（providers/*.yaml）里 proxy-groups 段定义的组
 * 激活到主配置 config.yaml（复刻 Clash Verge 整份合并订阅 yaml 的效果）。
 *
 * 背景（mihomo v1.19.30 实测）：
 * - 组的 proxies: 列表【不能】直接引用 provider 节点名（热加载 400: not found）
 * - 组的 use: [provider] + filter: '<单个正则字符串>' 可用（filter 不支持列表！）
 * - 组的 proxies: 列表可引用 DIRECT/REJECT 等特殊名和其他组名（组间引用可行）
 * - use + filter + proxies 可混合
 * 因此注入时把订阅组成员拆成：provider 节点 → use+filter 正则；
 * 特殊名/组名 → proxies 列表；url-test 等选项行原文保留。
 *
 * 安全设计：
 * - 注入块用标记注释包裹，重复刷新幂等（先删旧块再写新块）
 * - 热加载被 mihomo 拒绝（400，继续跑旧配置）时回滚 config.yaml
 * - 写入前备份；热加载前记录各组当前选择，加载后恢复（热加载会重置选择）
 */
import fs from 'node:fs';
import path from 'node:path';
import { stateFile, atomicWrite, applyOverlay, reloadValidatedConfig, setSection, yamlObject, readConfig } from './config-store.js';
import { config } from '../config.js';
import { httpJson, sleep } from '../mihomo.js';

const { mihomoApi, mihomoCfg } = config;

const MARK_START = '# >>> 订阅分组（clash-web 自动生成，刷新订阅时重建，请勿手改）>>>';
const MARK_END = '# <<< 订阅分组（clash-web 自动生成）<<<';
// 订阅规则注入块（选中订阅源后，其 rules 段合并进主配置；恢复默认时移除）
const RULES_MARK_START = '# >>> 订阅规则（clash-web 自动生成，切换/刷新订阅时重建，请勿手改）>>>';
const RULES_MARK_END = '# <<< 订阅规则（clash-web 自动生成）<<<';

// mihomo 内置特殊代理名 + 主配置内置组名（注入时重名跳过；引用时视为合法目标）
const RESERVED = new Set([
  'GLOBAL', 'DIRECT', 'REJECT', 'PASS', 'COMPATIBLE', 'REJECT-DROP', 'PROXY', 'Auto',
]);

const unq = (s) => {
  const t = s.trim();
  if (t.length >= 2) {
    if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return t;
};

/** 解析流式映射 `{ k: v, k2: v2 }`（单行）→ [[key, 原始value], …]（值保留原引号）。
 *  用于 云边(claudeborder) 类订阅：整行写成 `- { name: ..., type: ..., proxies: [...] }`。 */
function parseFlowPairs(rest) {
  let s = rest.trim();
  if (s.startsWith('{')) s = s.slice(1);
  if (s.endsWith('}')) s = s.slice(0, -1);
  const parts = [];
  let depth = 0, cur = '', inQ = null;
  for (const ch of s) {
    if (inQ) { cur += ch; if (ch === inQ) inQ = null; continue; }
    if (ch === "'" || ch === '"') { inQ = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const out = [];
  for (const p of parts) {
    const ci = p.indexOf(':');
    if (ci <= 0) continue;
    const k = p.slice(0, ci).trim();
    const v = p.slice(ci + 1).trim();
    if (k) out.push([k, v]);
  }
  return out;
}

/** 拆分流式列表 `[a, b, 'c d']` → 元素数组（去引号、去空项）。 */
function parseFlowList(s) {
  let inner = s.trim();
  if (inner.startsWith('[')) inner = inner.slice(1);
  if (inner.endsWith(']')) inner = inner.slice(0, -1);
  const out = [];
  let cur = '', inQ = null, depth = 0;
  for (const ch of inner) {
    if (inQ) { cur += ch; if (ch === inQ) inQ = null; continue; }
    if (ch === "'" || ch === '"') { inQ = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => unq(x.trim())).filter(Boolean);
}

/** yaml 标量：简单名原样，含空格/特殊字符用单引号包裹（' 转义为 ''） */
function yamlScalar(s) {
  if (/^[A-Za-z0-9_][A-Za-z0-9_\-./ ]*$/.test(s) && !/^[\s'":#]/.test(s)) return s;
  return "'" + s.replace(/'/g, "''") + "'";
}

/** 正则转义（Go RE2 兼容：转义全部元字符） */
function escapeRegex(s) {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/**
 * 解析 provider 缓存 yaml：
 * 返回 { nodes: Set<节点名>（顶层 proxies 段）, groups: [{name, type, options, members}] }
 */
export function parseProviderFile(text) {
  const lines = text.split(/\r?\n/);
  const nodes = new Set();
  const groups = [];
  let section = null; // 'proxies' | 'groups' | null
  let cur = null;
  let inMembers = false;
  let nodeItem = null;
  let itemIndent = -1; // proxy-groups 列表项的缩进（首个 - 行决定，成员 - 行缩进更深）

  for (const line of lines) {
    if (/^\S/.test(line)) {
      section = /^proxies:\s*$/.test(line) ? 'proxies' : /^proxy-groups:\s*$/.test(line) ? 'groups' : null;
      inMembers = false;
      nodeItem = null;
      itemIndent = -1;
      continue;
    }
    if (!section) continue;
    const t = line.trim();
    const isDash = t === '-' || t.startsWith('- ');

    if (section === 'proxies') {
      if (isDash) {
        const rest = t === '-' ? '' : t.slice(2).trim();
        let nm = '';
        const m = rest.match(/^name:\s*(.+)$/);
        if (m) nm = unq(m[1]);
        else if (rest.startsWith('{')) {
          // 流式节点：- { name: X, type: ..., server: ... }
          for (const [k, v] of parseFlowPairs(rest)) if (k === 'name') { nm = unq(v); break; }
        }
        nodeItem = { name: nm };
        if (nm) nodes.add(nm);
        continue;
      }
      const m = t.match(/^name:\s*(.+)$/);
      if (m && nodeItem && !nodeItem.name) {
        nodeItem.name = unq(m[1]);
        nodes.add(nodeItem.name);
      }
      continue;
    }

    // section === 'groups'
    if (isDash) {
      const indent = line.length - line.trimStart().length;
      if (itemIndent === -1 || indent === itemIndent) {
        // 组列表项（新组开始）
        if (itemIndent === -1) itemIndent = indent;
        if (cur) groups.push(cur);
        cur = { name: '', type: '', options: [], members: [] };
        inMembers = false;
        const rest = t === '-' ? '' : t.slice(2).trim();
        let m;
        if (rest.startsWith('{')) {
          // 流式组：- { name: X, type: select, proxies: [...], url: '...', interval: 1800 }
          for (const [k, v] of parseFlowPairs(rest)) {
            if (k === 'name') cur.name = unq(v);
            else if (k === 'type') cur.type = v;
            else if (k === 'proxies') for (const mem of parseFlowList(v)) cur.members.push(mem);
            else cur.options.push(`    ${k}: ${v}`);
          }
        } else if ((m = rest.match(/^name:\s*(.+)$/))) cur.name = unq(m[1]);
        else if ((m = rest.match(/^type:\s*(\w+)\s*$/))) cur.type = m[1];
        else if (/^proxies:\s*$/.test(rest)) inMembers = true;
        else if (rest) cur.options.push(line);
        continue;
      }
      // 缩进更深的 - = 成员
      if (cur && inMembers) cur.members.push(unq(t.slice(2)));
      continue;
    }
    if (!cur) continue;
    let m;
    if ((m = t.match(/^name:\s*(.+)$/))) { cur.name = unq(m[1]); inMembers = false; }
    else if ((m = t.match(/^type:\s*(\w+)\s*$/))) { cur.type = m[1]; inMembers = false; }
    else if (/^proxies:\s*$/.test(t)) inMembers = true;
    else if (/^[\w-]+:/.test(t)) { inMembers = false; cur.options.push(line); }
  }
  if (cur) groups.push(cur);
  // 成员去重 + 剔除空名/自引用
  for (const g of groups) {
    const seenM = new Set();
    g.members = g.members.filter((m) => {
      if (!m || m === g.name || seenM.has(m)) return false;
      seenM.add(m);
      return true;
    });
  }
  return { nodes, groups };
}

/** config.yaml 实际声明的 provider 名集合（proxy-providers 段）+ default。
 *  mihomo v1.19 的 /providers/proxies 会把注入的订阅组也列进去（长得像 provider），需过滤。 */
export function configProviderNames() {
  const set = new Set(['default']);
  try { for (const name of Object.keys(yamlObject(readConfig())['proxy-providers'] || {})) set.add(name); } catch {}
  return set;
}

/** 解析 config.yaml 的 proxy-providers 段 → [{ name, url, path, interval }]（订阅源权威列表）。 */
export function readConfigProviders() {
  const out = [];
  try {
    for (const [name, raw] of Object.entries(yamlObject(readConfig())['proxy-providers'] || {})) {
      const provider = raw && typeof raw === 'object' ? raw : {};
      out.push({ name, url: typeof provider.url === 'string' ? provider.url : '',
        path: typeof provider.path === 'string' ? provider.path : '', interval: Number(provider.interval) || 0 });
    }
  } catch {}
  return out;
}

// 剔除自动注入块（其内容由 group-sync 管理，不算「用户选择」）。按整行匹配两个块的标记。
export function stripSubscriptionBlocks(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  const marks = new Map([[MARK_START, ['groups', true]], [MARK_END, ['groups', false]], [RULES_MARK_START, ['rules', true]], [RULES_MARK_END, ['rules', false]]]);
  const counts = { groups: [0, 0], rules: [0, 0] };
  let open = null;
  for (const line of lines) {
    const mark = marks.get(line.trim());
    if (!mark) { if (!open) out.push(line); continue; }
    const [kind, start] = mark;
    if (++counts[kind][start ? 0 : 1] > 1) throw new Error('订阅标记重复');
    if (start) {
      if (open) throw new Error('订阅标记不能嵌套或交叉');
      open = kind;
    } else {
      if (open !== kind) throw new Error('订阅标记不成对或顺序错误');
      open = null;
    }
  }
  if (open || counts.groups[0] !== counts.groups[1] || counts.rules[0] !== counts.rules[1]) throw new Error('订阅标记不完整');
  return out.join('\n');
}

/**
 * 「当前选中」的订阅源：主配置（注入块之外）use: 引用到的已声明 provider 名集合。
 * 激活（注入主配置）会把这些引用全部改指向目标源，所以该集合即用户当前选中的源。
 * 为空表示没有任何源被引用（调用方自行回退，例如按全部源处理）。
 */
export function activeProviderNames() {
  let parsed;
  try { parsed = yamlObject(stripSubscriptionBlocks(readConfig())); } catch { return []; }
  const declared = configProviderNames();
  const out = [];
  for (const group of parsed['proxy-groups'] || []) {
    for (const name of Array.isArray(group?.use) ? group.use : []) {
      if (name !== 'default' && declared.has(name) && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** 主配置（注入块之外）中 use: 了指定 provider 的组名列表——删除订阅源前的引用保护。 */
export function findProviderRefs(providerName) {
  let parsed;
  try { parsed = yamlObject(stripSubscriptionBlocks(readConfig())); } catch { return []; }
  const refs = [];
  for (const group of parsed['proxy-groups'] || []) {
    if (Array.isArray(group?.use) && group.use.includes(providerName) && typeof group.name === 'string') refs.push(group.name);
  }
  return [...new Set(refs)];
}

// ---- 选中源状态与默认配置备份 ----
const STATE_FILE = stateFile('selected.json');
const BASE_BACKUP = mihomoCfg + '.wjbase';

/** 读取当前选中的订阅源（'default' 或 provider 名）。
 *  无状态文件时回退：从已注入分组块的 use: 引用推断，推不出则为 'default'。 */
export function getSelectedSource() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (typeof st.selected === 'string' && st.selected) return st.selected;
  } catch {}
  try {
    const text = fs.readFileSync(mihomoCfg, 'utf8');
    let inBlock = false, inUse = false;
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (t === MARK_START) { inBlock = true; inUse = false; continue; }
      if (t === MARK_END) { inBlock = false; continue; }
      if (!inBlock) continue;
      if (/^use:\s*$/.test(t)) { inUse = true; continue; }
      if (inUse) {
        const m = t.match(/^-\s*([^\s'"]+)\s*$/);
        if (m && m[1] !== 'default') return m[1];
        inUse = false;
      }
    }
  } catch {}
  return 'default';
}

export function setSelectedSource(name) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    atomicWrite(STATE_FILE, JSON.stringify({ selected: name, at: new Date().toISOString() }, null, 2) + '\n');
  } catch (e) {
    throw new Error('写入选中源状态失败: ' + e.message);
  }
}

/** 原始配置快照（首次注入/恢复时创建，之后不覆盖）：默认配置的备份与恢复点。 */
export function ensureBaseBackup() {
  if (fs.existsSync(BASE_BACKUP)) return;
  try {
    const cur = fs.readFileSync(mihomoCfg, 'utf8');
    fs.writeFileSync(BASE_BACKUP, stripSubscriptionBlocks(cur));
  } catch (e) {
    console.warn('[group-sync] 创建默认配置快照失败:', e.message || e);
  }
}

/** 收集所有 provider 缓存：{ 节点名 → provider 名 } + 全部组定义（带 provider 归属）。
 * activeNames 非空时只收集这些 provider（「仅当前选中订阅源」语义）。
 */
function collectFromProviders(activeNames = null) {
  const nodeToProvider = new Map();
  const allGroups = [];
  for (const [provName, file] of providerFiles()) {
    if (activeNames && !activeNames.includes(provName)) continue;
    let parsed;
    try {
      parsed = parseProviderFile(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const n of parsed.nodes) nodeToProvider.set(n, provName);
    for (const g of parsed.groups) allGroups.push({ ...g, provider: provName });
  }
  return { nodeToProvider, allGroups };
}

/** provider 声明优先按其 path 读取；目录中没有声明的缓存才按 basename 兜底。 */
function providerFiles() {
  const dir = path.join(path.dirname(mihomoCfg), 'providers');
  const out = [];
  const seenFiles = new Set();
  const declared = new Set();
  for (const provider of readConfigProviders()) {
    declared.add(provider.name);
    const file = provider.path
      ? path.resolve(path.dirname(mihomoCfg), provider.path)
      : path.join(dir, `${provider.name}.yaml`);
    const resolved = path.resolve(file);
    if (!seenFiles.has(resolved)) { seenFiles.add(resolved); out.push([provider.name, resolved]); }
  }
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.ya?ml$/.test(name)) continue;
      const base = name.replace(/\.ya?ml$/, '');
      const file = path.resolve(dir, name);
      if (!declared.has(base) && !seenFiles.has(file)) { seenFiles.add(file); out.push([base, file]); }
    }
  } catch {}
  return out;
}

/** 读取缓存中订阅声明的组，provider 解析规则与节点/规则读取保持一致。 */
export function readProviderGroups(activeNames = null) {
  const out = [];
  for (const [provider, file] of providerFiles()) {
    if (activeNames && !activeNames.includes(provider)) continue;
    try {
      for (const group of parseProviderFile(fs.readFileSync(file, 'utf8')).groups) {
        out.push({ name: group.name, type: group.type, members: group.members });
      }
    } catch {}
  }
  return out;
}

// 规则末位 policy 关键字（如 IP-CIDR,...,DIRECT,no-resolve 的第 4 段）
const RULE_POLICY = /^(no-resolve|no-domain|reject|reject-drop|sniff|global)$/i;

// 解析单条规则内容（去掉前导 "- " 之后）：TYPE,payload,target[,policy]
function parseRuleLine(content) {
  const parts = content.split(',').map((x) => x.trim());
  const type = parts[0];
  let payload, target;
  if (parts.length === 1) { payload = ''; target = ''; }
  else if (parts.length === 2) { payload = ''; target = parts[1]; }
  else if (parts.length >= 4 && RULE_POLICY.test(parts[parts.length - 1])) {
    payload = parts.slice(1, parts.length - 2).join(',');
    target = parts[parts.length - 2];
  } else {
    payload = parts.slice(1, parts.length - 1).join(',');
    target = parts[parts.length - 1];
  }
  return { type, payload, target };
}

/** 提取 provider 缓存 yaml 顶层 rules: 段的原始规则行（保留原文，含 policy 参数），供注入主配置。 */
export function extractRuleLines(text) {
  const out = [];
  let inRules = false;
  for (const raw of text.split(/\r?\n/)) {
    if (!inRules) {
      if (/^rules:\s*$/.test(raw)) inRules = true;
      continue;
    }
    if (/^\S/.test(raw)) break; // 顶层新键 = 段结束
    const t = raw.trim();
    if (t === '-' || t.startsWith('- ')) {
      let v = t.replace(/^\s*-\s*/, '').trim();
      const q = v[0];
      if (v.length >= 2 && (q === "'" || q === '"') && v.endsWith(q)) v = v.slice(1, -1);
      out.push(v);
    }
  }
  return out;
}

/**
 * 解析 provider 缓存 yaml 顶层 rules: 段。
 * 行格式：`- TYPE,payload,target[,policy]`；DOMAIN-REGEX 等 payload 含逗号时尽量保留中间段。
 * 返回 [{ type, payload, target }]
 */
export function parseYamlRules(text) {
  const out = [];
  for (const content of extractRuleLines(text)) {
    const r = parseRuleLine(content);
    if (r.type && r.target) out.push(r);
  }
  return out;
}

/** 收集 provider 缓存的 rules 段（去重）：供前端展示“订阅定义但未生效”的规则。
 * activeNames 非空时只读这些 provider 的缓存。 */
export function readProviderRules(activeNames = null) {
  const out = [];
  const seen = new Set();
  for (const [provName, file] of providerFiles()) {
    if (activeNames && !activeNames.includes(provName)) continue;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const r of parseYamlRules(text)) {
      const k = `${r.type}|${r.payload}|${r.target}`;
      if (!seen.has(k)) { seen.add(k); out.push(r); }
    }
  }
  return out;
}

/** 顶层段范围（start = 段头行号，end = 下一个顶层键行号/文件尾）。 */
function sectionRange(lines, key) {
  const start = lines.findIndex((l) => new RegExp(`^${key}:\\s*$`).test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

/** 注入块外主配置的组名列表。 */
function baseGroupNames(lines) {
  const out = [];
  const r = sectionRange(lines, 'proxy-groups');
  if (!r) return out;
  for (let i = r.start + 1; i < r.end; i++) {
    const m = lines[i].match(/^\s*-\s*name:\s*(.+)$/);
    if (m) out.push(unq(m[1]));
  }
  return out;
}

/** 注入块外主配置的组数与规则数（用于「默认配置」卡片展示）。 */
export function readBaseSectionCounts() {
  let text = '';
  try { text = fs.readFileSync(mihomoCfg, 'utf8'); } catch { return { groups: 0, rules: 0 }; }
  const lines = stripSubscriptionBlocks(text).split(/\r?\n/);
  const pg = sectionRange(lines, 'proxy-groups');
  let groups = 0;
  if (pg) for (let i = pg.start + 1; i < pg.end; i++) if (/^\s*-\s*name:/.test(lines[i])) groups++;
  const rs = sectionRange(lines, 'rules');
  let rules = 0;
  if (rs) for (let i = rs.start + 1; i < rs.end; i++) { const t = lines[i].trim(); if (t === '-' || t.startsWith('- ')) rules++; }
  return { groups, rules };
}

/** 注入块外主配置的组名列表（“默认配置”态的组名，代理组页按选中源过滤用）。 */
export function readBaseGroupNames() {
  let text = '';
  try { text = fs.readFileSync(mihomoCfg, 'utf8'); } catch { return []; }
  return baseGroupNames(stripSubscriptionBlocks(text).split(/\r?\n/));
}

/** 读取订阅源缓存文件文本（优先 config 声明的 path，回退 providers/<name>.yaml）。 */
function providerFileText(name) {
  for (const [provider, file] of providerFiles()) if (provider === name) {
    try { return fs.readFileSync(file, 'utf8'); } catch {}
  }
  return '';
}

/** 把订阅规则块插入 rules: 段：插在最后一条 MATCH 规则之前（无 MATCH 则插到段尾；无 rules: 段则新建于文件尾）。 */
function insertRulesBlock(lines, block) {
  const r = sectionRange(lines, 'rules');
  if (!r) {
    const out = lines.slice();
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    return [...out, 'rules:', ...block];
  }
  let at = r.end;
  for (let i = r.start + 1; i < r.end; i++) {
    const t = lines[i].trim();
    if (/^MATCH([,\s]|$)/.test(t.replace(/^[-\s]+/, ''))) at = i;
  }
  return [...lines.slice(0, at), ...block, ...lines.slice(at)];
}

/**
 * 生成注入组 yaml。
 * - 成员拆分：provider 节点 → use:[provider]+filter 正则；特殊名/存活组名 → proxies 列表
 * - 不动点剔除：既无 provider 节点、引用的组也不存在的组丢弃（防悬空引用导致重载失败）
 */
function buildGroupLines(allGroups, nodeToProvider, existingNames) {
  // 候选组（跳过保留字/主配置已有组/同名重复）
  const cands = [];
  const seen = new Set();
  for (const g of allGroups) {
    if (RESERVED.has(g.name) || existingNames.has(g.name) || seen.has(g.name)) continue;
    seen.add(g.name);
    cands.push(g);
  }

  // 不动点：剔除无有效成员的组（引用链可能级联失效）
  const alive = new Set(cands.map((g) => g.name));
  let changedFlag = true;
  while (changedFlag) {
    changedFlag = false;
    for (const g of cands) {
      if (!alive.has(g.name)) continue;
      const hasProv = g.members.some((m) => nodeToProvider.has(m));
      const hasRef = g.members.some((m) => !nodeToProvider.has(m) && (alive.has(m) || RESERVED.has(m)));
      if (!hasProv && !hasRef) { alive.delete(g.name); changedFlag = true; }
    }
  }
  const dropped = cands.filter((g) => !alive.has(g.name)).map((g) => g.name);

  const picked = cands.filter((g) => alive.has(g.name)).map((g) => {
    const provNodes = g.members.filter((m) => nodeToProvider.has(m));
    const others = g.members.filter((m) => !nodeToProvider.has(m) && (alive.has(m) || RESERVED.has(m)));
    const provs = [...new Set(provNodes.map((m) => nodeToProvider.get(m)))];
    const lines = [`  - name: ${yamlScalar(g.name)}`, `    type: ${g.type || 'select'}`];
    for (const opt of g.options) lines.push(opt); // 原文行（4 空格缩进：url/interval/tolerance…）
    if (provs.length) {
      lines.push('    use:');
      for (const p of provs) lines.push(`      - ${yamlScalar(p)}`);
      if (provNodes.length) {
        const alt = provNodes.map(escapeRegex).join('|');
        lines.push(`    filter: ${yamlScalar('^(?:' + alt + ')$')}`);
      }
    }
    if (others.length) {
      lines.push('    proxies:');
      for (const o of others) lines.push(`      - ${yamlScalar(o)}`);
    }
    lines.push('');
    return { name: g.name, lines };
  });
  return { lines: picked.flatMap((p) => p.lines), picked, dropped };
}

/** 生成候选配置：删旧注入块（组+规则）→ 按选中源重建（插在 proxy-groups: 之后 / rules: 段内）。
 * selected='default' 时移除全部注入块（恢复原始规则与组）。
 * 返回 { candidate, picked, dropped, ruleCount, droppedRules, changed } 或 { error } */
function buildCandidate(selected) {
  const cfgText = fs.readFileSync(mihomoCfg, 'utf8');
  let lines = stripSubscriptionBlocks(cfgText).split(/\r?\n/);
  const isSub = selected !== 'default';
  let picked = [], dropped = [], ruleCount = 0, droppedRules = 0;

  if (isSub) {
    const { nodeToProvider, allGroups } = collectFromProviders([selected]);

    // ---- 组注入块（插在 proxy-groups: 之后）----
    if (allGroups.length) {
      const idx = lines.findIndex((l) => /^proxy-groups:\s*$/.test(l));
      if (idx === -1) return { error: 'config.yaml 未找到 proxy-groups 段，无法自动注入订阅组' };
      // 主配置现有组名（注入时跳过重名）
      const pg = sectionRange(lines, 'proxy-groups');
      const existingNames = new Set();
      for (let i = pg.start + 1; i < pg.end; i++) {
        const m = lines[i].match(/^\s*-\s*name:\s*(.+)$/);
        if (m) existingNames.add(unq(m[1]));
      }
      const bg = buildGroupLines(allGroups, nodeToProvider, existingNames);
      // 注意：不要在块外额外插入空行（strip 不会移除块外空行，会导致每次 sync 空行累积、changed 恒为 true）
      lines = [...lines.slice(0, idx + 1), MARK_START, ...bg.lines, MARK_END, ...lines.slice(idx + 1)];
      picked = bg.picked;
      dropped = bg.dropped;
    }

    // ---- 规则合并块（插入 rules: 段内，原基础规则原样保留，MATCH 兜底留在最后）----
    const text = providerFileText(selected);
    if (text) {
      const raw = extractRuleLines(text);
      // 合法目标：内置特殊名 + 主配置现有组 + 本次注入的组 + 选中源节点（运行时均为合法代理名）
      const valid = new Set([
        ...RESERVED,
        ...baseGroupNames(stripSubscriptionBlocks(cfgText).split(/\r?\n/)),
        ...picked.map((g) => g.name),
        ...nodeToProvider.keys(),
      ]);
      const kept = [];
      for (const l of raw) {
        const r = parseRuleLine(l);
        if (r && r.target && valid.has(r.target)) kept.push(l);
        else droppedRules++;
      }
      if (kept.length) {
        const block = [RULES_MARK_START, ...kept.map((l) => '  - ' + l), RULES_MARK_END];
        lines = insertRulesBlock(lines, block);
      }
      ruleCount = kept.length;
    }
  }

  const candidate = applyOverlay(lines.join('\n'));
  if (process.env.GROUP_SYNC_DEBUG) fs.writeFileSync('/tmp/group-sync-candidate.yaml', candidate);
  return { candidate, picked, dropped, ruleCount, droppedRules, changed: candidate !== cfgText };
}

/** 记录各组当前选择（热加载前） */
async function captureSelections() {
  const map = {};
  const r = await httpJson(mihomoApi + '/proxies');
  if (r.ok && r.json && r.json.proxies) {
    for (const p of Object.values(r.json.proxies)) {
      if (p && p.name && p.now) map[p.name] = p.now;
    }
  }
  return map;
}

/** 热加载后恢复各组原选择（仅当原选择仍是合法成员） */
async function restoreSelections(map) {
  const r = await httpJson(mihomoApi + '/proxies');
  if (!r.ok || !r.json || !r.json.proxies) return 0;
  let n = 0;
  for (const [g, now] of Object.entries(map)) {
    const p = r.json.proxies[g];
    if (p && (p.all || []).includes(now)) {
      await httpJson(mihomoApi + '/proxies/' + encodeURIComponent(g), 'PUT', { name: now });
      n++;
    }
  }
  return n;
}

async function hotReload() {
  const rr = await reloadValidatedConfig();
  if (!rr.ok) {
    return { ok: false, error: rr.error
      ? `连接 mihomo 失败（${rr.error}，服务未运行？）`
      : `HTTP ${rr.status}: ${(rr.body || '').slice(0, 200)}` };
  }
  await sleep(1500);
  return { ok: true };
}

/**
 * 完整流程：记录选择 → 生成候选 → 备份写盘 → 热加载（被拒则回滚）→ 恢复选择。
 * 幂等：配置无变化时跳过热加载。selected 缺省取 getSelectedSource()。
 */
export async function syncSubscriptionGroups(selected = null) {
  const target = selected || getSelectedSource();
  let built;
  try {
    built = buildCandidate(target);
  } catch (e) {
    return { ok: false, error: '生成候选配置失败: ' + (e.message || e) };
  }
  if (built.error) return { ok: false, error: built.error };
  const { candidate, picked, dropped, ruleCount } = built;

  if (!built.changed) {
    setSelectedSource(target);
    return { ok: true, injected: picked.length, rules: ruleCount, changed: false, note: '订阅组/规则配置无变化，跳过重载', names: picked.map((b) => b.name) };
  }

  // 备份 → 写盘 → 热加载（mihomo 对非法配置返回 400 且继续跑旧配置 = 天然校验）
  const sels = await captureSelections();
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '');
  const bak = `${mihomoCfg}.bak.groups.${ts}`;
  try {
    fs.copyFileSync(mihomoCfg, bak);
    atomicWrite(mihomoCfg, candidate);
  } catch (e) {
    return { ok: false, error: '写入 config.yaml 失败: ' + (e.message || e) };
  }
  const rl = await hotReload();
  if (!rl.ok) {
    // 重载被拒：mihomo 仍在跑旧配置，回滚文件保持一致
    try { fs.copyFileSync(bak, mihomoCfg); } catch {}
    return { ok: false, error: '热加载被 mihomo 拒绝（候选配置无效），已回滚: ' + rl.error, rolledBack: true, backup: bak };
  }
  const restored = await restoreSelections(sels);
  setSelectedSource(target);
  return {
    ok: true,
    injected: picked.length,
    rules: ruleCount,
    changed: true,
    reloaded: true,
    restored,
    backup: bak,
    names: picked.map((b) => b.name),
    dropped: dropped.length ? dropped : undefined,
    droppedRules: built.droppedRules || undefined,
  };
}

/** 恢复默认配置（原始配置快照：无注入的订阅组/规则）——「默认配置」卡片的激活动作。 */
export async function restoreDefaultConfig() {
  ensureBaseBackup();
  if (!fs.existsSync(BASE_BACKUP)) return { ok: false, error: '默认配置快照不存在，无法恢复' };
  let base, cur;
  try {
    base = fs.readFileSync(BASE_BACKUP, 'utf8');
    cur = fs.readFileSync(mihomoCfg, 'utf8');
    base = setSection(base, 'proxy-providers', yamlObject(cur)['proxy-providers'] || {});
    base = applyOverlay(base);
  } catch (e) {
    return { ok: false, error: '读取配置失败: ' + (e.message || e) };
  }
  if (base === cur) { setSelectedSource('default'); return { ok: true, changed: false, note: '当前已是默认配置' }; }
  const sels = await captureSelections();
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '');
  const bak = `${mihomoCfg}.bak.default.${ts}`;
  try {
    fs.copyFileSync(mihomoCfg, bak);
    atomicWrite(mihomoCfg, base);
  } catch (e) {
    return { ok: false, error: '写入 config.yaml 失败: ' + (e.message || e) };
  }
  const rl = await hotReload();
  if (!rl.ok) {
    try { fs.copyFileSync(bak, mihomoCfg); } catch {}
    return { ok: false, error: '热加载被 mihomo 拒绝，已回滚: ' + rl.error, rolledBack: true, backup: bak };
  }
  await restoreSelections(sels);
  setSelectedSource('default');
  return { ok: true, changed: true, reloaded: true, backup: bak };
}
