# UClash

**U = Universal。** UClash 是轻量、独立的通用代理管理 Web UI，目前支持 mihomo。

**v2 架构**：Vue3 + Vite + TS + SCSS 前端 / Node ESM 后端，统一监听 **15924** 端口。后端运行时依赖 `yaml`，请先安装生产依赖。

## 安装与启动

### 前置要求

请先安装并配置 [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo)，确保 mihomo API 与 user systemd 服务可以正常使用。UClash 默认连接 `http://127.0.0.1:9090`，服务名默认为 `mihomo`。

### 快速启动

```bash
# 克隆后安装依赖，并把 uclash 链接到当前 Node 环境
npm install
npm link

# 前台运行仓库中已提交的 dist，Ctrl+C 停止
uclash
uclash --port 18080

# 后台运行；端口默认 15924
uclash start
uclash start --port 18080
uclash stop
uclash restart
```

完成一次 `npm link` 后，可以在任意目录运行 `uclash` 启动本仓库中的 UClash。`uclash` 和 `uclash start` 默认在服务就绪后打开浏览器；服务器或无桌面环境可增加 `--no-open`：

```bash
uclash --no-open
uclash --port 18080 --no-open
uclash start --no-open
```

`uclash start` 会安装并管理当前用户的 `uclash.service`。`restart` 沿用最近一次 `start` 指定的端口。生产命令只启动仓库内的 `dist/`；如果构建文件不存在，CLI 会提示先运行 `npm run build`。仓库保留 `dist/`，正常 clone 后无需自行构建。

开发模式使用 `npm run dev`（Vite 5173 + API 15924）。其他脚本：`npm run build`、`npm run dev:web`、`npm run dev:api`、`npm run typecheck`。

## 架构

```
server/                # Node + YAML 后端（ESM）
├── index.js           # HTTP 服务：/api/* 路由分发 + 前端（dist/ 静态托管 或 转发 vite dev server）
├── cli.js             # uclash CLI 与 user systemd 服务管理
├── routes.js          # 订阅、代理、连接和状态等 /api/* 路由
├── management.js      # 规则、网络配置、诊断和备份管理 API
├── mihomo.js          # mihomo 交互原语：run/httpJson/fetchExitIp
├── config.js          # 端口、mihomo 与状态路径配置
└── lib/               # config-store、subscriptions、group-sync、connections 等配置与状态模块
    └── import-sub.py  # 历史订阅脚本（保留兼容；Web 订阅流程使用 subscriptions.js）

src/                   # Vue3 + TS + SCSS 前端
├── api/               # client.ts（fetch 封装 + 超时） / types.ts（API 类型）
├── components/        # StatusCard / ServicePanel / TrafficChart / NodePanel /
│                      # ConnectionsPanel / SubscriptionPanel / ToastHost
├── composables/       # useStatus（8s 轮询）/ useToast（单例事件总线 toast）
├── styles/            # _variables.scss（主题变量）+ global.scss（基础样式，迁移自原单文件 CSS）
└── utils/format.ts    # bytes 格式化
```

**前端分发策略**（server/index.js）：生产 CLI 只启动已提交的 `dist/`；`CW_DEV=1`（`npm run dev` 自动设置）时转发到 Vite dev server `127.0.0.1:5173`。开发时浏览器统一开 **15924**，HMR websocket 由 `hmr.clientPort=5173` 直连、不经后端。

## 功能

| UI 区块 | API |
|---|---|
| 状态总览 | `GET /api/status`（systemctl / mihomo API / ipify 出口 IP） |
| 全局服务 启动/停止/重启 | `POST /api/service` |
| 节点列表 + 切换 | `GET /api/proxies` / `POST /api/proxy-set` |
| 节点延迟测试 | `POST /api/proxy-test`（mihomo 原生 healthcheck，全并发、单项 10s 超时，不切选择器） |
| 订阅列表（含用量/到期）/ 刷新 / 激活 / 删除 | `GET /api/subscriptions`（内置「默认配置」卡片 ∪ 声明 ∪ 本地缓存源，含 builtin/declared/active 标记）/ `GET /api/subscriptions/userinfo` / `POST /api/subscriptions/refresh` / `POST /api/subscriptions/activate`（注入主配置；`default` = 恢复原始配置）/ `POST /api/subscriptions/delete`（default 不可删） |
| 导入订阅源 | `POST /api/import`（备份 → 改配置 → 热加载，失败回滚） |
| 实时流量 | `GET /api/connections`（根据 uploadTotal/downloadTotal 差分计算速率） |
| 连接列表 / 关闭 | `GET /api/connections` / `DELETE /api/connections` |
| 日志与网络诊断 | `GET /api/logs`（最近 200 行，自动轮询）/ `GET /api/diagnostics`（DNS、端口、核心状态及脱敏日志） |
| 规则页 | `GET /api/rules` / `POST /api/rules/draft` / `PUT /api/rules/providers/:name` |
| 网络与配置页 | `GET /api/network` / `GET /api/config/preview` / `POST /api/config/apply` |
| 备份页 | `GET /api/backups` / `POST /api/backups/create` / `GET /api/backups/export` / `POST /api/backups/restore` |

## 配置、草稿与订阅流程

- 规则和 TUN/DNS 等网络设置先保存为草稿，不会立即改变 mihomo 或现有连接；在“网络与配置”页预览后，必须手动确认“应用”才会写入并重载。恢复备份也需要手动确认，失败会回滚。
- 单源订阅刷新使用 mihomo 的 `PUT` 更新该 provider，不会全量重载配置；刷新后订阅组和规则不会自动改变，需手动重新应用当前订阅源。Web 订阅写入由 `server/lib/subscriptions.js` 完成；`import-sub.py` 仅保留作历史兼容路径。导入、编辑、删除和激活等明确的配置操作会按页面提示备份并在确认后重载。
- 备份包含主配置、覆盖层和当前选中源，不包含订阅缓存文件；恢复时要求本机路径和 mihomo 资源仍匹配。导出的备份可能含订阅凭证，请自行妥善保管。

## 环境变量

默认仅监听本机：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CW_HOST` | `127.0.0.1` | Web 服务监听地址；远程监听时必须同时设置强 token |
| `CW_TOKEN` | 空 | 远程管理必需，至少 24 个字符；请求使用 Bearer token |
| `CW_ALLOWED_ORIGINS` | 空 | 允许的跨域来源，逗号分隔；留空不额外放行来源 |
| `MIHOMO_API` | `http://127.0.0.1:9090` | mihomo 控制 API 地址 |
| `MIHOMO_SECRET` | 空 | mihomo 控制 API 的 secret |
| `MIHOMO_CONFIG` | `~/.config/mihomo/config.yaml` | 主配置路径 |
| `MIHOMO_BIN` | `/usr/local/bin/mihomo` | mihomo 可执行文件路径 |
| `MIHOMO_SERVICE` | `mihomo` | systemd user 服务名 |
| `CW_STATE_DIR` | 项目 `.pi/wj/clash-web/` | 覆盖层、草稿、备份等状态目录（保留旧路径以兼容已有数据） |
| `CW_BACKUP_LIMIT` | `20` | 本地备份保留数，范围 1–100 |

远程监听示例：

```bash
CW_HOST=0.0.0.0 CW_TOKEN='请使用至少24字符的随机值' npm start
```

## 实现要点

- **流量**：连接面板读取 mihomo `/connections` 返回的 `uploadTotal` / `downloadTotal`，按连续快照差分计算速率，避免使用持续流式的 `/traffic` 端点。
- **节点测试**：走 mihomo 原生 `/providers/proxies/{p}/{n}/healthcheck`，不切换当前选择器、互不干扰；节点归属 provider 由 `/providers/proxies` 反查。
- **订阅刷新**：单源刷新调用 mihomo provider 的 `PUT` 接口并保留当前运行配置；订阅组与规则更新需要用户在订阅页手动重新应用，避免无意重载导致连接中断。
- **订阅列表**：mihomo v1.19 无 `/subscriptions` 端点（clash premium 功能），权威列表 = config.yaml `proxy-providers` 声明 ∪ `~/.config/mihomo/providers/*.yaml` 缓存文件；未声明源的 URL 从缓存文件 `#!MANAGED-CONFIG` 头回退解析；用量/到期来自订阅 URL 响应头 `subscription-userinfo`（经 mihomo 出口拉取，10min 缓存）。
- **激活订阅源（注入主配置，独占语义）**：选中源记录在 `.pi/wj/clash-web/selected.json`。激活源 X 做两件事：① 把注入块之外主配置组的 `use:` 全部改指向 X（未声明的源先自动补 proxy-providers 声明）；② group-sync 把 X 的 `proxy-groups` 与 `rules` 合并注入主配置（两个自动生成块，写前备份、热加载被拒则回滚、各组选择 capture/restore）。再次应用用于刷新组和规则。
- **「默认配置」卡片（内置，不可删除）**：首次激活任一订阅源前，`ensureBaseBackup()` 保存原始配置快照 `config.yaml.wjbase`；激活 `default` = 剥离全部注入块、恢复原始规则/组（兼作备份与测试基线），订阅源声明与缓存文件均保留、可随时重新激活。
- **规则合并细节**：订阅 yaml 的 `rules:` 段原样行（保留 no-resolve 等参数）注入主配置 `rules:` 段内**最后一条 MATCH 之前**，基础规则原样保留；注入前按目标合法性过滤（内置特殊名 + 主配置现有组 + 本次注入组 + 该源节点名），避免悬空目标导致热加载 400。
- **组注入/代理组页按「当前选中源」过滤**：group-sync 与 `GET /api/proxies` 的 orphanGroups/subRules 均按 `getSelectedSource()` 过滤（选中 default 时为空）；多源时不串台。
- **注入块幂等**：两个自动块（组块/规则块）以 `# >>> … # <<<` 标记包裹、整体 strip 后重建，块外不额外写入空行，保证无变化时 `changed=false`、不触发多余热加载。
- **节点名保留原样**：部分节点名含前导/尾随空格，trim 后 PUT 切换会 400。
- **运行时依赖**：后端使用 `node:` 内置模块和 `yaml`；`yaml` 位于 `dependencies`，部署时不可省略生产依赖安装。

## 验证与部署注意

运行单元测试：`npm test`。测试使用临时目录和 mock mihomo/API，不操作真实 mihomo 服务或现有连接。发布前运行 `npm run build` 并提交更新后的 `dist/`。
