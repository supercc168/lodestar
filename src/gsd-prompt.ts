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
    '[Lodestar GSD]',
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
