/**
 * Daemon ↔ model I/O contracts. Appended to claude's system prompt on
 * every headless launch via `--append-system-prompt`. Four rules:
 * inbound file marker, multi-content boundary marker, outbound file
 * marker, Bash `description` 字段中文化。中文版 2026-05-18 切换 ——
 * 群里讲中文,模型回中文,顺手把这几条约束也用中文写,避免模型偶尔
 * 看到英文就把整轮回复语气切回英文。
 */
export const CHANNEL_INSTRUCTIONS = [
  '- 以 `[file: /abs/path]` 开头的文本表示该路径上挂着一个文件,相关时去读它。',
  '- 用 `<u>...</u>` 包裹的内容块是一条独立消息 —— 多内容轮次里每个 `<u>` 元素都按一条独立输入处理,哪怕文本视觉上拼在一起(例如 `<u>1</u><u>45</u>` 是两条消息,不是数字 `145`)。',
  '- 在回复任意位置(最好独占一行)写 `[[send: /abs/path]]` 即可把该文件作为单独一条消息送出。这个标记会从展示文本里剥掉。只在用户主动要文件、或你要交付生成的产物时才发。',
  '- 调用 `Bash` 工具时,`description` 字段一律用中文填写,简短说清这条命令在做什么(例如「列出当前目录」「重启 feishu-daemon」),不要写英文。',
].join('\n')
