/** Prefix of every daemon-injected GSD prompt; also used as session-exec detector. */
export const GSD_INJECT_PREFIX = '[Lodestar GSD]'

export function buildGsdInjectPrompt(input: {
  action: 'continue' | 'new-task-discuss'
  taskSlug: string
  taskName: string
  provider: string
}): string {
  const actionLine = input.action === 'continue'
    ? `当前动作: continue — 从 STATE 单调游标推进唯一下一步（$gsd-progress --next --ws ${input.taskSlug}）`
    : `当前动作: new-task-discuss — 按 yiui-gsd 建立 planning 基线并进入 discuss/onboard，所有命令显式带 --ws ${input.taskSlug}`
  return [
    GSD_INJECT_PREFIX,
    '- 只用 yiui-gsd；禁止 superpowers / OMC / oh-my-claudecode / ralplan / ralph / ultrawork / “plan this” 旧规划入口',
    `- 先读 .gsd/TRACKER.md、.gsd/${input.taskSlug}/TASK.md 与 .gsd/${input.taskSlug}/.planning/STATE.md`,
    `- 根 .planning 是稳定目录；本任务路由为 .planning/workstreams/${input.taskSlug}，不要把根 .planning 当成任务目录`,
    '- TRACKER 只是未完成任务聚合索引，不表示当前选择，也不得因切换本任务而暂停其他任务',
    actionLine,
    `- task_slug: ${input.taskSlug}`,
    `- 任务名: ${input.taskName}`,
    `- provider: ${input.provider}`,
    '- 完成后用中文简报：状态、phase、下一步；不得重做已 GREEN/已验证项',
    `- 所有底层 gsd-* 命令显式追加 --ws ${input.taskSlug}`,
    '- 状态以 TASK/STATE 磁盘事实为准；不要把聊天计划或 TRACKER 当成 session 选择',
  ].join('\n')
}

/** True when message text is a Lodestar GSD inject template (possibly after whitespace). */
export function isGsdInjectPrompt(text: string): boolean {
  return text.trimStart().startsWith(GSD_INJECT_PREFIX)
}

/** Parse `- task_slug: …` from an inject prompt; empty when missing. */
export function parseGsdInjectTaskSlug(text: string): string {
  const m = text.match(/^- task_slug:\s*(.+?)\s*$/m)
  return m?.[1]?.trim() || ''
}
