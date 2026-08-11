#!/usr/bin/env bash
# install.sh — 幂等安装 job-notify 到本机，并做联通性自检。
#
#   ./install.sh                 # 安装到 ~/.local/picoclaw/job-notify 并自检
#   ./install.sh --prefix DIR    # 换安装目录
#   ./install.sh --check         # 只自检，不写任何文件
#   ./install.sh --selftest      # 离线端到端演练（指向不可达端点，不发真消息）
#
# 自检只做「取 access_token」，**不会往群里发消息**。真发验证请看末尾提示。
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${HOME}/.local/picoclaw/job-notify"
MODE="install"

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)   PREFIX="$2"; shift 2 ;;
    --check)    MODE="check";    shift ;;
    --selftest) MODE="selftest"; shift ;;
    -h|--help)  sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

ok()   { echo "  ✓ $*"; }
bad()  { echo "  ✗ $*" >&2; }
info() { echo "· $*"; }

# ── 依赖 ────────────────────────────────────────────────────────────────────
info "检查依赖"
rc=0
for c in bash curl jq; do
  if command -v "$c" >/dev/null 2>&1; then ok "$c"; else bad "缺少 $c"; rc=1; fi
done
[ "$rc" = 0 ] || exit 1

# ── 安装 ────────────────────────────────────────────────────────────────────
if [ "${MODE}" = "install" ]; then
  info "安装到 ${PREFIX}"
  mkdir -p "${PREFIX}"
  for f in job-notify.sh notify-pending.sh; do
    if [ -f "${PREFIX}/${f}" ] && ! cmp -s "${SELF_DIR}/${f}" "${PREFIX}/${f}"; then
      cp -p "${PREFIX}/${f}" "${PREFIX}/${f}.bak.$(date +%Y%m%d%H%M%S)"
      ok "已备份旧 ${f}"
    fi
    cp -p "${SELF_DIR}/${f}" "${PREFIX}/${f}"
    chmod +x "${PREFIX}/${f}"
    ok "${f}"
  done
fi

# ── 离线端到端演练 ──────────────────────────────────────────────────────────
if [ "${MODE}" = "selftest" ]; then
  info "离线演练（指向不可达端点，不会发真消息）"
  T="$(mktemp -t jobnotify_selftest.XXXXXX)"
  (
    export JOBNOTIFY_STATE_FILE="$T"
    export DINGTALK_API_BASE="http://127.0.0.1:9"   # discard 端口，必然失败
    export JOBNOTIFY_RETRY=1
    # shellcheck disable=SC1091
    source "${SELF_DIR}/job-notify.sh"
    jobnotify_begin "selftest"
    jobnotify_step "[1/1] 演练"
    jobnotify_finish "OK" "演练结果"
  ) >/dev/null 2>&1 || true
  if [ -s "$T" ] && jq -e '.status=="OK" and .notified==false and .notify_attempts==1' "$T" >/dev/null 2>&1; then
    ok "留档链路正常（status=OK, notified=false, attempts=1）"
  else
    bad "留档链路异常：$(cat "$T" 2>/dev/null | head -c 300)"; rm -f "$T"; exit 1
  fi
  out="$(JOBNOTIFY_STATE_FILE="$T" DINGTALK_API_BASE=http://127.0.0.1:9 JOBNOTIFY_RETRY=1 \
         "${SELF_DIR}/notify-pending.sh" 2>&1 | tail -1)"
  case "$out" in
    "PENDING: retry"*) ok "补播链路正常（${out}）" ;;
    *) bad "补播链路异常：${out}"; rm -f "$T"; exit 1 ;;
  esac
  rm -f "$T"
  echo
  ok "离线演练全部通过"
  exit 0
fi

# ── 联通性自检（不发消息）───────────────────────────────────────────────────
info "自检 picoclaw 凭据与目标会话"
# shellcheck disable=SC1091
source "${SELF_DIR}/job-notify.sh"

id="$(jobnotify_client_id     || true)"
sec="$(jobnotify_client_secret || true)"
conv="$(jobnotify_conversation_id || true)"

[ -n "${id}" ]   && ok "client_id     取到（len=${#id}）"        || { bad "client_id 取不到：确认 ${PICOCLAW_CONFIG_JSON} 里 channel_list.dingtalk.settings.client_id"; rc=1; }
[ -n "${sec}" ]  && ok "client_secret 取到（len=${#sec}）"       || { bad "client_secret 取不到：确认 ${PICOCLAW_SECURITY_YML} 里 channel_list.dingtalk.settings.client_secret"; rc=1; }
if [ -n "${conv}" ]; then
  ok "目标会话 id 已解析（${#conv} 字符）"
else
  bad "目标会话 id 取不到：设 DINGTALK_OPEN_CONVERSATION_ID，或确认 gateway 日志里有群消息记录"
  rc=1
fi

if [ -n "${id}" ] && [ -n "${sec}" ]; then
  tok="$(jobnotify_access_token "${id}" "${sec}")"
  [ -n "${tok}" ] && ok "access_token 获取成功（未发送任何消息）" || { bad "access_token 获取失败：检查网络/代理与应用凭据"; rc=1; }
fi

echo
if [ "$rc" = 0 ]; then
  ok "自检通过"
else
  bad "自检未全通过，先按上面提示修"
fi

cat <<EOF

下一步（手动）：

1) 在你的长任务脚本里接上：
     source ${PREFIX}/job-notify.sh
     jobnotify_begin "deploy"
     ...
     jobnotify_ok "结论一句话"

2) 把补播挂到已有的定时器（例如 watchdog，StartInterval=300）末尾：

     NOTIFY_PENDING_SH="${PREFIX}/notify-pending.sh"
     notify_pending_sweep() {
       [ -x "\$NOTIFY_PENDING_SH" ] || return 0
       local out; out="\$("\$NOTIFY_PENDING_SH" 2>&1 | tail -1)"
       case "\$out" in
         ""|*"PENDING: none"*) : ;;          # 无事可做，不刷日志
         *) log "NOTIFY \$out" ;;
       esac
     }
     # 在主流程末尾调用： notify_pending_sweep

3) 真发验证（会往群里发一条消息，确认机器人有「发群消息」权限）：
     source ${PREFIX}/job-notify.sh
     JOBNOTIFY_NAME=install-check jobnotify_push OK "通知链路自测，可忽略" 0 && echo 发送成功

排障与设计取舍见 docs/picoclaw-long-job-notify.md
EOF
