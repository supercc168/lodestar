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
 *   assistant         — completed assistant answer segment
 *   footer            — runtime footer. While the model is silent it
 *                       shows `Thinking...(Ns)` while the model is silent,
 *                       `Writing...(Ns)` while assistant text is buffered,
 *                       `Working...(Ns)` while tools/non-text work run; at
 *                       turn close it becomes the terminal status line.
 */
export const ELEMENTS = {
  userInput: 'user_input',
  footer: 'footer',
  /** Live task-board overview panel — 本 turn 一旦出现 Task 工具就在 footer
   *  正前建立(固定 id,后续只 replace 内容、不挪位)。默认展开、每次 Task 工具
   *  add/complete 都刷新成整个 board 的最新快照,对齐 claude cli 底部常驻 todo。
   *  独立于 tool_<i>(那是每次工具调用的过程变更记录、折叠);这个是实时总览。
   *  建立后它成为新的插入锚点 —— 后续过程元素 insert_before 它而非 footer,
   *  保证实时区永远压在 footer 正前(见 session-tools.taskLiveAnchor)。 */
  taskBoardLive: 'task_board_live',
  tool: (i: number) => `tool_${i}`,
  planUpdate: (i: number) => `plan_update_${i}`,
  goalUpdate: (i: number) => `goal_update_${i}`,
  contextCompact: (i: number) => `context_compact_${i}`,
  /** Assistant text is segmented: every completed agentMessage becomes one
   * static markdown element, so element order in the card matches Codex's
   * emission order. */
  assistant: (i: number) => `assistant_${i}`,
  /** Console (hi) card — the subscription-usage row is rendered as its
   * own element so we can replace it after the initial card lands,
   * decoupling the slow Codex account fetch from the rest of the panel's
   * synchronous data. */
  consoleCurrentModel: 'console_current_model',
  consoleProjects: 'console_projects',
  consoleHost: 'console_host',
  consoleUsage: 'console_usage',
  /** Model command card — one replaceable panel for model → effort
   * multi-step selection inside a single card. */
  modelPanel: 'model_panel',
  /** One-shot agy task card. */
  agyPrompt: 'agy_prompt',
  agyStats: 'agy_stats',
  agyResult: 'agy_result',
  agyForward: 'agy_forward',
  agyRepo: 'agy_repo',
  /** Tasklist automation panel. */
  tasklistPanel: 'tasklist_panel',
} as const
