// 后端 /api/* 响应数据类型（与 server/routes.js 的返回结构对应）

export interface StatusData {
  service: string;
  tun: string | null;
  node: string | null;
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

export interface ProxiesData {
  now: string;
  all: string[];
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

export interface SubscriptionsData {
  subscriptions: string[];
}

export interface SubRefreshItem {
  name: string;
  ok: boolean;
  error: string | null;
  note?: string;
}

export interface SubRefreshData {
  results: SubRefreshItem[];
  summary: string;
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
