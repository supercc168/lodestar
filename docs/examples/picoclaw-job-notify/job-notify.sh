#!/usr/bin/env bash
# job-notify.sh — 让 picoclaw 的后台长任务在跑完时主动把结论推回 IM 群。
#
# 解决的问题：picoclaw 的 `exec` 工具带 background=true 时**没有完成回调**，
# gateway 也**没有消息注入端点**（只有 /health /ready /reload）。于是长任务跑完
# 没人吭声，用户不主动问就永远收不到结论；等他问的时候，脚本早已退出、
# 后台 session 也已失效（exec poll 会报 "session not found"），只能翻日志反推。
#
# 做法：绕开 picoclaw 进程，在脚本收尾处直接调 IM 开放平台 API 推送，
# 同时把最终结果留档到 JOBNOTIFY_STATE_FILE。推送失败不影响任务退出码，
# 留档里 notified=false，交给 notify-pending.sh 补播。
#
# 凭据复用 picoclaw 已配好的机器人应用，不需要新建自定义机器人。
#
# 用法（被 source，勿直接执行）：
#
#   source /path/to/job-notify.sh
#   jobnotify_begin "deploy"          # 记开始时间 + 装异常退出兜底
#   jobnotify_step  "[2/5] 上传"      # 可选，异常中断时会报出死在哪一步
#   ...
#   jobnotify_ok   "9/9 在线，版本 v123"   # 推 ✅ 并 exit 0
#   jobnotify_fail "第 3 台上传超时"        # 推 ❌ 并 exit 1
#
# 若宿主脚本已有自己的 trap，请改为链式调用，不要覆盖掉 jobnotify_exit_trap：
#   trap 'jobnotify_exit_trap; my_cleanup' EXIT INT TERM
#
# 依赖：bash 3.2+ / curl / jq。macOS 自带 bash 3.2 可用。

# ── 可调项（都可用环境变量覆盖）─────────────────────────────────────────────
JOBNOTIFY_STATE_FILE="${JOBNOTIFY_STATE_FILE:-/tmp/picoclaw_job_last_result.json}"
# 只推这些任务名（空格分隔）。留空 = 全推。
# 强烈建议把只读的状态查询类任务排除在外，否则用户每问一次状态群里就多一条通知，
# 而且会覆盖掉上一次真实长任务的留档。
JOBNOTIFY_JOBS="${JOBNOTIFY_JOBS:-}"
JOBNOTIFY_ENABLED="${JOBNOTIFY_ENABLED:-1}"
JOBNOTIFY_RETRY="${JOBNOTIFY_RETRY:-3}"

PICOCLAW_HOME="${PICOCLAW_HOME:-$HOME/.picoclaw}"
PICOCLAW_CONFIG_JSON="${PICOCLAW_CONFIG_JSON:-$PICOCLAW_HOME/config.json}"
PICOCLAW_SECURITY_YML="${PICOCLAW_SECURITY_YML:-$PICOCLAW_HOME/.security.yml}"
PICOCLAW_GATEWAY_LOG="${PICOCLAW_GATEWAY_LOG:-$PICOCLAW_HOME/logs/gateway.log}"

DINGTALK_API_BASE="${DINGTALK_API_BASE:-https://api.dingtalk.com}"
# 目标群的 openConversationId。留空则从 gateway 日志里自动取最近一次群会话 id。
DINGTALK_OPEN_CONVERSATION_ID="${DINGTALK_OPEN_CONVERSATION_ID:-}"

# ── 内部状态 ────────────────────────────────────────────────────────────────
JOBNOTIFY_NAME=""
JOBNOTIFY_STARTED=0
JOBNOTIFY_STEP=""
JOBNOTIFY_DONE=0
JOBNOTIFY_ERROR=""

jobnotify_enabled() {
  [ -n "${JOBNOTIFY_NAME}" ] || return 1
  [ "${JOBNOTIFY_ENABLED}" = "1" ] || return 1
  [ "${DRY_RUN:-0}" = "1" ] && return 1     # 演练不该往群里发东西
  [ -n "${JOBNOTIFY_JOBS}" ] || return 0
  case " ${JOBNOTIFY_JOBS} " in *" ${JOBNOTIFY_NAME} "*) return 0 ;; *) return 1 ;; esac
}

jobnotify_fmt_dur() { # seconds -> 1h02m / 12m30s / 45s
  local s="${1:-0}"
  if   [ "${s}" -ge 3600 ]; then printf '%dh%02dm' $((s/3600)) $(((s%3600)/60))
  elif [ "${s}" -ge 60 ];   then printf '%dm%02ds' $((s/60)) $((s%60))
  else                           printf '%ds' "${s}"; fi
}

# ── 凭据（复用 picoclaw 已配的机器人应用）────────────────────────────────────
jobnotify_client_id() {
  [ -f "${PICOCLAW_CONFIG_JSON}" ] || return 1
  jq -r '.channel_list.dingtalk.settings.client_id // empty' "${PICOCLAW_CONFIG_JSON}" 2>/dev/null
}

# .security.yml 里 dingtalk 块下的 client_secret。按缩进定界，避免误取到别的通道的密钥。
jobnotify_client_secret() {
  [ -f "${PICOCLAW_SECURITY_YML}" ] || return 1
  awk '
    !inblk && /^[[:space:]]*dingtalk:[[:space:]]*$/ { p=match($0,/[^[:space:]]/)-1; inblk=1; next }
    inblk {
      if ($0 ~ /^[[:space:]]*$/) next
      i=match($0,/[^[:space:]]/)-1
      if (i<=p) { inblk=0; next }
      if ($0 ~ /^[[:space:]]*client_secret:[[:space:]]*/) {
        sub(/^[[:space:]]*client_secret:[[:space:]]*/,"")
        gsub(/^["\047]|["\047]$/,"")
        print; exit
      }
    }
  ' "${PICOCLAW_SECURITY_YML}" 2>/dev/null
}

# 群会话 id 大小写敏感。注意：sessions/*.meta.json 里的 scope 值是**小写别名**，
# 拿它去发送会失败，必须用 gateway 日志里原样大小写的 chat_id。
jobnotify_conversation_id() {
  if [ -n "${DINGTALK_OPEN_CONVERSATION_ID}" ]; then
    printf '%s' "${DINGTALK_OPEN_CONVERSATION_ID}"; return 0
  fi
  [ -f "${PICOCLAW_GATEWAY_LOG}" ] || return 1
  grep -o '"chat_id":"cid[^"]*"' "${PICOCLAW_GATEWAY_LOG}" 2>/dev/null \
    | tail -1 | sed 's/.*"chat_id":"//; s/"$//'
}

jobnotify_access_token() { # client_id client_secret
  local resp
  resp="$(curl -sS --max-time 15 -X POST "${DINGTALK_API_BASE}/v1.0/oauth2/accessToken" \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg k "$1" --arg s "$2" '{appKey:$k,appSecret:$s}')" 2>/dev/null || true)"
  printf '%s' "${resp}" | jq -r '.accessToken // empty' 2>/dev/null || true
}

jobnotify_send() { # token robot_code conv_id title text -> 0 成功
  local token="$1" robot="$2" conv="$3" title="$4" text="$5"
  local inner body resp
  inner="$(jq -nc --arg t "${title}" --arg x "${text}" '{title:$t,text:$x}')"
  # msgParam 必须是「内含 JSON 的字符串」，不是对象
  body="$(jq -nc --arg rc "${robot}" --arg cid "${conv}" --arg mp "${inner}" \
    '{robotCode:$rc,openConversationId:$cid,msgKey:"sampleMarkdown",msgParam:$mp}')"
  resp="$(curl -sS --max-time 20 -X POST "${DINGTALK_API_BASE}/v1.0/robot/groupMessages/send" \
    -H "x-acs-dingtalk-access-token: ${token}" -H 'Content-Type: application/json' \
    -d "${body}" 2>/dev/null || true)"
  if printf '%s' "${resp}" | jq -e '.processQueryKey // empty' >/dev/null 2>&1; then
    return 0
  fi
  # 只保留错误码/消息，绝不回显凭据
  JOBNOTIFY_ERROR="$(printf '%s' "${resp}" | jq -r '[(.code//""),(.message//"")]|join(" ")' 2>/dev/null || echo 'send failed')"
  [ -n "${JOBNOTIFY_ERROR}" ] || JOBNOTIFY_ERROR="send failed(empty response)"
  return 1
}

# 推一条完成通知。失败只置 JOBNOTIFY_ERROR，绝不影响宿主脚本退出码。
jobnotify_push() { # status text [duration_sec] [finished_epoch]
  local status="$1" text="$2" dur="${3:-0}" fin="${4:-}"
  local id secret conv token icon title msg when attempt=0
  JOBNOTIFY_ERROR=""
  command -v jq   >/dev/null 2>&1 || { JOBNOTIFY_ERROR="缺少 jq";   return 1; }
  command -v curl >/dev/null 2>&1 || { JOBNOTIFY_ERROR="缺少 curl"; return 1; }
  id="$(jobnotify_client_id || true)"
  secret="$(jobnotify_client_secret || true)"
  conv="$(jobnotify_conversation_id || true)"
  if [ -z "${id}" ] || [ -z "${secret}" ] || [ -z "${conv}" ]; then
    JOBNOTIFY_ERROR="凭据/会话缺失 id=${id:+y}${id:-n} secret=${secret:+y}${secret:-n} conv=${conv:+y}${conv:-n}"
    return 1
  fi
  case "${status}" in
    OK)      icon="✅"; title="${JOBNOTIFY_NAME} 完成" ;;
    FAIL)    icon="❌"; title="${JOBNOTIFY_NAME} 失败" ;;
    ABORTED) icon="⚠️"; title="${JOBNOTIFY_NAME} 异常中断" ;;
    *)       icon="ℹ️"; title="${JOBNOTIFY_NAME} ${status}" ;;
  esac
  # 补播时显示任务真实完成时间，而不是重发时间
  if [ -n "${fin}" ] && [ "${fin}" != "0" ]; then
    when="$(date -r "${fin}" '+%m-%d %H:%M' 2>/dev/null || date '+%m-%d %H:%M')"
  else
    when="$(date '+%m-%d %H:%M')"
  fi
  msg="### ${icon} ${title}
- 结果：${text}
- 耗时：$(jobnotify_fmt_dur "${dur}")
- 完成：${when}

RESULT: ${status} ${text}"
  while [ "${attempt}" -lt "${JOBNOTIFY_RETRY}" ]; do
    attempt=$((attempt+1))
    token="$(jobnotify_access_token "${id}" "${secret}")"
    if [ -n "${token}" ] && jobnotify_send "${token}" "${id}" "${conv}" "${title}" "${msg}"; then
      return 0
    fi
    [ -n "${token}" ] || JOBNOTIFY_ERROR="取 access_token 失败"
    if [ "${attempt}" -lt "${JOBNOTIFY_RETRY}" ]; then sleep 3; fi
  done
  return 1
}

# ── 留档（推送失败时的唯一凭据，也是「用户回头问」时的秒答来源）──────────────
jobnotify_record() { # status text
  local status="$1" text="$2" now dur
  command -v jq >/dev/null 2>&1 || return 0
  now="$(date +%s)"
  dur=$(( now - ${JOBNOTIFY_STARTED:-$now} ))
  jq -nc \
    --arg job "${JOBNOTIFY_NAME:-unknown}" --arg cmd "${0##*/}" \
    --arg status "${status}" --arg text "${text}" --arg step "${JOBNOTIFY_STEP:-}" \
    --argjson pid "$$" --argjson started "${JOBNOTIFY_STARTED:-$now}" \
    --argjson finished "${now}" --argjson dur "${dur}" \
    --arg host "$(hostname -s 2>/dev/null || echo '?')" \
    '{job:$job,cmd:$cmd,status:$status,text:$text,step:$step,pid:$pid,
      started_at:$started,finished_at:$finished,duration_sec:$dur,host:$host,
      notified:false,notify_error:"",notified_at:0,notify_attempts:0}' \
    > "${JOBNOTIFY_STATE_FILE}.tmp.$$" 2>/dev/null \
    && mv -f "${JOBNOTIFY_STATE_FILE}.tmp.$$" "${JOBNOTIFY_STATE_FILE}" 2>/dev/null \
    || true
}

jobnotify_mark() { # ok|fail
  local ok="${1:-ok}" now
  [ -f "${JOBNOTIFY_STATE_FILE}" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  now="$(date +%s)"
  # 失败时累加尝试次数，供补播设上限（避免权限缺失导致无限重试）
  jq --argjson n "$([ "${ok}" = ok ] && echo true || echo false)" \
     --argjson at "${now}" --arg err "${JOBNOTIFY_ERROR:-}" \
     '.notified=$n | .notified_at=$at | .notify_error=$err
      | .notify_attempts=((.notify_attempts//0) + (if $n then 0 else 1 end))' \
     "${JOBNOTIFY_STATE_FILE}" > "${JOBNOTIFY_STATE_FILE}.tmp.$$" 2>/dev/null \
    && mv -f "${JOBNOTIFY_STATE_FILE}.tmp.$$" "${JOBNOTIFY_STATE_FILE}" 2>/dev/null \
    || true
}

# ── 对外 API ────────────────────────────────────────────────────────────────
jobnotify_begin() { # name [step]
  JOBNOTIFY_NAME="${1:-job}"
  JOBNOTIFY_STARTED="$(date +%s)"
  JOBNOTIFY_STEP="${2:-starting}"
  JOBNOTIFY_DONE=0
  trap 'jobnotify_exit_trap' EXIT INT TERM
}

jobnotify_step() { JOBNOTIFY_STEP="$*"; }

jobnotify_finish() { # status text
  local status="$1"; shift
  local text="$*" now dur
  jobnotify_enabled || return 0
  JOBNOTIFY_DONE=1
  jobnotify_record "${status}" "${text}"
  now="$(date +%s)"; dur=$(( now - ${JOBNOTIFY_STARTED:-$now} ))
  if jobnotify_push "${status}" "${text}" "${dur}" "${now}"; then
    jobnotify_mark ok
  else
    jobnotify_mark fail
    echo "⚠ IM 通知失败（已留档，补播会重试）：${JOBNOTIFY_ERROR:-unknown}" >&2
  fi
}

# 异常退出（set -e / kill / exec 超时）也要有交代，否则又变回静默
jobnotify_exit_trap() {
  local rc=$?
  if [ "${JOBNOTIFY_DONE:-0}" = "0" ]; then
    jobnotify_finish "ABORTED" "脚本异常退出 rc=${rc} step=${JOBNOTIFY_STEP:-?}" || true
  fi
}

jobnotify_ok()   { jobnotify_finish "OK"   "$*"; echo "RESULT: OK $*";        exit 0; }
jobnotify_fail() { jobnotify_finish "FAIL" "$*"; echo "RESULT: FAIL $*" >&2;  exit 1; }
