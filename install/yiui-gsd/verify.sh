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
else
  ROOT="$(cd "$ROOT" && pwd)"
fi

command -v node >/dev/null 2>&1 || {
  echo "error: Node.js >= 18 is required" >&2
  exit 1
}

HELPER="$ROOT/.agents/skills/yiui-gsd/scripts/yiui-gsd.mjs"
[[ -f "$HELPER" ]] || {
  echo "error: missing $HELPER" >&2
  exit 1
}

exec node "$HELPER" verify-install --project-root "$ROOT"
