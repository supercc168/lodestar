/**
 * Element-id convention (must be unique within a card):
 *   user_input        — collapsible_panel,header "📥 收到 (N)",body 是这一轮
 *                       Codex 收到的 user wireText(多条 mid-turn 合并的就是 N>1)。
 *                       默认 expanded=false,把"自己刚才说了啥"收纳进卡片自己,
 *                       不必滚群里找原消息。
 *   ticker            — top-of-card 活体指示,每 1s 跳一次,只刷秒数(verb 是
 *                       turn 起时随机选的、固定不变)。首条 assistant text /
 *                       tool_use 到达时 deleteElement 掉,footer 切到 working。
 *                       推理阶段没有稳定明文输出时,这个 ticker 就是 turn
 *                       中段唯一的活体信号。
 *   tool_<i>          — one collapsible per tool call, indexed from 0
 *   assistant         — the main streaming assistant answer
 *   footer            — runtime footer (timing / status)
 */
export const ELEMENTS = {
  userInput: 'user_input',
  ticker: 'ticker',
  footer: 'footer',
  tool: (i: number) => `tool_${i}`,
  /** Assistant text is segmented: every tool call closes the running segment
   * and the next assistant chunk opens a new one, so element order in the
   * card matches Codex's emission order. */
  assistant: (i: number) => `assistant_${i}`,
  /** Console (hi) card — the subscription-usage row is rendered as its
   * own element so we can replace it after the initial card lands,
   * decoupling the slow Codex account fetch from the rest of the panel's
   * synchronous data. */
  consoleUsage: 'console_usage',
} as const
