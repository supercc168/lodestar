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

/**
 * 把不可信文本(用户消息 / LLM 正文 / 工具输出 / SDK 结构化字段)规范化成
 * Card Kit markdown 元素可安全渲染的 content。代码块 ``` 与行内 `code` 内是
 * 字面量,原样保留;只清洗其外的 prose:
 *  - 转义 & < >:Card Kit 会把这些当 HTML 结构吞掉。代码主动构造的飞书标签
 *    (<font> 等)不经此函数,不受影响。
 *  - 降级外链图片 ![alt](url):Card Kit 把它解析成 image 并拿 url 当
 *    img_key,而 img_key 必须是飞书素材库 key,外链 URL 会被服务端拒
 *    (ErrCode 200570 invalid image keys),导致整张卡 create / 元素 update
 *    失败。降级成纯文本标记,既不触发 image 解析,又保留原图地址。
 * 保留 **粗体** / [文字](url) / 列表 / 引用 / 代码块等合法 markdown。
 */
export function sanitizeMarkdownForCardKit(text: string): string {
  if (!text) return text
  const code = /```[\s\S]*?```|`[^`\n]*`/g
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = code.exec(text)) !== null) {
    if (m.index > last) out += sanitizeProse(text.slice(last, m.index))
    out += m[0]
    last = m.index + m[0].length
  }
  if (last < text.length) out += sanitizeProse(text.slice(last))
  return out
}

function sanitizeProse(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(
      /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g,
      (_m, alt: string, url: string) => (alt.trim() ? `🖼️ ${alt.trim()} (${url})` : `🖼️ ${url}`),
    )
}
