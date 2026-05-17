/**
 * Schema 2.0 Feishu card templates — barrel re-export. Each call site
 * uses `import * as cards from './cards'` and reaches everything through
 * this file. Internal split so each module stays under Claude Code's
 * per-read token budget:
 *   - cards/elements.ts — ELEMENTS (shared element-id helpers)
 *   - cards/turn.ts     — main turn card, tool panels, ask panels, todos
 *   - cards/console.ts  — console + menu cards, formatters,
 *                          streamingOffSettings
 */

export { ELEMENTS } from './cards/elements'
export {
  type Todo,
  type AskQuestion,
  type AskAnswered,
  type AskState,
  summarizeToolInput,
  mainConversationCard,
  assistantSegmentElement,
  thinkingCollapsedPanel,
  toolCallElement,
  readBatchElement,
  toolCallPermissionElement,
  askUserQuestionElement,
} from './cards/turn'
export {
  consoleUsageContent,
  consoleCard,
  menuCard,
  streamingOffSettings,
} from './cards/console'
