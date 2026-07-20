/** Prefix of every daemon-injected GSD prompt; also used as session-exec detector. */
export const GSD_INJECT_PREFIX = '[Lodestar GSD]'

export function buildGsdInjectPrompt(input: {
  action: 'continue' | 'new-task-discuss'
  taskSlug: string
  taskName: string
  provider: string
}): string {
  const actionLine = input.action === 'continue'
    ? '当前动作: continue — 从 STATE 单调游标推进唯一下一步（$gsd-progress --next 语义）'
    : '当前动作: new-task-discuss — 按 yiui-gsd 为新任务建立/刷新 planning 基线并进入 discuss/onboard'
  return [
    GSD_INJECT_PREFIX,
    '- 只用 yiui-gsd；禁止 superpowers / OMC / oh-my-claudecode / ralplan / ralph / ultrawork / “plan this” 旧规划入口',
    '- 先读 .gsd/TRACKER.md 与活跃任务 STATE.md（经项目根 .planning）',
    actionLine,
    `- task_slug: ${input.taskSlug}`,
    `- 任务名: ${input.taskName}`,
    `- provider: ${input.provider}`,
    '- 完成后用中文简报：状态、phase、下一步；不得重做已 GREEN/已验证项',
    '- 状态以磁盘为准；不要把聊天计划当作 TRACKER',
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
