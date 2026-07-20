#!/usr/bin/env bash
# Verify yiui-gsd + GSD global runtime after install / checkout.
set -euo pipefail

ROOT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    -h|--help)
      echo "Usage: verify.sh [--root <lodestar-root>]"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "$ROOT" ]]; then
  ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi

FAIL=0
ok() { printf '  [ok] %s\n' "$*"; }
bad() { printf '  [FAIL] %s\n' "$*"; FAIL=1; }

echo "verify yiui-gsd @ $ROOT"

# Project skill
if [[ -f "$ROOT/.agents/skills/yiui-gsd/SKILL.md" ]]; then
  ok "project skill .agents/skills/yiui-gsd/SKILL.md"
else
  bad "missing .agents/skills/yiui-gsd/SKILL.md"
fi

# Claude skill entry
claude_skill="$ROOT/.claude/skills/yiui-gsd"
if [[ -e "$claude_skill" ]]; then
  if [[ -f "$claude_skill/SKILL.md" || -f "$claude_skill" ]]; then
    ok "claude skill entry resolves: .claude/skills/yiui-gsd"
  else
    # symlink to directory
    if [[ -L "$claude_skill" && -d "$claude_skill" && -f "$claude_skill/SKILL.md" ]]; then
      ok "claude skill symlink -> $(readlink "$claude_skill")"
    else
      bad "claude skill entry present but SKILL.md not readable: $claude_skill"
    fi
  fi
else
  bad "missing .claude/skills/yiui-gsd"
fi

if [[ -f "$ROOT/.claude/CLAUDE.md" ]] && grep -q 'yiui-gsd' "$ROOT/.claude/CLAUDE.md"; then
  ok ".claude/CLAUDE.md pins yiui-gsd"
else
  bad ".claude/CLAUDE.md missing or does not mention yiui-gsd"
fi

# Must not vendor official gsd-* into project
if compgen -G "$ROOT/.agents/skills/gsd-*" >/dev/null 2>&1; then
  bad "project .agents/skills has official gsd-* copies (should only keep yiui-gsd)"
else
  ok "no official gsd-* under project .agents/skills"
fi

# Global core
if [[ -f "$HOME/.codex/gsd-core/VERSION" ]]; then
  ver="$(tr -d '[:space:]' <"$HOME/.codex/gsd-core/VERSION")"
  ok "GSD core VERSION=$ver ($HOME/.codex/gsd-core)"
else
  bad "missing $HOME/.codex/gsd-core/VERSION (run install.sh)"
fi

# Global skills
skill_count=0
if [[ -d "$HOME/.agents/skills" ]]; then
  skill_count="$(find "$HOME/.agents/skills" -maxdepth 1 -type d -name 'gsd-*' 2>/dev/null | wc -l | tr -d ' ')"
fi
if [[ "${skill_count:-0}" -ge 5 ]]; then
  ok "global gsd-* skills count=$skill_count"
else
  bad "global gsd-* skills too few (count=${skill_count:-0}); expected install under ~/.agents/skills"
fi

# Codex agents
agent_count=0
if [[ -d "$HOME/.codex/agents" ]]; then
  agent_count="$(find "$HOME/.codex/agents" -maxdepth 1 \( -name 'gsd-*.toml' -o -name 'gsd-*.md' \) 2>/dev/null | wc -l | tr -d ' ')"
fi
if [[ "${agent_count:-0}" -ge 5 ]]; then
  ok "codex gsd-* agents count=$agent_count"
else
  bad "codex gsd-* agents too few (count=${agent_count:-0}); expected under ~/.codex/agents"
fi

# Optional .gsd
if [[ -d "$ROOT/.gsd/.git" ]]; then
  ok ".gsd local git present"
elif [[ -d "$ROOT/.gsd" ]]; then
  ok ".gsd present (no .git yet — run install --init-gsd)"
else
  ok ".gsd not initialized (optional; use --init-gsd or first GSD task)"
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo "verify FAILED"
  exit 1
fi
echo "verify OK"
