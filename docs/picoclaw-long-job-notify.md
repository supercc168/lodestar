# PicoClaw 长任务完成通知（本机实证）

> 配套可安装示例：[`examples/picoclaw-job-notify/`](examples/picoclaw-job-notify/)
> 姊妹篇：[PicoClaw macOS Launchd 守护经验](picoclaw-launchd-daemon.md)

## 1. 结论摘要

**症状**：用 IM（钉钉）叫 picoclaw 跑一个十几分钟的部署脚本，脚本成功跑完了，
群里**一声不吭**；直到用户主动问「进度？」才回一条结论。

**这不是故障，是架构缺口。** 三个事实叠加：

1. picoclaw 的 `exec` 工具带 `background=true` 时**没有完成回调**——启动即返回 sessionId，
   任务结束不产生任何事件。
2. gateway **没有消息注入端点**。本机实测只有 `/health`(200)、`/ready`(200)、`/reload`(405)，
   `/notify` `/message` `/send` `/cron` 等一律 404。**外部进程没法让 picoclaw 主动说一句话。**
3. agent 是回合驱动的：不来新消息就不产生新回复。于是「长任务协议」只能写成
   「启动后立刻收尾本轮，用户再问再查」——**等于把通知责任推给用户**。

再加两个放大器：

- **后台 session 短命**：任务结束后回头 `exec poll` 会拿到 `session not found`，
  连「回去看看跑完没」这条退路都不可靠。
- **结束不留结果**：常见写法是任务收尾时把心跳/状态文件删掉，于是用户回头问的时候，
  agent 也无从答起，只能翻日志、比对产物时间戳去**反推**结论——慢、烧 tool 轮次、还容易猜错。

**修法**：不指望 picoclaw 主动说话，改成**脚本自己在收尾处直调 IM 开放平台 API 推送**，
并把最终结果**留档**；推送失败由一个已有的定时器补播。整条链路不依赖 gateway 存活。

## 2. picoclaw 自带的主动能力，以及为什么都不合适

排查时先把官方能力过了一遍，结论是**都能主动发消息，但都不适合做「任务完成通知」**：

| 能力 | 状态 | 为什么不用 |
|------|------|-----------|
| `message` 工具 | 可用 | 只有 agent 在一次 turn 内能调；任务跑完时没有 turn 在运行 |
| `cron` 工具 | 可用但空置 | `cron add` 只接受 `--message`（给 agent 的消息）＝**每次触发烧一个 LLM turn**。5 分钟一次就是 288 次/天，且 gateway 崩溃时不跑 |
| `spawn` 子 agent | 可用但从未用过 | 完成后确实会自动推 `Subagent task completed:`，但要把十几分钟的部署塞进子 agent 生命周期，比直接推一条消息脆弱得多 |
| `heartbeat` 服务 | 配置开着，实际空转 | `HEARTBEAT.md` 任务区默认为空；本机 `heartbeat.log` 只有一行「建默认模板」，此后再无记录 |

一句话：**picoclaw 侧的主动通道全部要求 agent 参与，成本是一个 LLM turn，而且都跟着 gateway 一起死。**
任务完成通知恰恰要求「便宜、可靠、gateway 挂了也要送到」，所以绕开它自己发。

## 3. 链路

```
长任务脚本
   ├─ jobnotify_begin      记开始时间，装异常退出兜底 trap
   ├─ jobnotify_step       更新当前步骤（异常中断时用来说明死在哪）
   └─ jobnotify_ok/fail ──▶ jobnotify_finish
                              ├─ 1. 留档  → JOBNOTIFY_STATE_FILE
                              ├─ 2. 推送  → 开放平台 accessToken → 机器人发群消息
                              └─ 3. 标记  → notified=true / false+attempts+1

定时器（已有的 watchdog，如 StartInterval=300）
   └─ notify-pending.sh ──▶ 留档里 notified=false？→ 重发 → 标记
                            幂等 / 上限 12 次 / 超 24h 不补
```

要点：

- **凭据复用 picoclaw 已配的机器人应用**（`config.json` 取 `client_id`，`.security.yml` 取 `client_secret`），
  不需要在群里新建自定义机器人，群里也不会多出一个机器人身份。
- **推送失败绝不影响任务退出码**。所有网络调用都有超时且吞掉错误，只把原因写进留档。
- **异常退出也要有交代**：`trap ... EXIT INT TERM` 兜住 `set -e`、`kill`、`exec` 超时，
  补一条 `ABORTED` 并带上死在哪一步。这条最容易漏——恰恰是「任务悄无声息地没了」的主要来源。
- **白名单**：只推真·长任务。只读的状态查询类脚本必须排除，否则用户每问一次状态
  群里就多一条通知，而且会覆盖掉上一次真实任务的留档。
- **`DRY_RUN=1` 不推也不留档**，演练不打扰群。

### 群会话 id 的坑

`openConversationId` **大小写敏感**。picoclaw 的 `sessions/*.meta.json` 里 scope 存的是
**小写别名**（`group:cidxxxx…`），拿它去调发送接口会失败。要用 gateway 日志里
原样大小写的 `"chat_id":"cid…"`。示例库里的自动发现就是从日志取的。

### 为什么兜底放 watchdog 而不是 picoclaw cron

1. 补播是纯 shell，不需要 agent；用 cron 等于每次触发多烧一个 LLM turn。
2. **gateway 崩溃/重启窗口恰恰是最需要补播的时候**，而那时 cron 根本不跑。
   本机就遇到过钉钉 SDK 连环 panic 导致 25 分钟内 6 次重启的窗口。
3. watchdog 本来就在跑（保活用），加个 sweep 零额外开销，且不依赖 gateway 存活。

## 4. 会不会被 picoclaw 更新覆盖

实测 v0.3.1 发布包解开只有 4 个平铺文件：`LICENSE / README.md / picoclaw / picoclaw-launcher`
——**不含 `bin/`，不含 workspace**。

| 操作 | 会不会覆盖 |
|------|-----------|
| `picoclaw update`（自替换二进制） | **不会**。只换二进制 |
| 下载 tarball 解压安装 | **不会**。包里没有 `bin/`，也没有 workspace 文件 |
| `picoclaw migrate --refresh` / `--workspace-only` | **会**。官方说明就是 "Re-sync workspace files"，二进制里带 `[backup] … will backup and overwrite`，会备份后覆盖 `AGENT.md` 等 |
| `picoclaw onboard` | **会**。重新初始化 workspace |
| `picoclaw config reset` | **会**。恢复出厂配置 |
| `rm -rf ~/.local/picoclaw` 后重装 | **会**。自制的 watchdog 脚本不在任何发布包里，重装即丢 |

结论：**日常升级安全，危险的是 `migrate` / `onboard` / `config reset` / 整目录重装。**
所以真正需要归档的是「不属于 picoclaw 发布物、又躺在 picoclaw 目录里」的那几个自制文件：

- `~/.local/picoclaw/bin/*-watchdog.sh`（含补播 sweep 钩子）
- `~/.picoclaw/workspace/AGENT.md`（长任务协议段落）
- `~/.picoclaw/workspace/skills/*/SKILL.md`（自写的项目 skill）

至于长任务脚本本身，请放进你项目自己的版本控制里——那才是最可靠的备份。
**只放在工作副本里改而不提交，一次 revert 就全没了。**

## 5. 安装与校验

```bash
cd docs/examples/picoclaw-job-notify

./install.sh --selftest   # 离线端到端演练：指向不可达端点，不发任何真消息
./install.sh --check      # 只读自检：凭据可取、会话 id 可解析、access_token 能拿到（不发消息）
./install.sh              # 安装到 ~/.local/picoclaw/job-notify 并自检
```

`--check` 全绿只能证明**凭据和网络**没问题。机器人**有没有发群消息的权限**必须真发一条才知道：

```bash
source ~/.local/picoclaw/job-notify/job-notify.sh
JOBNOTIFY_NAME=install-check jobnotify_push OK "通知链路自测，可忽略" 0 && echo 发送成功
```

成功时接口返回 `processQueryKey`；失败会把开放平台的错误码原样带出来
（多半是应用缺「机器人发送群消息」权限，去开发者后台加即可）。

## 6. 排障

| 现象 | 查什么 |
|------|--------|
| 任务跑完仍然没通知 | 留档文件在不在？`notified` 是 true 还是 false？`notify_error` 写了什么？ |
| `notify_error: 取 access_token 失败` | 网络/代理；注意 LaunchAgent 通常**不继承**你 shell 里的代理变量 |
| 发送返回错误码 | 应用权限（机器人发群消息）；`openConversationId` 大小写是否被小写化 |
| 补播一直 retry | 看 `notify_attempts`，到 12 次会转成 `giveup`，那时基本就是权限问题 |
| 群里收到重复通知 | 白名单里混进了只读脚本；或补播被挂到了两个定时器上 |
| 只读状态查询也发通知 | 把该脚本从 `JOBNOTIFY_JOBS` 白名单里去掉 |

留档文件长这样，排障时直接看它：

```json
{
  "job": "deploy", "status": "OK", "text": "9/9 在线，版本 v123",
  "step": "[5/5] 校验", "duration_sec": 750,
  "started_at": 0, "finished_at": 0,
  "notified": false, "notify_error": "…", "notify_attempts": 1
}
```
