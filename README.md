# clash-web

`~/.zshrc` 中 `clash` 命令集（mihomo 代理管理）的可交互 Web UI。
零依赖：原生 Node `node:http` 后端 + 单文件前端，统一监听 **15924** 端口。

## 启动

```bash
clash-web          # 已写入 ~/.zshrc：端口空闲则拉起 node server.js，已有则直接提示地址
# 或手动:
node /home/jiaxingwang/main/workspace/agent/clash-web/server.js
```

浏览器打开 <http://localhost:15924>。停止：`pkill -f "clash-web/server.js"`。

## 功能（对应 clash 子命令）

| UI 区块 | 对应命令 | 实现 |
|---|---|---|
| 状态总览 | `status` | systemctl / ip / mihomo API / 直连 ipify 出口 IP |
| 全局服务 启动/停止/重启 | `start/stop/restart` | `systemctl --user` |
| 终端代理开关 | `on/off` | 创建/删除 `~/.clash_proxy_on`（内容与 zshrc 一致） |
| 节点切换 | `list/set` | mihomo API `127.0.0.1:9090/proxies/PROXY`，3s 自动刷新 + 搜索 |
| 节点延迟测试 | —（增强） | 可自定义测试链接（默认 google 204，localStorage 持久化）；后端走 mihomo 原生 `healthcheck` 端点 24 并发、单项 10s 超时，**不切换当前节点、互不干扰**（不依赖切选择器，坏节点标红不影响其余） |
| 实时流量 | —（增强） | mihomo `/traffic` 后端 2s 采样，SVG 折线（最近 4 分钟） |
| 连接列表 | —（增强） | mihomo `/connections`，2s 轮询，可单连接关闭 |
| 刷新订阅 | `update` | 逐个 PUT `/subscriptions/<name>` |
| 导入订阅源 | `import` | 备份 config.yaml → 更新 mysub / 新增 provider 并切组引用 → PUT `/configs` 热加载；失败回滚（`lib/import-sub.py` 与 zshrc 逻辑一致） |
| 版本 | `version` | `mihomo -v` |

## 结构

```
server.js          后端：HTTP 服务 + 全部 /api/* 路由 + 流量采样
public/index.html  前端单文件（内联 CSS/JS，浅色简洁风）
lib/import-sub.py  订阅源导入脚本（zshrc 同款逻辑）
```

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 服务/TUN/当前节点/终端代理/出口 IP/版本 |
| POST | `/api/service` | `{action: start\|stop\|restart}` |
| POST | `/api/proxy-env` | `{on: bool}` 终端代理开关 |
| GET | `/api/proxies` | 节点列表 + 当前节点 |
| POST | `/api/proxy-set` | `{name}` 切换节点 |
| POST | `/api/proxy-test` | `{url?, nodes}` 节点延迟测试：mihomo 原生 healthcheck、24 并发、单项 10s 超时、不切换当前节点 |
| GET | `/api/subscriptions` | 订阅源列表 |
| POST | `/api/subscriptions/refresh` | 刷新全部订阅 |
| POST | `/api/import` | `{url, provider?, reload?}` 导入订阅源 |
| GET | `/api/traffic` | 流量历史（2s 采样 ×120 点）+ 累计 |
| GET | `/api/connections` | 当前连接 |
| DELETE | `/api/connections` | `{id}` 关闭连接 |
| GET | `/api/version` | mihomo 版本 |

统一返回 `{ ok, data }`；失败 `ok=false` 且 data 内含 `error`。
