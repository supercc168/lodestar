/**
 * Schema 2.0 Feishu card templates — barrel re-export. Each call site
 * uses `import * as cards from './cards'` and reaches everything through
 * this file. Internal split so each module stays under practical
 * per-read token budget:
 *   - cards/elements.ts — ELEMENTS (shared element-id helpers)
 *   - cards/turn.ts     — main turn card, plan/goal/context/ask panels
 *   - cards/tool.ts     — tool summaries, tool panels, permission panels
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
  footerContextPercentLabel,
  footerTokenDetailLine,
  mainConversationCard,
  assistantSegmentElement,
  contextCompactionElement,
  goalDisplaySignature,
  goalElement,
  planElement,
  askUserQuestionElement,
  hostAskCard,
} from './cards/turn'
export {
  summarizeToolInput,
  toolCallElement,
  readBatchElement,
  toolCallPermissionElement,
} from './cards/tool'
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
export {
  type AgyGitSnapshot,
  type AgyStats,
  type AgyTaskCardOpts,
  agyForwardElement,
  agyForwardPlaceholderElement,
  agyPromptElement,
  agyRepoElement,
  agyResultElement,
  agyStatsElement,
  agyTaskCard,
  cleanAgyOutputText,
} from './cards/agy'
export {
  type TasklistPanelNotice,
  type TasklistPanelOpts,
  tasklistPanelCard,
} from './cards/task'
