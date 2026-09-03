// 后端 /api/* 响应数据类型（与 server/routes.js 的返回结构对应）

export interface StatusData {
  service: string;
  tun: string | null;
  node: string | null;
  mode?: string | null;
  proxyOn: boolean;
  exitIp: string;
  version: string | null;
  mihomoAlive: boolean;
}

export interface ServiceResult {
  ok: boolean;
  service: string;
  message: string;
}

export interface ProxyEnvResult {
  ok: boolean;
  message: string;
}

export interface ProxyGroupView {
  name: string;
  type: string;
  now: string;
  all: string[];
  udp?: boolean;
}

export interface OrphanGroup {
  name: string;
  type: string;
  members: string[];
}

export interface RuleInfo {
  type: string;
  payload: string;
  proxy: string;
}

export interface SubRuleInfo {
  type: string;
  payload: string;
  target: string;
}

export interface ProxiesData {
  mode: string;
  groups: ProxyGroupView[];
  meta?: Record<string, { type?: string; udp?: boolean }>;
  orphanGroups?: OrphanGroup[];
  rules?: RuleInfo[];
  subRules?: SubRuleInfo[];
}

export interface ProxySetResult {
  ok: boolean;
  message: string;
}

export interface ProxyTestResult {
  name: string;
  ok: boolean;
  latency: number | null;
  http: number | null;
  error: string | null;
}

export interface ProxyTestData {
  url: string;
  count: number;
  method: string;
  results: ProxyTestResult[];
}

export interface TrafficPoint {
  t: number;
  up: number;
  down: number;
}

export interface TrafficData {
  history: TrafficPoint[];
  live: { up: number; down: number };
  intervalMs: number;
  maxPoints: number;
}

export interface ConnectionMeta {
  host?: string;
  sni?: string;
  source?: string;
  destination?: string;
}

export interface ConnectionItem {
  id: string;
  process?: string;
  metadata?: ConnectionMeta;
  upload: number;
  download: number;
}

export interface ConnectionsData {
  connections: ConnectionItem[];
}

export interface SubUserinfo {
  upload: number | null;
  download: number | null;
  total: number | null;
  expire: number | null;
}

export interface SubProviderCard {
  name: string;
  url: string;
  interval: number;
  nodes: number;
  updated: number;
  groupCount: number;
  ruleCount: number;
  /** 是否已声明在 config.yaml 的 proxy-providers 段 */
  declared: boolean;
  /** 是否为主配置当前激活源（PROXY/Auto 等组的 use: 指向它） */
  active: boolean;
  userinfo: SubUserinfo | null;
}

export interface SubscriptionsData {
  subscriptions: string[];
  providers: SubProviderCard[];
}

export interface SubUserinfoData {
  name: string;
  userinfo: SubUserinfo | null;
}

export interface SubDeleteData {
  message: string;
}

export interface SubActivateData {
  message: string;
}

export interface SubRefreshItem {
  name: string;
  ok: boolean;
  error: string | null;
  note?: string;
}

export interface GroupSyncData {
  ok: boolean;
  injected?: number;
  changed?: boolean;
  reloaded?: boolean;
  restored?: number;
  backup?: string;
  names?: string[];
  note?: string;
  error?: string;
}

export interface SubRefreshData {
  results: SubRefreshItem[];
  summary: string;
  groups?: GroupSyncData;
}

export interface ImportData {
  message: string;
  backup?: string;
  reloaded: boolean | null;
  subUpdated?: boolean | null;
}

export interface VersionData {
  version: string | null;
}

export interface ModeData {
  mode: string;
}

export interface ModeResult {
  ok: boolean;
  message: string;
}

export interface LogsData {
  lines: string[];
}

export interface ConfigInfoData {
  webPort: number;
  mihomoApi: string;
  mihomoBin: string;
  mihomoCfg: string;
  providersDir: string;
  proxyOnFile: string;
}
