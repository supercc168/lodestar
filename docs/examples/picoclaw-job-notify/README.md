# picoclaw-job-notify

让 picoclaw 的后台长任务在**跑完时主动把结论推回 IM 群**，而不是等用户开口问。

背景、设计取舍与排障见 [`../../picoclaw-long-job-notify.md`](../../picoclaw-long-job-notify.md)。
一句话版：picoclaw 对 `exec background=true` 没有完成回调，gateway 也没有消息注入端点，
所以只能由脚本自己在收尾处直调 IM 开放平台 API。

## 文件

| 文件 | 作用 |
|------|------|
| `job-notify.sh` | 可 `source` 的库：留档 + 推送 + 异常退出兜底 |
| `notify-pending.sh` | 补播：把留档里 `notified=false` 的结果重发；幂等、有重试上限 |
| `install.sh` | 幂等安装 + 自检（`--check` 只读自检，`--selftest` 离线演练） |

## 最小用法

```bash
source /path/to/job-notify.sh

jobnotify_begin "deploy"           # 记开始时间 + 装 EXIT/INT/TERM 兜底
jobnotify_step  "[1/3] 构建"
...
jobnotify_step  "[3/3] 校验"
jobnotify_ok    "9/9 在线，版本 v123"    # 推 ✅ 并 exit 0
# 失败路径： jobnotify_fail "第 3 台上传超时"   # 推 ❌ 并 exit 1
```

中途被 `kill`、被 `set -e` 打断、或被 `exec` 超时杀掉，`jobnotify_exit_trap`
会补一条 `⚠️ 异常中断`，并带上死在哪一步——这条最容易漏，也正是「任务悄无声息没了」的主因。

宿主脚本若已有自己的 trap，改成链式，别覆盖掉：

```bash
trap 'jobnotify_exit_trap; my_cleanup' EXIT INT TERM
```

## 常用环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `JOBNOTIFY_STATE_FILE` | `/tmp/picoclaw_job_last_result.json` | 结果留档路径 |
| `JOBNOTIFY_JOBS` | 空（全推） | 白名单，空格分隔。**务必把只读的状态查询脚本排除**，否则用户每问一次状态群里就多一条通知，还会覆盖上次真实任务的留档 |
| `JOBNOTIFY_ENABLED` | `1` | 设 `0` 整体关推送（仍留档） |
| `DINGTALK_OPEN_CONVERSATION_ID` | 空 | 目标群。留空则从 gateway 日志自动发现（**大小写敏感**，别用 sessions meta 里的小写别名） |
| `DINGTALK_API_BASE` | 开放平台域名 | 指向不可达地址即可做离线演练 |
| `DRY_RUN` | `0` | 设 `1` 时不推也不留档 |

## 补播挂哪里

挂到**已有的定时器**（如保活 watchdog，`StartInterval=300`）末尾，别用 picoclaw 自带 cron
——cron 只能投递「给 agent 的消息」，每次触发烧一个 LLM turn，而且 gateway 崩溃时不跑，
那恰恰是最需要补播的窗口。

```bash
NOTIFY_PENDING_SH="$HOME/.local/picoclaw/job-notify/notify-pending.sh"
notify_pending_sweep() {
  [ -x "$NOTIFY_PENDING_SH" ] || return 0
  local out; out="$("$NOTIFY_PENDING_SH" 2>&1 | tail -1)"
  case "$out" in
    ""|*"PENDING: none"*) : ;;      # 无事可做，不刷日志
    *) log "NOTIFY $out" ;;
  esac
}
```

## 验证

```bash
./install.sh --selftest   # 离线端到端，不发真消息
./install.sh --check      # 凭据/会话/token 自检，不发真消息
```

两个都过**只能说明凭据和网络没问题**。机器人有没有「发群消息」权限，必须真发一条才知道：

```bash
source job-notify.sh
JOBNOTIFY_NAME=install-check jobnotify_push OK "通知链路自测，可忽略" 0 && echo 发送成功
```

## 依赖

`bash` 3.2+（macOS 自带即可）、`curl`、`jq`。
