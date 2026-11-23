/** `lodestar update` flow, separated from the command entry so tests never spawn real installers. */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { PID_FILE } from './paths'
import { updateAgentRuntimes } from './agent-updates'
import { UsageError } from './cli-errors'

import { C } from './cli-output'

/** The package on disk is now the new release; this process still holds the
 * old code. Agent installation logic and overrides ship with the package, so
 * the new updater entry performs the Agent update. */
export function runInstalledAgentUpdate(spawnProcess: typeof spawn = spawn, execPath = process.execPath, script = process.argv[1]): Promise<number> {
  if (!script) return Promise.reject(new Error('无法确定更新入口路径，Agent 未更新；请运行 lodestar update --agents-only'))
  return new Promise((resolve, reject) => {
    const child = spawnProcess(execPath, [script, '--agents-only'], { stdio: 'inherit', windowsHide: true })
    child.on('error', error => reject(new Error(`启动新版 Agent 更新失败: ${error.message}`)))
    child.on('exit', code => resolve(code ?? 1))
  })
}

export interface LodestarUpdateDeps {
  npmInstall?: () => Promise<number>
  updateAgents?: typeof updateAgentRuntimes
  installedAgentUpdate?: () => Promise<number>
  daemonRunning?: () => boolean
  print?: (line?: string) => void
}

/** Resolves the process exit code; usage failures throw.
 *
 * 本 fork 不发 npm 包：Lodestar 本体从源码更新，这里只负责 Agent 运行时并打印
 * 源码更新与重启指引，不去安装上游包。 */
export async function runLodestarUpdate(args: string[], deps: LodestarUpdateDeps = {}): Promise<number> {
  const print = deps.print ?? ((line = '') => console.log(line))
  const agentsOnly = args.includes('--agents-only')
  if (args.some(arg => arg !== '--agents-only')) throw new UsageError('用法: lodestar update [--agents-only]')
  print(`${C.bold}更新 ${agentsOnly ? '' : 'Lodestar 指引 + '}Codex、Claude Code/SDK、DSH${C.reset}`)
  await (deps.updateAgents ?? updateAgentRuntimes)({ report: message => print(message) })
  print(`\n${C.green}✓ Agent 更新完成，新进程使用新版${C.reset}`)
  if (agentsOnly) return 0
  print()
  print(`${C.yellow}Lodestar 本体从源码更新（本 fork 不发布 npm 包）:${C.reset}`)
  print(`  ${C.cyan}cd <lodestar 源码目录> && git pull && bun install && bun run build${C.reset}`)
  if ((deps.daemonRunning ?? (() => existsSync(PID_FILE)))()) {
    print()
    print(`${C.yellow}daemon 仍在跑旧代码，重启托管服务后才会生效:${C.reset}`)
    print(`  ${C.dim}macOS launchd   :${C.reset} ${C.cyan}launchctl kickstart -k gui/$(id -u)/com.supercc168.lodestar${C.reset}`)
    print(`  ${C.dim}systemd --user  :${C.reset} ${C.cyan}systemctl --user restart <你的 unit>${C.reset}`)
    print(`  ${C.dim}前台手动运行时  :${C.reset} ${C.cyan}lodestar stop && lodestar start${C.reset}`)
  }
  return 0
}
