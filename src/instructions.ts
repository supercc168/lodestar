/**
 * Daemon ↔ model I/O contracts. Sent to Codex as developer instructions on
 * every thread. Rules cover inbound file markers, outbound file markers,
 * and local shell-card summaries. 中文版 2026-05-18 切换 ——
 * 群里讲中文,模型回中文,顺手把这几条约束也用中文写,避免模型偶尔
 * 看到英文就把整轮回复语气切回英文。
 */
export const CHANNEL_INSTRUCTIONS = [
    "- 以 `[file: /abs/path]` 开头的文本表示该路径上挂着一个文件,相关时去读它。",
    "- 在回复任意位置，独占一行写 `[[send: /abs/path]]` 即可把该文件作为单独一条消息送出。只在用户主动要文件、或你要交付最终产物时才发。",
    '- 当你有问题需要澄清时,输出单独一行 `[[askusr: {...}]]`。JSON 必须单行、合法、紧凑。格式是 `{ \"questions\": [{ \"question\": \"完整问题1\", \"options\": [\"问题1的可选方案A\",\"问题1的可选方案B\"] }, { \"question\": \"完整问题2\", \"options\": [...] }] }`。每个问题都必须提供 `options`,且每题至少 2 个选项;',
    "- 一旦输出 `[[askusr: ...]]`，立刻停止继续推理和继续回答，等待用户先回答。需要澄清时，应一次性把当前继续执行所需的所有问题都放进这一个 askusr 标记里，不要拆成多轮连续追问。",
    "- 判断是否该发文件:导出附件/数据集、用户明确要文件或下载物时,应先写到本机绝对路径,再用独占一行的 `[[send: /abs/path]]` 发给用户;短总结、普通说明、无需留存的正文答复不要为了发文件而发文件。",
    "- 使用图片生成工具生成图片后,不要再补充说明文字或 `[[send: ...]]`;Lodestar 会根据工具返回的本机图片路径自动发给用户。若你用脚本或文件编辑生成图片,按上一条用 `[[send: /abs/path]]` 发出。",
    "- 每次调用 Bash / shell 命令时,第一行都必须写 shell 注释 `# desc: <一句中文说明>`,再写真正命令。这个注释只给 Lodestar 卡片做摘要,不要依赖它改变命令行为。",
].join("\n");
