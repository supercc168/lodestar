#!/usr/bin/env node

/**
 * fable-plan-dsh-exec (fpd) helpers.
 *
 * 跨模型编排的机械部分:身份解析(resolve)、任务目录初始化(init)、
 * 子 run 到终态的限时等待(wait)。波次派发本身由主 agent 用
 * `lodestar-agent` CLI 完成(fpd 不复制它的 run/follow-up/answer)。
 *
 * 设计约定:
 *   - 只读 lodestar-agent CLI 的公开输出,不直连 daemon(env 解析交给 CLI)。
 *   - 身份每次任务开始时现查,不落盘缓存;STATUS.md 只记"本任务用了谁"供审计。
 *   - 无第三方依赖,与 yiui-gsd/scripts 同一 node >= 18 基线。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

/** planner 默认档:Claude 第一方 fable(claude:fable → claude-fable-5)。 */
const DEFAULT_PLANNER = 'claude:fable'
/** wait 单次轮询间隔(ms)。 */
const POLL_MS = 15000
/** wait 单次预算上限(分钟):适配 Bash 工具 600s 超时,留 60s 余量。 */
const DEFAULT_BUDGET_MIN = 9
const TASK_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function fail(message) {
  process.stderr.write(`fpd: ${message}\n`)
  process.exit(1)
}

function usage() {
  return [
    'Usage:',
    '  fpd.mjs resolve [--planner <model-substr>] [--executor <model-substr>] [--json]',
    '  fpd.mjs init <task-slug> [--planner <model-substr>] [--executor <model-substr>]',
    '  fpd.mjs wait <run_id> [--budget-min <minutes>]',
  ].join('\n')
}

function runCli(args) {
  const result = spawnSync('lodestar-agent', args, { encoding: 'utf8' })
  if (result.error) fail(`无法调用 lodestar-agent CLI:${result.error.message}`)
  return result
}

function fetchIdentities() {
  const result = runCli(['identities', '--json'])
  if (result.status !== 0) fail(`identities 失败:${result.stderr.trim() || result.stdout.trim()}`)
  let data
  try {
    data = JSON.parse(result.stdout)
  } catch {
    fail('identities 输出不是合法 JSON')
  }
  return data
}

/**
 * 在指定 provider 的身份池里找身份:
 *   - pattern 为空 → 优先 source_default,否则取第一个;
 *   - 先精确匹配 model,再大小写不敏感子串;
 *   - 命中但 status !== 'ready' 视为不可用(带原因)。
 */
function matchIdentity(pool, provider, pattern) {
  if (!pool.length) return { hit: null, reason: `provider ${provider} 在身份目录中不存在` }
  let hit = null
  if (pattern) {
    hit = pool.find(i => i.model === pattern)
      ?? pool.find(i => i.model.toLowerCase().includes(pattern.toLowerCase()))
  } else {
    hit = pool.find(i => i.source_default) ?? pool[0]
  }
  if (!hit) return { hit: null, reason: `${provider} 身份中找不到匹配 "${pattern}" 的模型(可用:${pool.map(i => i.model).join(' / ')})` }
  if (hit.status !== 'ready') {
    return { hit: null, reason: `${hit.display_name}(${hit.model})未就绪:${hit.reason ?? '档位未配置凭据'}` }
  }
  return { hit, reason: '' }
}

function resolveCommand(argv) {
  let plannerPattern = DEFAULT_PLANNER
  let executorPattern = ''
  let json = false
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--planner': plannerPattern = requiredArg(argv[++i], '--planner'); break
      case '--executor': executorPattern = requiredArg(argv[++i], '--executor'); break
      case '--json': json = true; break
      default: fail(`unknown resolve option: ${argv[i]}\n${usage()}`)
    }
  }
  const data = fetchIdentities()
  const identities = data.identities ?? []
  const planner = matchIdentity(identities.filter(i => i.provider === 'claude'), 'claude', plannerPattern)
  if (!planner.hit) fail(`planner 身份不可用:${planner.reason}`)
  const executor = matchIdentity(identities.filter(i => i.provider === 'dsh'), 'dsh', executorPattern)
  if (!executor.hit) fail(`executor 身份不可用:${executor.reason}(dsh 需在 config.toml [deepseek-harness] 填 api_key;可用 lodestar-agent identities 核对)`)

  if (json) {
    const shape = i => ({ id: i.hit.id, model: i.hit.model, display_name: i.hit.display_name, default_effort: i.hit.default_effort, provider: i.hit.provider })
    process.stdout.write(`${JSON.stringify({ planner: shape(planner), executor: shape(executor), catalog_generation: data.catalog_generation }, null, 2)}\n`)
    return
  }
  const line = (role, i) => `✅ ${role.padEnd(8)} ${i.hit.id} · ${i.hit.display_name} · ${i.hit.model} · default-effort=${i.hit.default_effort}`
  process.stdout.write(`catalog ${data.catalog_generation ?? 'MISS'}\n${line('planner', planner)}\n${line('executor', executor)}\n`)
}

function initCommand(argv) {
  const slug = requiredArg(argv.shift(), 'init requires <task-slug>')
  if (!TASK_SLUG_RE.test(slug)) fail(`task slug 非法:${slug}`)
  let plannerPattern = DEFAULT_PLANNER
  let executorPattern = ''
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--planner': plannerPattern = requiredArg(argv[++i], '--planner'); break
      case '--executor': executorPattern = requiredArg(argv[++i], '--executor'); break
      default: fail(`unknown init option: ${argv[i]}\n${usage()}`)
    }
  }
  const data = fetchIdentities()
  const identities = data.identities ?? []
  const planner = matchIdentity(identities.filter(i => i.provider === 'claude'), 'claude', plannerPattern)
  if (!planner.hit) fail(`planner 身份不可用:${planner.reason}`)
  const executor = matchIdentity(identities.filter(i => i.provider === 'dsh'), 'dsh', executorPattern)
  if (!executor.hit) fail(`executor 身份不可用:${executor.reason}(dsh 需在 config.toml [deepseek-harness] 填 api_key;可用 lodestar-agent identities 核对)`)

  const dir = resolve('.fpd', slug)
  mkdirSync(dir, { recursive: true })
  const statusPath = join(dir, 'STATUS.md')
  if (existsSync(statusPath)) {
    process.stdout.write(`fpd: ${statusPath} 已存在,跳过初始化(续跑直接 follow-up / wait)\n`)
  } else {
    writeFileSync(statusPath, [
      '# STATUS',
      '',
      `- task: ${slug}`,
      `- catalog_generation: ${data.catalog_generation ?? 'MISS'}`,
      `- planner: ${planner.hit.model} (${planner.hit.id})`,
      `- executor: ${executor.hit.model} (${executor.hit.id})`,
      '',
      '## 波次',
      '',
      '| 波 | 角色 | run_id | 状态 |',
      '| --- | --- | --- | --- |',
      '| plan | planner | | pending |',
      '| review | planner(follow-up) | | pending |',
      '| exec | executor | | pending |',
      '| close | 主 agent | | pending |',
      '',
      '交付物(子 agent 写文件,stdout 只放一行摘要):',
      '- TASK.md(主 agent 写任务描述)',
      '- PLAN.md(planner 产出)',
      '- REVIEW.md(审阅结论 APPROVE / BLOCKERS)',
      '- EXEC-BRIEF.md(主 agent 写交接简报)',
      '- SUMMARY.md(executor 产出,与 PLAN 硬断言逐条对照)',
      '',
    ].join('\n'))
  }
  process.stdout.write(`task dir: ${dir}\nplanner: ${planner.hit.model}(${planner.hit.id})\nexecutor: ${executor.hit.model}(${executor.hit.id})\n`)
}

async function waitCommand(argv) {
  const runId = requiredArg(argv.shift(), 'wait requires <run_id>')
  let budgetMin = DEFAULT_BUDGET_MIN
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--budget-min': budgetMin = Number(requiredArg(argv[++i], '--budget-min')); break
      default: fail(`unknown wait option: ${argv[i]}\n${usage()}`)
    }
  }
  if (!Number.isFinite(budgetMin) || budgetMin <= 0) fail('--budget-min must be a positive number of minutes')
  const deadline = Date.now() + budgetMin * 60_000
  while (true) {
    const result = runCli(['status', runId])
    const stdout = result.stdout ?? ''
    if (result.status !== 0) fail(`status 查询失败:${result.stderr.trim() || stdout.trim()}`)
    const status = /^- Status: (\w+)/m.exec(stdout)?.[1] ?? ''
    if (!status) fail(`status 输出异常(无 Status 行):\n${stdout}`)
    if (status === 'needs_input') {
      process.stdout.write(stdout)
      fail('run 进入 needs_input:先 lodestar-agent answer 答复,再对同一 run_id 续 wait')
    }
    if (['completed', 'failed', 'cancelled'].includes(status)) {
      process.stdout.write(stdout)
      if (status !== 'completed') process.exitCode = 1
      return
    }
    if (Date.now() >= deadline) {
      process.stdout.write(stdout)
      fail(`wait 超预算(${budgetMin} 分钟):run 仍在 ${status};改用后台等待或稍后 lodestar-agent status ${runId} 跟进`)
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
}

function requiredArg(value, message) {
  if (!value?.trim()) fail(message)
  return value.trim()
}

async function main(argv) {
  const command = argv.shift() ?? ''
  switch (command) {
    case 'resolve': resolveCommand(argv); return
    case 'init': initCommand(argv); return
    case 'wait': await waitCommand(argv); return
    default: fail(`unknown fpd command: ${command ?? '(none)'}\n${usage()}`)
  }
}

main(process.argv.slice(2)).catch(error => fail(error instanceof Error ? error.message : String(error)))
