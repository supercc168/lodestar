---
name: imageread
description: "Analyze or read images via Codex (gpt-5.6-sol vision) — a stronger / second-opinion image reader alongside the session model's built-in Read. Use when describing a screenshot / photo / GIF / UI mockup, extracting visible text (OCR), comparing images, or producing a layout+component description for front-end code replication. Returns text analysis, NOT an image. Modes: general, ui-replicate, ocr, diff."
---

# imageread (Lodestar → Codex)

独立的图像**分析**能力,服务**任意**主会话模型(Claude / GLM / Codex)。主会话停在当前选定模型;只有本 skill 通过统一入口 `lodestar-imageread` 调用 `codex exec`,借 gpt-5.6-sol 的视觉 + 推理来读图。

**与内置 `Read` 的区别**:`Read` 由当前会话模型自己看图;`imageread` 固定走 codex 背后的 gpt-5.6-sol(有效窗口 353K、reasoning 可调、附 visualize/computer-use 等视觉插件)。当当前模型视觉偏弱、或想要更强模型的第二意见时用它。与 `imagegen`(产图)正相反:本 skill **读图、产文本**。

## Entry point (always)

用 Lodestar 的统一入口 `lodestar-imageread` —— 它是 `scripts/imageread.sh` 的已安装副本,固化了安全参数(read-only / 不留 session / 跳过 git 检查)、规避了 codex 的参数顺序坑、用 `-o` 取干净最终消息。**不要裸调 `codex exec`**。

通用读图(默认 general 模式自带描述指令):

```bash
# desc: imageread 通用读图
{{LODESTAR_IMAGEREAD_BIN}} -i /abs/path/screenshot.png
```

带自己的问题读图:

```bash
# desc: imageread 带自定义问题
{{LODESTAR_IMAGEREAD_BIN}} \
  -i /abs/path/battle.gif \
  -p "这个战斗结算界面,玩家最终得了多少经验?伤害数值对吗?"
```

UI 截图 → 复刻描述(给后续代码生成用):

```bash
# desc: imageread UI 复刻模式
{{LODESTAR_IMAGEREAD_BIN}} -i /abs/path/ui.png -m ui-replicate
```

只提取文字(OCR):

```bash
# desc: imageread OCR 模式
{{LODESTAR_IMAGEREAD_BIN}} -i /abs/path/log.png -m ocr
```

对比两张图:

```bash
# desc: imageread 对比两图差异
{{LODESTAR_IMAGEREAD_BIN}} -i /abs/path/before.png -i /abs/path/after.png -m diff
```

**提速 / 加深**:默认 reasoning effort = `medium`(codex 配置默认是 max,较慢)。快速看一眼用 `-e low`,复杂分析要更深用 `-e max`:

```bash
# desc: imageread 低推理快速读图
{{LODESTAR_IMAGEREAD_BIN}} -i screenshot.png -e low
```

调试:加 `--raw` 把 codex 过程输出打到 stderr。

## 返回与投递

- 返回的是**文本**(模型对图片的分析),入口 stdout 即干净结果,直接拿来用。
- **不产图片**,因此**不要**用 `[[send: ...]]` —— 那是 `imagegen` 产图投递用的,这里无图可发。
- 多张图:重复 `-i`。`diff` 模式至少要两张。

## When to use

- 当前会话模型(如 GLM 系)视觉不够,想让 gpt-5.6-sol 来读截图 / GIF
- 战斗 / 客户端实机取证:分析截图里的事件、数值、报错、UI 状态
- UI 截图 → 结构化复刻描述(`ui-replicate`,便于后续代码生成)
- 提取图片里的文字(`ocr`)
- 对比前后两张截图找差异(`diff`)
- 想要一个独立于主会话模型的“第二意见”读图

## When not to use

- 简单图片,主会话内置 `Read` 已看得懂 —— 直接 `Read`,别多绕一层 codex
- 需要逐像素 / 精确坐标的图像测量 —— 用专门工具,LLM 视觉不保证精确
- 图片含密钥 / token / 敏感数据(见下)

## Privacy(重要)

`imageread` 会把图片发给 codex 配置的第三方模型供应商(当前是 `api.wuhen-ai.com` / gpt-5.6-sol)。**不要**喂含密码、API key、token、个人隐私、未公开商业机密的截图。游戏截图 / 公开 UI 没问题。

## Guardrails

- 用统一入口 `lodestar-imageread`,不裸调 `codex exec`(参数坑见 `references/cli.md`)。
- 固定 read-only sandbox + ephemeral(不留 session),不要为图方便加 `--dangerously-bypass-approvals-and-sandbox`。
- 不要修改 `scripts/imageread.sh`;缺能力先向用户提需求。
- 不要把 codex / 第三方 API key 打印或写进 prompt。
- 输出文本要落盘时写到 workspace 明显路径,别只留 /tmp。
- This skill tree is daemon-managed. Hand-edits under `~/.claude/skills/imageread` or `~/.codex/skills/imageread` are overwritten on boot unless `LODESTAR_DISABLE_SKILL_SYNC=1`.

## References (installed beside this file)

- `references/cli.md` — `codex exec` 完整 flag、已知坑、mac 超时方案
