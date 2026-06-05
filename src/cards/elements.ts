/**
 * Element-id convention (must be unique within a card):
 *   user_input        — collapsible_panel,header "📥 收到 (N)",body 是这一轮
 *                       Codex 收到的 user wireText(多条 mid-turn 合并的就是 N>1)。
 *                       默认 expanded=false,把"自己刚才说了啥"收纳进卡片自己,
 *                       不必滚群里找原消息。
 *   tool_<i>          — one collapsible per tool call, indexed from 0
 *   plan_update_<i>   — timeline snapshot inserted where a plan update occurs
 *   goal_update_<i>   — timeline snapshot inserted where a goal update occurs
 *   context_compact_<i> — collapsible context-compaction lifecycle panel.
 *                       item/started creates it; item/completed replaces it.
 *   assistant         — the main streaming assistant answer
 *   footer            — runtime footer. While the model is silent it
 *                       shows `Thinking...(Ns)`; while visible work is
 *                       streaming/running it shows `Working...`; at turn
 *                       close it becomes the terminal status line.
 */
export const ELEMENTS = {
  userInput: 'user_input',
  footer: 'footer',
  tool: (i: number) => `tool_${i}`,
  planUpdate: (i: number) => `plan_update_${i}`,
  goalUpdate: (i: number) => `goal_update_${i}`,
  contextCompact: (i: number) => `context_compact_${i}`,
  /** Assistant text is segmented: every tool call closes the running segment
   * and the next assistant chunk opens a new one, so element order in the
   * card matches Codex's emission order. */
  assistant: (i: number) => `assistant_${i}`,
  /** Console (hi) card — the subscription-usage row is rendered as its
   * own element so we can replace it after the initial card lands,
   * decoupling the slow Codex account fetch from the rest of the panel's
   * synchronous data. */
  consoleProjects: 'console_projects',
  consoleHost: 'console_host',
  consoleUsage: 'console_usage',
  /** Model command card — one replaceable panel for model → effort
   * multi-step selection inside a single card. */
  modelPanel: 'model_panel',
} as const
