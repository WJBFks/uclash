# UClash

**U = Universal。** UClash 是轻量、独立的通用代理管理 Web UI，目前支持 mihomo。

**v2 架构**：Vue3 + Vite + TS + SCSS 前端 / Node ESM 后端，统一监听 **15924** 端口。后端运行时依赖 `yaml`，请先安装生产依赖。

## 安装与启动

### 前置要求

UClash 不负责安装代理核心。请先从 [MetaCubeX/mihomo Releases](https://github.com/MetaCubeX/mihomo/releases) 获取 mihomo，并完成配置；源码仓库本身不是 systemd 服务安装器。

UClash 默认连接一个已经运行的 mihomo 实例，约定如下：

- user systemd 服务名为 `mihomo.service`，可通过 `MIHOMO_SERVICE` 修改。
- mihomo 控制 API 监听 `http://127.0.0.1:9090`，可通过 `MIHOMO_API` 修改。
- UClash 会自动查找 `~/.local/bin/mihomo`、`PATH` 与常见系统安装位置，也可通过 `MIHOMO_BIN` 显式指定。
- 主配置位于 `~/.config/mihomo/config.yaml`，可通过 `MIHOMO_CONFIG` 修改。
- 使用 TUN 时，需要按系统方式授予 mihomo 相应网络权限。

本项目当前验证过的部署方式是手工安装官方 mihomo 二进制，并创建 `~/.config/systemd/user/mihomo.service`，以 `/usr/local/bin/mihomo -d ~/.config/mihomo` 启动。也可以参考 MetaCubeX 的 [systemd 服务文档](https://github.com/MetaCubeX/Meta-Docs/blob/main/docs/startup/service/index.md)，再按上面的默认值或环境变量适配 UClash。

#### 交给 Agent 安装 mihomo

如果不熟悉 mihomo 的下载、安装和 systemd 配置，可以把下面整段 Prompt 交给能够操作终端的 Agent：

```text
请在这台 Linux 主机上安装并配置 mihomo，使其能够被 UClash 管理。

官方 mihomo Releases：
https://github.com/MetaCubeX/mihomo/releases

官方 systemd 服务文档：
https://github.com/MetaCubeX/Meta-Docs/blob/main/docs/startup/service/index.md

请遵守以下要求：

1. 先只读检查系统发行版、CPU 架构、Node 用户、systemd user session、现有 mihomo 二进制、配置文件、服务状态、监听端口和文件 capability。识别 x86_64/amd64、aarch64/arm64 等架构映射。
2. 如果已有 mihomo 服务或配置，先报告当前安装方式并备份相关文件。未经我明确确认，不得停止、重启、重新加载或覆盖正在运行的代理服务，避免当前网络连接中断。
3. 只允许从上述 MetaCubeX/mihomo Releases 官方地址下载适合本机架构的稳定版。不要使用来历不明的镜像或第三方二进制；官方提供校验文件时必须验证校验值。
4. 首选将二进制安装为 /usr/local/bin/mihomo。如果当前权限或环境不适合，则使用 ~/.local/bin/mihomo，并在最终结果中给出正确的 MIHOMO_BIN。
5. 配置目录使用 ~/.config/mihomo，主配置文件使用 ~/.config/mihomo/config.yaml。已有配置必须保留有效内容。若没有配置，只创建不会接管网络的最小安全配置：API 仅监听 127.0.0.1:9090、allow-lan 为 false、TUN 默认关闭。不要虚构订阅地址、代理节点或密钥。
6. 订阅 URL、代理凭据和 mihomo secret 属于敏感信息。不要要求我在公开聊天中提供，不要在日志或最终回复中输出，也不要提交到 Git。需要订阅时说明应由我随后通过本机配置或 UClash 导入。
7. 创建 user systemd 服务 ~/.config/systemd/user/mihomo.service，服务名必须是 mihomo.service，ExecStart 使用实际 mihomo 路径并带参数 -d %h/.config/mihomo，设置 Restart=on-failure。使用 systemctl --user 管理，不要创建另一个含糊或重复的 mihomo 进程。
8. 如果我要使用 TUN，先解释需要的权限，并按以下步骤配置与验证：
   - 执行 `test -c /dev/net/tun` 确认 TUN 设备存在；如果不存在，先报告缺失，不要盲目继续。
   - 执行 `systemctl --user cat mihomo.service` 读取 `ExecStart=`，确定服务真正使用的 mihomo 二进制绝对路径。不能只依赖 `command -v mihomo`，因为它可能指向另一份二进制。
   - 向我展示实际路径和将要执行的命令，获得 sudo 授权后执行 `sudo setcap cap_net_admin,cap_net_raw+ep /actual/path/to/mihomo`。只给 mihomo 二进制授予最小必要权限，不要为了省事让整个服务以 root 身份运行。
   - 执行 `getcap /actual/path/to/mihomo`，必须确认输出包含 `cap_net_admin,cap_net_raw=ep`。如果服务使用的路径与授权路径不同，立即停止并修正。
   - 提醒我：替换或升级 mihomo 二进制通常会丢失 file capability，升级后必须重新执行 `setcap` 和 `getcap`。
   - 权限验证通过后，使用通用基础配置 `tun: { enable: false, stack: system, auto-route: true, auto-detect-interface: true }`；保持 TUN 默认关闭，由我随后在 UClash 点击“启动 TUN”。
   - 新配置首次启用 TUN、重启 mihomo 或任何可能改变路由的操作前，必须得到我的明确确认。
9. 写入前使用 mihomo -t 验证配置。完成安装后验证 mihomo -v、systemd unit、服务状态、127.0.0.1:9090 API、日志和实际配置路径。不得仅凭命令退出码宣称成功。
10. 最后给出简短报告：安装版本、CPU 架构、二进制路径、配置路径、服务名、API 地址、TUN 是否启用、验证结果，以及 UClash 需要设置的 MIHOMO_BIN、MIHOMO_CONFIG、MIHOMO_SERVICE、MIHOMO_API。敏感值必须脱敏。

在整个过程中优先保护现有连接。只读检查和准备工作可以直接进行；需要 sudo、替换现有文件或影响当前代理连接时，先展示将要执行的具体变更。
```

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
uclash restart --no-open
```

完成一次 `npm link` 后，可以在任意目录运行 `uclash` 启动本仓库中的 UClash。`uclash` 和 `uclash start` 默认在服务就绪后打开浏览器；服务器或无桌面环境可增加 `--no-open`：

```bash
uclash --no-open
uclash --port 18080 --no-open
uclash start --no-open
```

`uclash start` 会安装并管理当前用户的 `uclash.service`。`restart` 沿用最近一次 `start` 指定的端口，重启后输出访问地址并默认打开浏览器；服务器环境使用 `uclash restart --no-open`。生产命令只启动仓库内的 `dist/`；如果构建文件不存在，CLI 会提示先运行 `npm run build`。仓库保留 `dist/`，正常 clone 后无需自行构建。

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
- 首页“启动 TUN”在配置缺项时补全通用默认值：`stack: system`、`auto-route: true`、`auto-detect-interface: true`。Linux 主机仍需要 `/dev/net/tun` 与 mihomo 服务的 `CAP_NET_ADMIN`/`CAP_NET_RAW`；缺少时 UClash 会回滚配置并显示检查提示。
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
| `MIHOMO_BIN` | 自动查找 | mihomo 可执行文件路径 |
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
