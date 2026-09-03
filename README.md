# clash-web

`~/.zshrc` 中 `clash` 命令集（mihomo 代理管理）的 Web UI。

**v2 架构**：Vue3 + Vite + TS + SCSS 前端 / 零运行时依赖 Node 后端（ESM），统一监听 **15924** 端口。

## 启动

```bash
# 开发模式（vite 5173 + node server 15924 并行）
npm run dev
# 浏览器打开 http://localhost:15924 —— 后端自动把页面请求转发到 vite dev server（带 HMR）
# 也可直接开 http://localhost:5173（/api 由 vite 代理到 15924）

# 生产模式（构建后由后端直接托管 dist/）
npm run build
npm start
```

停止：`pkill -f "clash-web/server/index.js"`（dev 模式 `pkill -f "clash-web.*vite\|clash-web/server"` 或 Ctrl+C）。

其他脚本：`npm run dev:web`（仅前端）、`npm run dev:api`（仅后端）、`npm run typecheck`（vue-tsc 类型检查）。

## 架构

```
server/                # 零运行时依赖 Node 后端（ESM，仅 node: 内置模块）
├── index.js           # HTTP 服务：/api/* 路由分发 + 前端（dist/ 静态托管 或 转发 vite dev server）
├── routes.js          # 13 个 /api/* 路由处理器（键 = "METHOD /path"，与 zshrc clash 命令集对应）
├── mihomo.js          # mihomo 交互原语：run/httpJson/fetchExitIp + 2s 流量采样器 + providers 快照
├── config.js          # 常量（端口/路径/代理标记文件内容）
└── lib/import-sub.py  # 订阅源导入脚本（改 config.yaml：更新 mysub 或新增 provider，含回滚由 server 负责）

src/                   # Vue3 + TS + SCSS 前端
├── api/               # client.ts（fetch 封装 + 超时） / types.ts（API 类型）
├── components/        # StatusCard / ServicePanel / TrafficChart / NodePanel /
│                      # ConnectionsPanel / SubscriptionPanel / ToastHost
├── composables/       # useStatus（8s 轮询）/ useToast（单例事件总线 toast）
├── styles/            # _variables.scss（主题变量）+ global.scss（基础样式，迁移自原单文件 CSS）
└── utils/format.ts    # bytes 格式化
```

**前端分发策略**（server/index.js）：`dist/` 存在 → 静态托管（生产）；不存在且 `CW_DEV=1`（`npm run dev` 自动设置）→ 转发到 vite dev server `127.0.0.1:5173`。开发时浏览器统一开 **15924**，HMR websocket 由 `hmr.clientPort=5173` 直连、不经后端。

## 功能（对应 clash 子命令）

| UI 区块 | 对应命令 | API |
|---|---|---|
| 状态总览 | `status` | `GET /api/status`（systemctl / ip / mihomo API / ipify 出口 IP） |
| 全局服务 启动/停止/重启 | `start/stop/restart` | `POST /api/service` |
| 终端代理开关 | `on/off` | `POST /api/proxy-env`（写/删 `~/.clash_proxy_on`，新终端生效） |
| 节点列表 + 切换 | `list/set` | `GET /api/proxies` / `POST /api/proxy-set` |
| 节点延迟测试 | —（扩展） | `POST /api/proxy-test`（mihomo 原生 healthcheck，全并发、单项 10s 超时，不切选择器） |
| 订阅列表（含用量/到期）/ 刷新 / 激活 / 删除 | `update` | `GET /api/subscriptions`（声明 ∪ 本地缓存源，含 declared/active 标记）/ `GET /api/subscriptions/userinfo` / `POST /api/subscriptions/refresh` / `POST /api/subscriptions/activate`（注入主配置）/ `POST /api/subscriptions/delete` |
| 导入订阅源 | `import` | `POST /api/import`（备份 → 改配置 → 热加载，失败回滚） |
| 实时流量 | —（扩展） | `GET /api/traffic`（后端 2s 采样、120 点环形缓冲） |
| 连接列表 / 关闭 | —（扩展） | `GET /api/connections` / `DELETE /api/connections` |

## 实现要点

- **流量**：后端常驻 2s 采样 mihomo `/traffic`（该端点高负载下单次要 12s+，逐次转发会堵死 API 队列），前端 2s 只读内存缓存。
- **节点测试**：走 mihomo 原生 `/providers/proxies/{p}/{n}/healthcheck`，不切换当前选择器、互不干扰；节点归属 provider 由 `/providers/proxies` 反查。
- **订阅刷新 / 导入的热加载**：`PUT /configs` 必须带 `{"path": ...}` body（mihomo v1.19 对空 body 返回 400）；热加载后等 6s 并比对 `~/.config/mihomo/providers/*.yaml` 的 mtime，区分「已更新 / 无变化（源不可达，仍在用旧节点）/ 服务未运行 / 请求被拒」——API 调通 ≠ 订阅真的拉到。
- **订阅列表**：mihomo v1.19 无 `/subscriptions` 端点（clash premium 功能），权威列表 = config.yaml `proxy-providers` 声明 ∪ `~/.config/mihomo/providers/*.yaml` 缓存文件；未声明源的 URL 从缓存文件 `#!MANAGED-CONFIG` 头回退解析；用量/到期来自订阅 URL 响应头 `subscription-userinfo`（经 mihomo 出口拉取，10min 缓存）。
- **激活订阅源（注入主配置）**：独占语义——`POST /api/subscriptions/activate` 把注入块之外的主配置组 `use:` 全部改指向目标源（未声明的源先自动补 proxy-providers 声明），热加载后重建订阅组；`active` = 有主配置组引用该源。删除被主配置组引用的源会被拒绝；仅本地缓存的源直接删文件。
- **节点名保留原样**：部分节点名含前导/尾随空格，trim 后 PUT 切换会 400。
- **零运行时依赖**：后端仅用 node: 内置模块；前端依赖（vue/vite 等）均为 devDependency，构建产物自包含。
