# PicoClaw macOS Launchd 守护经验（本机）

> 记录时间：2026-07-15  
> 机器：本机 macOS（user `doge`）  
> 背景：`http://localhost:18800` 的 PicoClaw Web 控制台经常显示「服务未运行 / 服务断开」，希望**不挂着终端/控制台**也能 7×24 跑，并在崩溃后自动恢复。

本文不是 lodestar 功能文档，而是本机旁路服务 **PicoClaw** 的运维备注，便于以后升级二进制、排障或重装 LaunchAgent 时对照。

---

## 1. 结论摘要

| 现象 | 根因 | 处理 |
|---|---|---|
| UI 显示「服务未运行」 | **Gateway 子进程挂了**，不是 18800 控制台一定挂了 | 用 launchd 单独托管 `picoclaw gateway` |
| 关终端后服务没了 | 以前用前台 `picoclaw-launcher` 跑在 zsh 下（`S+`） | 改 LaunchAgent，PPID=1 |
| 已有 `io.picoclaw.launcher.plist` 却没用 | **plist 写过但从未 bootstrap 进 launchd**；且无 KeepAlive | 补 KeepAlive + 真正 load |
| 钉钉反复断 / gateway `exit status 2` | ① 钉钉 SDK `panic: send on closed channel`；② 走本机代理 `127.0.0.1:7890` 时代理抖动 | daemon **不注入** `HTTP(S)_PROXY`；靠 KeepAlive 重启兜底 |
| 首次用 launchd 起不来（RSS≈144KB、不监听） | 二进制仍在 `~/Downloads/...`，带 `com.apple.quarantine`，launchd 下异常 | 迁到 `~/.local/picoclaw/` 并清 quarantine |

**当前推荐拓扑（已落地）：**

```
launchd (gui/$UID)
├─ io.picoclaw.gateway   → ~/.local/picoclaw/picoclaw gateway     → :18790  (通道真相源)
└─ io.picoclaw.launcher  → ~/.local/picoclaw/picoclaw-launcher    → :18800  (Web 控制台)
                           -console -no-browser ~/.picoclaw/config.json
```

- **通道在线**只依赖 `io.picoclaw.gateway`，不需要开浏览器/终端。
- Web UI 是可选管理面；UI 里「启动服务」管的是 **launcher 自己拉起的 gateway 子进程**，和 launchd 托管的独立 gateway **不是同一套视图**。以 `18790/health` 与 `launchctl list` 为准。

---

## 2. 路径与版本

| 项 | 路径 / 值 |
|---|---|
| 稳定二进制目录 | `~/.local/picoclaw/` |
| 可执行文件 | `~/.local/picoclaw/picoclaw`、`~/.local/picoclaw/picoclaw-launcher` |
| 配置 / 工作区 | `~/.picoclaw/config.json`、`~/.picoclaw/workspace/` |
| 应用日志 | `~/.picoclaw/logs/{gateway,launcher,gateway_panic,launcher_panic}.log` |
| launchd 兜底日志 | `~/Library/Logs/picoclaw/{gateway,launcher}.{out,err}.log` |
| LaunchAgent | `~/Library/LaunchAgents/io.picoclaw.{gateway,launcher}.plist` |
| 旧下载目录（勿再直接跑） | `~/Downloads/picoclaw_Darwin_arm64/` |
| 实测版本 | PicoClaw **0.2.9**（git `2992eccb`，build 2026-05-29） |
| 默认模型（本机 config） | `glm-5.2` |
| 启用通道（本机 config） | `dingtalk` + `pico`（feishu 等未开） |

签名：`Developer ID Application: Sipeed Co., Ltd (3WJC9H6YLM)`。

---

## 3. 两套进程分别干什么

### 3.1 Gateway（必保活）

```bash
~/.local/picoclaw/picoclaw gateway
```

- 监听 **`127.0.0.1:18790` / `[::1]:18790`**
- 健康检查：`GET http://127.0.0.1:18790/health` → `{"status":"ok",...}`
- 负责 channel（钉钉 stream、cron、heartbeat 等）
- **这是「服务是否在跑」的权威**

### 3.2 Launcher / Web 控制台（可选）

```bash
~/.local/picoclaw/picoclaw-launcher -console -no-browser ~/.picoclaw/config.json
```

- 监听 **`127.0.0.1:18800` / `[::1]:18800`**
- Dashboard：`http://localhost:18800`
- API 多数要登录（未登录 `/api/*` 会 `401 unauthorized`）
- `-console`：无 GUI；`-no-browser`：不自动弹浏览器
- 适合改配置、看对话 UI；**不是通道存活的必要条件**

> 历史坑：只跑 launcher、靠 UI 点「启动服务」时，gateway 挂掉后 UI 变红，且 launcher 未必可靠自动拉起（日志里多次 `Gateway process exited: exit status 2`）。

---

## 4. LaunchAgent 设计要点

对照本机 lodestar 的 `com.supercc168.lodestar` 写法：

1. **`RunAtLoad=true`**：登录后自动起  
2. **`KeepAlive.SuccessfulExit=false`**：非 0 退出（崩溃 / SIGKILL）自动拉起；干净 exit 0 则保持停  
3. **不注入 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`**  
   - 旧前台进程环境里有 `http://127.0.0.1:7890`  
   - gateway 日志大量：`proxyconnect tcp: dial tcp 127.0.0.1:7890: connection refused` / `use of closed network connection`  
   - 钉钉直连外网更稳（本机实测无 proxy 后能建到 `*:443`）  
4. 只设 `HOME` / `PATH` / `NO_PROXY`  
5. stdout/stderr 落到 `~/Library/Logs/picoclaw/`，业务日志仍看 `~/.picoclaw/logs/`  
6. 二进制用 **`~/.local/picoclaw/`**，不要指向 Downloads

### 4.1 `io.picoclaw.gateway.plist`（关键字段）

- Label: `io.picoclaw.gateway`
- Program: `~/.local/picoclaw/picoclaw` `gateway`
- WorkingDirectory: `~/.picoclaw`
- KeepAlive: `SuccessfulExit=false`
- 日志: `~/Library/Logs/picoclaw/gateway.{out,err}.log`

### 4.2 `io.picoclaw.launcher.plist`（关键字段）

- Label: `io.picoclaw.launcher`
- Program: `~/.local/picoclaw/picoclaw-launcher` `-console` `-no-browser` `~/.picoclaw/config.json`
- 其余同 gateway 风格

完整 XML 以本机 `~/Library/LaunchAgents/` 下现文件为准。

---

## 5. 安装 / 重装步骤（可复用）

```bash
# 0) 准备目录与二进制
mkdir -p ~/.local/picoclaw ~/Library/Logs/picoclaw
cp -f ~/Downloads/picoclaw_Darwin_arm64/picoclaw \
      ~/Downloads/picoclaw_Darwin_arm64/picoclaw-launcher \
      ~/.local/picoclaw/
chmod +x ~/.local/picoclaw/picoclaw ~/.local/picoclaw/picoclaw-launcher
xattr -dr com.apple.quarantine ~/.local/picoclaw 2>/dev/null || true

# 1) 停掉手动前台进程，避免端口冲突
pkill -f 'picoclaw-launcher' 2>/dev/null || true
pkill -f 'picoclaw gateway' 2>/dev/null || true

# 2) 写好两个 plist 后加载
UID_NUM=$(id -u)
launchctl bootout "gui/${UID_NUM}/io.picoclaw.gateway" 2>/dev/null || true
launchctl bootout "gui/${UID_NUM}/io.picoclaw.launcher" 2>/dev/null || true
launchctl bootstrap "gui/${UID_NUM}" ~/Library/LaunchAgents/io.picoclaw.gateway.plist
launchctl bootstrap "gui/${UID_NUM}" ~/Library/LaunchAgents/io.picoclaw.launcher.plist

# 3) 核验
launchctl list | rg picoclaw
curl -sS http://127.0.0.1:18790/health
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18800/
# 期望：health 为 status=ok；18800 为 302 或 200
ps eww -p $(pgrep -n -f 'picoclaw gateway') | tr ' ' '\n' | rg -i 'PROXY=' || echo 'no proxy (good)'
```

### KeepAlive 冒烟（2026-07-15 已过）

```bash
OLD=$(pgrep -n -f 'picoclaw gateway')
kill -9 "$OLD"
# ~1s 内应出现新 PID 且 18790 恢复
curl -sS http://127.0.0.1:18790/health
```

---

## 6. 日常运维速查

```bash
# 状态
launchctl list | rg picoclaw
launchctl print "gui/$(id -u)/io.picoclaw.gateway" | head -40
pgrep -fl picoclaw
lsof -nP -iTCP:18790 -sTCP:LISTEN
lsof -nP -iTCP:18800 -sTCP:LISTEN

# 重启（热拉起）
launchctl kickstart -k "gui/$(id -u)/io.picoclaw.gateway"
launchctl kickstart -k "gui/$(id -u)/io.picoclaw.launcher"

# 停止（干净停，KeepAlive 不立刻拉回）
launchctl bootout "gui/$(id -u)/io.picoclaw.gateway"
launchctl bootout "gui/$(id -u)/io.picoclaw.launcher"

# 日志
tail -f ~/Library/Logs/picoclaw/gateway.out.log
tail -f ~/.picoclaw/logs/gateway.log
tail -f ~/.picoclaw/logs/gateway_panic.log
```

### 升级二进制

1. 覆盖 `~/.local/picoclaw/picoclaw{,-launcher}`
2. `xattr -dr com.apple.quarantine ~/.local/picoclaw`
3. `launchctl kickstart -k gui/$(id -u)/io.picoclaw.gateway`（launcher 同理）
4. 再跑 `version` / `health` 核验

---

## 7. 排障清单

### 7.1 UI 红字「服务未运行」

1. `curl -s http://127.0.0.1:18790/health`  
   - ok → 通道其实在线；UI 可能只是 launcher 侧状态不同步，可忽略或点一次「启动服务」  
   - 不通 → 看 `launchctl list | rg picoclaw` 与 `gateway.out.log` / `gateway_panic.log`
2. 不要只看浏览器；**权威是 18790 + launchd**

### 7.2 进程在、端口不听、RSS 极小

- 高度怀疑 **quarantine / Downloads 路径**  
- 迁到 `~/.local/picoclaw/`，`xattr -dr com.apple.quarantine`，再 bootstrap

### 7.3 钉钉断连

日志关键词：

- `proxyconnect tcp: dial tcp 127.0.0.1:7890`
- `ping time out, connection is closing`
- `panic: send on closed channel`（钉钉 stream SDK）

处理：

1. 确认 launchd 环境**没有** proxy（`ps eww -p <pid>`）
2. 接受 SDK panic 时进程会死 → 依赖 KeepAlive 秒级拉起（会有短暂空窗）
3. 若必须代理：先保证 7890 代理本身是 launchd 托管 7×24，再改 plist 注入

### 7.4 双实例 / 端口占用

- 不要同时手动前台 + launchd  
- 不要让 launcher「启动服务」再起一个 gateway 与 launchd gateway 抢资源时，优先保留 **launchd gateway**  
- `lsof -nP -iTCP:18790,18800 -sTCP:LISTEN` 确认只有预期 PID

### 7.5 plist 改了不生效

macOS 上改已 load 的 plist 后需要：

```bash
launchctl bootout "gui/$(id -u)/io.picoclaw.gateway"
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/io.picoclaw.gateway.plist
```

或 `kickstart -k`（部分字段变更仍建议 bootout/bootstrap）。

---

## 8. 与 lodestar 的关系（边界）

| | Lodestar | PicoClaw（本文） |
|---|---|---|
| 用途 | 飞书群 ↔ Claude/Codex 桥 | 独立个人助理（钉钉等 channel + Web UI） |
| launchd label | `com.supercc168.lodestar` | `io.picoclaw.gateway` / `io.picoclaw.launcher` |
| 端口 | daemon 本机通知等（如 9876） | **18790** gateway / **18800** UI |
| 配置 | `~/.config/lodestar/config.toml` | `~/.picoclaw/config.json` |
| 是否同一进程 | 否 | 否 |

两者可并存；**不要**把 picoclaw 命令塞进 lodestar 的 plist，也不要用 lodestar 的 stop/restart 去管 picoclaw。

本机 config 里 feishu channel 目前是关闭的；飞书群机器人继续走 lodestar，钉钉侧走 picoclaw。

---

## 9. 已知残留风险 / 未做事项

- [ ] 钉钉 SDK panic 仍是上游问题，KeepAlive 只能恢复进程，不能消灭空窗  
- [ ] launcher UI 与独立 gateway 的「服务状态」语义可能不一致，避免只信 UI 红点  
- [ ] `allow_from` 为空时日志会打 SECURITY 警告（通道允许所有人）；若收紧权限需改 `~/.picoclaw/config.json`  
- [ ] MCP enabled 但未配 server：仅 warn，可忽略  
- [ ] 若以后要「开机前就起 / 无 GUI 登录也起」，需改 Login 外的其他机制（当前是用户 LaunchAgent，依赖登录会话）

---

## 10. 关键命令备忘（picoclaw CLI）

```bash
~/.local/picoclaw/picoclaw version
~/.local/picoclaw/picoclaw status
~/.local/picoclaw/picoclaw gateway --help
~/.local/picoclaw/picoclaw-launcher --help
```

常用 launcher 参数：

- `-console` 无 GUI  
- `-no-browser` 不自动开浏览器  
- `-port 18800`（默认）  
- `-public` / `-host` 改监听面（默认本机；**生产勿随意 public**）

---

## 11. 变更记录

| 日期 | 事项 |
|---|---|
| 2026-07-15 | 从终端前台 launcher 迁到 launchd 双 agent；二进制迁 `~/.local/picoclaw`；去掉 proxy；KeepAlive 实测 SIGKILL 约 1s 恢复；本文档落盘 |
