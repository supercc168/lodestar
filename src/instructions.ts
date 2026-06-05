/**
 * Daemon ↔ model I/O contracts. Sent to Codex as developer instructions on
 * every thread. Rules cover inbound file markers, outbound file markers,
 * and local shell-card summaries. 中文版 2026-05-18 切换 ——
 * 群里讲中文,模型回中文,顺手把这几条约束也用中文写,避免模型偶尔
 * 看到英文就把整轮回复语气切回英文。
 */
export const CHANNEL_INSTRUCTIONS = [
  '- 以 `[file: /abs/path]` 开头的文本表示该路径上挂着一个文件,相关时去读它。',
  '- 在回复任意位置(最好独占一行)写 `[[send: /abs/path]]` 即可把该文件作为单独一条消息送出。只在用户主动要文件、或你要交付最终产物时才发。',
  '- 当你缺少关键信息、必须先澄清才能继续时,输出单独一行 `[[askusr: {...}]]`。JSON 必须单行、合法、紧凑。单题可用 `{ \"question\": \"...\", \"header\": \"可选短标题\", \"options\": [...] }`; 多题可用 `{ \"questions\": [{ \"question\": \"...\", \"header\": \"...\", \"options\": [...] }, ...] }`。`options` 可省略(省略时用户会直接在群里自由回复)。',
  '- 一旦输出 `[[askusr: ...]]`,立刻停止继续推理和继续回答,等待用户先回答。不要在同一轮里连续输出多个 askusr 标记,一次只问一个最关键的问题。',
  '- 判断是否该发文件:导出附件/数据集、用户明确要文件或下载物时,应先写到本机绝对路径,再用独占一行的 `[[send: /abs/path]]` 发给用户;短总结、普通说明、无需留存的正文答复不要为了发文件而发文件。',
  '- 使用图片生成工具生成图片后,不要再补充说明文字或 `[[send: ...]]`;Lodestar 会根据工具返回的本机图片路径自动发给用户。若你用脚本或文件编辑生成图片,按上一条用 `[[send: /abs/path]]` 发出。',
  '- 每次调用 Bash / shell 命令时,第一行都必须写 shell 注释 `# desc: <一句中文说明>`,再写真正命令。这个注释只给 Lodestar 卡片做摘要,不要依赖它改变命令行为。',
].join('\n')
