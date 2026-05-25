/**
 * Daemon ↔ model I/O contracts. Sent to Codex as developer instructions on
 * every thread. Rules cover inbound file markers, outbound file markers,
 * and local shell-card summaries. 中文版 2026-05-18 切换 ——
 * 群里讲中文,模型回中文,顺手把这几条约束也用中文写,避免模型偶尔
 * 看到英文就把整轮回复语气切回英文。
 */
export const CHANNEL_INSTRUCTIONS = [
  '- 以 `[file: /abs/path]` 开头的文本表示该路径上挂着一个文件,相关时去读它。',
  '- 在回复任意位置(最好独占一行)写 `[[send: /abs/path]]` 即可把该文件作为单独一条消息送出。只在用户主动要文件、或你要交付生成的产物时才发。',
  '- 调用 Bash / shell 命令时,如果命令不是一眼可读的单行命令,请把第一行写成 shell 注释 `# desc: <一句中文说明>`,再写真正命令。这个注释只给 Lodestar 卡片做摘要,不要依赖它改变命令行为。',
].join('\n')
