/**
 * Element-id convention (must be unique within a card):
 *   user_input        — the collapsible "你说" panel
 *   thinking          — the de-emphasized thinking stream
 *   tool_<i>          — one collapsible per tool call, indexed from 0
 *   assistant         — the main streaming assistant answer
 *   footer            — runtime footer (timing / status)
 */
export const ELEMENTS = {
  thinking: 'thinking',
  footer: 'footer',
  tool: (i: number) => `tool_${i}`,
  /** Assistant text is segmented: every tool call closes the running segment
   * and the next assistant chunk opens a new one, so element order in the
   * card matches Claude's emission order. */
  assistant: (i: number) => `assistant_${i}`,
  /** Console (hi) card — the subscription-usage row is rendered as its
   * own element so we can replace it after the initial card lands,
   * decoupling the slow ccusage fetch from the rest of the panel's
   * synchronous data. */
  consoleUsage: 'console_usage',
} as const
