#!/usr/bin/env bash
# imageread — analyze images via Codex (gpt-5.6-sol vision).
# Wraps `codex exec` with safe defaults and prints only the clean final message.
# Prompt is sent via stdin (so -i can't eat a positional prompt), result via -o.
set -euo pipefail

CODEX="${CODEX:-codex}"
MODE="general"
EFFORT="medium"
MODEL=""
TIMEOUT=300
WORKDIR="/tmp"
RAW=0
PROMPT=""
IMAGES=()

usage() {
  cat <<'EOF'
imageread — analyze images via Codex (gpt-5.6-sol vision)

Usage:
  imageread.sh -i <img> [-i <img>...] [options]

Required:
  -i, --image <FILE>   Image to analyze (repeatable; absolute path recommended).

Options:
  -p, --prompt <TEXT>  Analysis instruction. If omitted, a default is chosen by --mode.
  -m, --mode <MODE>    Preset prompt mode (default: general):
                         general       describe content / UI / text / layout
                         ui-replicate  describe layout, colors, components, interactions
                                       for downstream code generation
                         ocr           extract all visible text only
                         diff          compare 2+ images (needs >=2 -i)
  -e, --effort <LEVEL> Codex reasoning effort: low|medium|high|max (default: medium).
                       Codex config default is max (slow); lower for quick reads.
      --model <MODEL>  Override Codex model (default: config's gpt-5.6-sol).
  -t, --timeout <SEC>  Hard timeout in seconds (default: 300).
  -C, --cd <DIR>       Codex working root (default: /tmp; images stay readable via -i).
      --raw            Forward Codex process output to stderr (debug).
  -h, --help           Show this help.

Output: the model's final message on stdout (clean). Exit code mirrors Codex.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -i|--image)   IMAGES+=("$2"); shift 2;;
    -p|--prompt)  PROMPT="$2"; shift 2;;
    -m|--mode)    MODE="$2"; shift 2;;
    -e|--effort)  EFFORT="$2"; shift 2;;
    --model)      MODEL="$2"; shift 2;;
    -t|--timeout) TIMEOUT="$2"; shift 2;;
    -C|--cd)      WORKDIR="$2"; shift 2;;
    --raw)        RAW=1; shift;;
    -h|--help)    usage; exit 0;;
    *) echo "imageread: unknown argument: $1" >&2; usage >&2; exit 2;;
  esac
done

# --- validate ---
[[ ${#IMAGES[@]} -gt 0 ]] || { echo "imageread: at least one -i/--image is required" >&2; exit 2; }
for img in "${IMAGES[@]}"; do
  [[ -f "$img" ]] || { echo "imageread: image not found: $img" >&2; exit 2; }
done
case "$MODE" in
  general|ui-replicate|ocr|diff) :;;
  *) echo "imageread: unknown mode '$MODE' (general|ui-replicate|ocr|diff)" >&2; exit 2;;
esac
[[ "$MODE" == "diff" && ${#IMAGES[@]} -lt 2 ]] && { echo "imageread: diff mode needs >=2 -i images" >&2; exit 2; }
case "$EFFORT" in low|medium|high|max) :;; *) echo "imageread: bad effort '$EFFORT'" >&2; exit 2;; esac
[[ "$TIMEOUT" =~ ^[0-9]+$ ]] || { echo "imageread: bad timeout '$TIMEOUT'" >&2; exit 2; }
command -v "$CODEX" >/dev/null 2>&1 || { echo "imageread: codex not found on PATH (set \$CODEX)" >&2; exit 127; }

# --- default prompt by mode (when user gave none) ---
if [[ -z "$PROMPT" ]]; then
  case "$MODE" in
    general)
      PROMPT='请仔细分析这张（或这些）图片，用中文详细描述：画面主体内容、所有可见文字（原文）、UI 元素与布局结构、配色与视觉风格。如发现异常、报错或不合理之处，请单独指出。' ;;
    ui-replicate)
      PROMPT='Describe in detail the layout structure, color style, main components, and interactive elements in this image to facilitate subsequent code generation by the model. 用中文输出，具体到：(1) 整体布局：行列/栅格/分区，从外到内；(2) 配色：主色/辅色/背景色，尽量给近似十六进制色值；(3) 文字层级：标题/正文/辅助文字的字号与粗细关系；(4) 主要组件：按钮/输入框/卡片/列表/导航/弹窗等，及其状态（默认/选中/禁用）；(5) 可见交互元素与图标；(6) 间距、对齐、圆角、阴影规律。按从整体到局部的顺序描述。' ;;
    ocr)
      PROMPT='提取这张（或这些）图片中所有可见的文字，保持原文（中文/英文/数字/符号均原样）。按区域、从上到下、从左到右依次列出。只输出识别到的文字本身，不要补充或翻译。' ;;
    diff)
      PROMPT='对比给出的多张图片，指出它们之间的差异，包括：布局变化、新增或消失的元素、文字/数值变化、颜色或样式变化。先给一句总体结论，再按图片顺序逐项列出差异点。' ;;
  esac
fi

# --- build codex args (kept non-empty so it is safe under set -u) ---
CODEX_ARGS=(exec -s read-only --skip-git-repo-check --ephemeral -C "$WORKDIR")
[[ -n "$MODEL" ]] && CODEX_ARGS+=(-m "$MODEL")
CODEX_ARGS+=(-c "model_reasoning_effort=$EFFORT")
OUT="$(mktemp -t imageread)"
trap 'rm -f "$OUT"' EXIT
CODEX_ARGS+=(-o "$OUT")
for img in "${IMAGES[@]}"; do CODEX_ARGS+=(-i "$img"); done

# --- run codex: prompt on stdin (avoids -i eating a positional prompt), result via -o ---
STDOUT_DEST=/dev/null
STDERR_DEST=/dev/null
[[ "$RAW" -eq 1 ]] && { STDOUT_DEST=/dev/fd/2; STDERR_DEST=/dev/fd/2; }

set +e
printf '%s' "$PROMPT" | perl -e 'alarm shift(@ARGV); exec @ARGV' "$TIMEOUT" \
  "$CODEX" "${CODEX_ARGS[@]}" >"$STDOUT_DEST" 2>"$STDERR_DEST"
RC=${PIPESTATUS[1]}
set -e

if [[ $RC -ne 0 ]]; then
  echo "imageread: codex exited $RC (re-run with --raw to see codex output; raise -t if it was a timeout)" >&2
  exit "$RC"
fi
if [[ ! -s "$OUT" ]]; then
  echo "imageread: codex produced no final message (re-run with --raw to diagnose)" >&2
  exit 1
fi
cat "$OUT"
