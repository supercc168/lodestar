/** Prefix of every daemon-injected GSD prompt; also used as session-exec detector. */
export const GSD_INJECT_PREFIX = '[Lodestar GSD]'

export function buildGsdInjectPrompt(input: {
  action: 'continue' | 'new-task-discuss'
  taskSlug: string
  taskName: string
  provider: 'codex' | 'claude'
  model: string
  effort: string
}): string {
  const actionLine = input.action === 'continue'
    ? `当前动作: continue — 从 STATE 单调游标推进唯一下一步（$gsd-progress --next --ws ${input.taskSlug}）`
    : `当前动作: new-task-discuss — 按 yiui-gsd 建立 planning 基线并进入 discuss/onboard，所有命令显式带 --ws ${input.taskSlug}`
  const childModelPolicy = input.provider === 'claude'
    ? `- Claude 子 agent 模型只由 Lodestar/GSD policy 解析：第一方 heavy/standard=飞书当前主力（Fable 5 或 Opus 5）、light=Sonnet 5（选 Opus 不注入 Fable，选 Fable 不注入 Opus）；第三方 API 路由的所有 alias 锁回当前 model=${input.model}；禁止自行覆写模型`
    : `- Codex 子 agent 全部锁到当前 model=${input.model}，只按 routing tier 调整推理强度；禁止自行覆写模型`
  return [
    GSD_INJECT_PREFIX,
    '- 只用 yiui-gsd；禁止 superpowers / OMC / oh-my-claudecode / ralplan / ralph / ultrawork / “plan this” 旧规划入口',
    `- 当前飞书 provider 是唯一允许的 AI 路由：provider=${input.provider}，model=${input.model}，effort=${input.effort}；所有 GSD 子 agent 禁止切换 provider、调用外部 AI CLI 或跨 AI review`,
    childModelPolicy,
    '- 主 agent 只负责路由、状态持久化和结构化收口；不要在收到 research/planner/checker 报告后完整重做一遍同样的头脑风暴或规划推理',
    '- 单个 PLAN 不超过两个任务时按 GSD 1.8 原地执行，不启动 executor 子 agent；超过阈值才按真实依赖派发，禁止为了制造并行而拆小任务',
    '- 子 agent 等待超时先做一次存活检查，不得因超时重复派发同一职责；继续等待时保持原任务和原模型不变',
    `- 先读 .gsd/TRACKER.md、.gsd/${input.taskSlug}/TASK.md 与 .gsd/${input.taskSlug}/.planning/STATE.md`,
    `- 根 .planning 是稳定目录；本任务路由为 .planning/workstreams/${input.taskSlug}，不要把根 .planning 当成任务目录`,
    '- TRACKER 只是未完成任务聚合索引，不表示当前选择，也不得因切换本任务而暂停其他任务',
    actionLine,
    `- task_slug: ${input.taskSlug}`,
    `- 任务名: ${input.taskName}`,
    `- provider: ${input.provider}`,
    `- model: ${input.model}`,
    `- effort: ${input.effort}`,
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
