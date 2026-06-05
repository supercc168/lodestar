/**
 * Schema 2.0 Feishu card templates — barrel re-export. Each call site
 * uses `import * as cards from './cards'` and reaches everything through
 * this file. Internal split so each module stays under practical
 * per-read token budget:
 *   - cards/elements.ts — ELEMENTS (shared element-id helpers)
 *   - cards/turn.ts     — main turn card, plan/goal panels, tool panels, ask panels
 *   - cards/console.ts  — console + menu cards, formatters,
 *                          streamingOffSettings
 */

export { ELEMENTS } from './cards/elements'
export {
  type ThreadGoal,
  type TurnPlanStep,
  type ContextCompactionNotice,
  type AskQuestion,
  type AskAnswered,
  type AskState,
  summarizeToolInput,
  footerContextPercentLabel,
  footerTokenDetailLine,
  mainConversationCard,
  assistantSegmentElement,
  contextCompactionElement,
  goalDisplaySignature,
  goalElement,
  planElement,
  toolCallElement,
  readBatchElement,
  toolCallPermissionElement,
  askUserQuestionElement,
  hostAskCard,
} from './cards/turn'
export {
  type ConsoleOpts,
  type ModelEffortChoice,
  type ModelChoice,
  consoleUsageContent,
  consoleUsageElement,
  consoleCurrentModelElement,
  consoleMainElement,
  consoleHostElement,
  consoleBodyElements,
  consoleCard,
  modelEffortCard,
  modelSelectionCard,
  modelSelectionPanelElement,
  modelResultCard,
  modelEffortPanelElement,
  modelResultPanelElement,
  statusCard,
  statusCardContent,
  menuCard,
  streamingOffSettings,
} from './cards/console'
export {
  type WorktreeCardEntry,
  type WorktreeListCardOpts,
  type WorktreeListNotice,
  type WorktreeNoticeCardOpts,
  worktreeListCard,
  worktreeNoticeCard,
} from './cards/worktree'
