#!/usr/bin/env bash
# Install GSD global runtime + ensure yiui-gsd project wiring after checkout.
# Run from anywhere; resolves lodestar root from this script path.
set -euo pipefail

CHANNEL="latest"
SKIP_CORE=0
INIT_GSD=0
SKIP_AGENT_POLICY=0
YES=0
EXTRA_PROJECT=""

usage() {
  cat <<'EOF'
Usage: install/yiui-gsd/install.sh [options]

  --channel latest|next   GSD core dist-tag (default: latest)
  --skip-core             Skip npx @opengsd/gsd-core install
  --init-gsd              Init .gsd local task repo in lodestar root
  --apply-agent-policy    Accepted for compatibility; policy is applied by default
  --skip-agent-policy     Skip Codex agent policy apply/verify
  --project <path>        Also wire yiui-gsd into another project
  --yes, -y               Non-interactive
  -h, --help              Show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel)
      CHANNEL="${2:-}"
      shift 2
      ;;
    --skip-core) SKIP_CORE=1; shift ;;
    --init-gsd) INIT_GSD=1; shift ;;
    --apply-agent-policy) shift ;;
    --skip-agent-policy) SKIP_AGENT_POLICY=1; shift ;;
    --project)
      EXTRA_PROJECT="${2:-}"
      shift 2
      ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$CHANNEL" != "latest" && "$CHANNEL" != "next" ]]; then
  echo "error: --channel must be latest or next" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SKILL_SRC="$ROOT/.agents/skills/yiui-gsd"
CLAUDE_MD_SRC="$ROOT/.claude/CLAUDE.md"

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

wire_project() {
  local project="$1"
  local skill_dst="$project/.agents/skills/yiui-gsd"
  local claude_skill="$project/.claude/skills/yiui-gsd"
  local claude_md="$project/.claude/CLAUDE.md"

  [[ -d "$project" ]] || die "project path not found: $project"
  mkdir -p "$project/.agents/skills" "$project/.claude/skills"

  if [[ "$project" == "$ROOT" ]]; then
    [[ -f "$SKILL_SRC/SKILL.md" ]] || die "missing skill at $SKILL_SRC"
  else
    if [[ -e "$skill_dst" && ! -L "$skill_dst" ]]; then
      log "project skill exists (not link): $skill_dst (leave as-is)"
    else
      # Relative link when possible so the target project stays relocatable.
      local rel
      if rel=$(node -e 'const fs = require("node:fs"); const path = require("node:path"); const target = fs.realpathSync(process.argv[1]); const from = fs.realpathSync(process.argv[2]); process.stdout.write(path.relative(from, target) || ".")' "$SKILL_SRC" "$project/.agents/skills" 2>/dev/null); then
        ln -sfn "$rel" "$skill_dst"
      else
        ln -sfn "$SKILL_SRC" "$skill_dst"
      fi
      log "linked project skill -> $skill_dst"
    fi
  fi

  if [[ -e "$claude_skill" || -L "$claude_skill" ]]; then
    log "claude skill entry ok: $claude_skill"
  else
    ln -sfn ../../.agents/skills/yiui-gsd "$claude_skill"
    log "created claude skill symlink: $claude_skill"
  fi

  if [[ ! -f "$claude_md" ]]; then
    mkdir -p "$(dirname "$claude_md")"
    if [[ -f "$CLAUDE_MD_SRC" ]]; then
      cp "$CLAUDE_MD_SRC" "$claude_md"
    else
      cat >"$claude_md" <<'EOF'
# Project rules (Claude)

## GSD / 长任务规划
- 多阶段、长任务、需要 TRACKER/阶段推进时，**必须**使用项目 skill `yiui-gsd`（路径 `.agents/skills/yiui-gsd`，Claude 入口 `.claude/skills/yiui-gsd`）。
- 任何 GSD 操作前先读 `.gsd/TRACKER.md`；目标任务 STATE 位于 `.gsd/<slug>/.planning/STATE.md`，底层命令显式带 `--ws <slug>`。
- 根 `.planning/` 是稳定 workstream 路由目录；当前会话选择不写入 TRACKER，也不暂停其他运行中任务。
- **禁止**使用 superpowers / oh-my-claudecode(OMC) / ralplan / ralph / ultrawork / “plan this” 作为规划入口。
EOF
    fi
    log "wrote $claude_md"
  else
    log "claude rules present: $claude_md"
  fi
}

install_core() {
  need_cmd npx
  local tag="$CHANNEL"
  log "installing @opengsd/gsd-core@$tag --codex --global"
  # Installer writes ~/.codex/gsd-core, ~/.agents/skills/gsd-*, ~/.codex/agents/gsd-*
  npx --yes "@opengsd/gsd-core@${tag}" --codex --global
}

init_gsd_repo() {
  local helper="$SKILL_SRC/scripts/yiui-gsd.mjs"
  [[ -f "$helper" ]] || die "missing $helper"
  node "$helper" init-gsd-repo --project-root "$ROOT"
}

apply_policy() {
  local helper="$SKILL_SRC/scripts/yiui-gsd.mjs"
  [[ -f "$helper" ]] || die "missing $helper"
  node "$helper" apply-agent-policy
  node "$helper" apply-agent-policy --verify-only
}

[[ -f "$SKILL_SRC/SKILL.md" ]] || die "not a lodestar checkout? missing $SKILL_SRC/SKILL.md"
need_cmd node
log "lodestar root: $ROOT"

wire_project "$ROOT"

if [[ -n "$EXTRA_PROJECT" ]]; then
  EXTRA_PROJECT="$(cd "$EXTRA_PROJECT" && pwd)"
  log "wiring extra project: $EXTRA_PROJECT"
  wire_project "$EXTRA_PROJECT"
fi

if [[ "$SKIP_CORE" -eq 0 ]]; then
  if [[ -f "$HOME/.codex/gsd-core/VERSION" && "$YES" -eq 0 ]]; then
    cur="$(tr -d '[:space:]' <"$HOME/.codex/gsd-core/VERSION" || true)"
    log "existing GSD core VERSION=$cur (channel=$CHANNEL)"
    printf 'Re-run installer for channel %s? [Y/n] ' "$CHANNEL"
    read -r ans || ans=Y
    case "${ans:-Y}" in
      n|N|no|NO) log "skip core reinstall" ;;
      *) install_core ;;
    esac
  else
    install_core
  fi
else
  log "skip-core: not installing @opengsd/gsd-core"
fi

if [[ "$INIT_GSD" -eq 1 ]]; then
  init_gsd_repo
fi

if [[ "$SKIP_AGENT_POLICY" -eq 0 ]]; then
  apply_policy
else
  log "skip-agent-policy: not applying Codex agent policy"
fi

log "running verify"
bash "$SCRIPT_DIR/verify.sh" --root "$ROOT"

log "done. Next: bun install && bun run build (for Lodestar daemon); use group command 'gsd' after daemon restart."
