#!/usr/bin/env bash
# notify-pending.sh — 补播：把留档里 notified=false 的任务结果重发到 IM 群。
#
# 为什么需要：脚本收尾时的直发可能失败（断网、DNS 解析不到开放平台域名、IM 抖动）。
# 失败时结果已留档但 notified=false，本脚本负责稍后补上，避免又变成静默。
#
# 宿主：建议挂在**已有的 watchdog / LaunchAgent 定时器**上（例如 StartInterval=300），
# 而不是 picoclaw 自带的 cron。理由见 docs/picoclaw-long-job-notify.md：
#   1) 纯 shell 补播不需要 agent，picoclaw cron 只能投递「给 agent 的消息」＝每 tick 烧一个 LLM turn；
#   2) gateway 崩溃/重启窗口恰恰是最需要补播的时候，而那时 picoclaw cron 根本不跑。
#
# 幂等：发送成功即置 notified=true，重复调用不会重复播。
# 上限：连续失败 NOTIFY_MAX_ATTEMPTS 次后放弃（防权限缺失导致无限重试）。
# 时效：超过 NOTIFY_MAX_AGE_SEC 的旧结果不再补播，避免重启后翻旧账。
#
# 输出约定（供宿主过滤日志）：
#   PENDING: none …    无事可做
#   PENDING: sent …    补播成功
#   PENDING: retry …   本次失败，下次再试
#   PENDING: giveup …  超过上限，需人工排查机器人权限
#   PENDING: stale …   结果太旧，放弃
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SELF_DIR}/job-notify.sh"

NOTIFY_MAX_ATTEMPTS="${NOTIFY_MAX_ATTEMPTS:-12}"
NOTIFY_MAX_AGE_SEC="${NOTIFY_MAX_AGE_SEC:-86400}"

command -v jq >/dev/null 2>&1 || { echo "PENDING: none 缺少 jq"; exit 0; }
[ -f "${JOBNOTIFY_STATE_FILE}" ] || { echo "PENDING: none 无留档"; exit 0; }

notified="$(jq -r '.notified // false'    "${JOBNOTIFY_STATE_FILE}" 2>/dev/null || echo true)"
[ "${notified}" = "false" ] || { echo "PENDING: none 已通知"; exit 0; }

attempts="$(jq -r '.notify_attempts // 0' "${JOBNOTIFY_STATE_FILE}" 2>/dev/null || echo 0)"
if [ "${attempts}" -ge "${NOTIFY_MAX_ATTEMPTS}" ]; then
  echo "PENDING: giveup 已尝试 ${attempts} 次，放弃（排查机器人发群消息权限）"
  exit 0
fi

fin="$(jq -r '.finished_at // 0' "${JOBNOTIFY_STATE_FILE}" 2>/dev/null || echo 0)"
now="$(date +%s)"
if [ "${fin}" -gt 0 ] && [ $(( now - fin )) -gt "${NOTIFY_MAX_AGE_SEC}" ]; then
  echo "PENDING: stale 结果已超 ${NOTIFY_MAX_AGE_SEC}s，不再补播"
  exit 0
fi

# jobnotify_push 用 JOBNOTIFY_NAME 拼标题，这里从留档还原
JOBNOTIFY_NAME="$(jq -r '.job // "job"'    "${JOBNOTIFY_STATE_FILE}" 2>/dev/null || echo job)"
status="$(jq -r '.status // "OK"'          "${JOBNOTIFY_STATE_FILE}" 2>/dev/null || echo OK)"
text="$(jq -r '.text // ""'                "${JOBNOTIFY_STATE_FILE}" 2>/dev/null || echo '')"
dur="$(jq -r '.duration_sec // 0'          "${JOBNOTIFY_STATE_FILE}" 2>/dev/null || echo 0)"

if jobnotify_push "${status}" "${text}" "${dur}" "${fin}"; then
  jobnotify_mark ok
  echo "PENDING: sent 补播成功 job=${JOBNOTIFY_NAME} status=${status}"
  exit 0
fi

jobnotify_mark fail
echo "PENDING: retry 补播失败（第 $((attempts+1)) 次）：${JOBNOTIFY_ERROR:-unknown}"
exit 0
