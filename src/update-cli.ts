/**
 * CLI entry for `lodestar-update` bin.
 *
 * 更新 Lodestar 指引与实际使用的 Agent runtimes(Codex / Claude Code/SDK / DSH);
 * --agents-only 仅立即更新 Agent。Lodestar 本体是源码构建安装(fork 未发 npm 包),
 * npm 升不到 —— 完事后打印 git pull + 重新构建的指引。stdio inherit 让底层命令的
 * 进度条和版本号输出原样透出来。完事后提示用户重启 daemon —— 我们这里 *不* 主动
 * stop + start,因为 daemon 可能挂在 systemd / Windows 后台托管下,由那边接管,
 * 自重启会撞两次。让用户自己根据部署方式决定;daemon 自身的服务生命周期仍由用户控制。
 */

import { existsSync } from 'node:fs'
import { PID_FILE } from './paths'
import { updateAgentRuntimes } from './agent-updates'

const C = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  cyan:  '\x1b[36m',
  green: '\x1b[32m',
  yellow:'\x1b[33m',
  red:   '\x1b[31m',
  dim:   '\x1b[2m',
}

async function main(): Promise<void> {
  const agentsOnly = process.argv.includes('--agents-only')
  if (process.argv.slice(2).some(arg => arg !== '--agents-only')) throw new Error('用法: lodestar-update [--agents-only]')
  console.log(`${C.bold}更新 ${agentsOnly ? '' : 'Lodestar 指引 + '}Codex、Claude Code/SDK、DSH${C.reset}`)
  await updateAgentRuntimes({ report: message => console.log(message) })

  console.log(`\n${C.green}✓ Agent 更新完成，新进程使用新版${C.reset}`)
  if (!agentsOnly) {
    console.log()
    console.log(`${C.yellow}Lodestar 本体从源码更新 (fork 未发 npm 包):${C.reset}`)
    console.log(`  ${C.cyan}cd <lodestar 源码目录> && git pull && bun install && bun run build && npm i -g .${C.reset}`)
  }
  if (!agentsOnly && existsSync(PID_FILE)) {
    console.log()
    console.log(`${C.yellow}检测到 daemon 仍在跑老版本进程, 用新版本需要重启:${C.reset}`)
    console.log(`  ${C.dim}# Linux systemd --user 托管的:${C.reset}`)
    console.log(`  ${C.cyan}systemctl --user restart lodestar${C.reset}      ${C.dim}# Linux${C.reset}`)
    console.log(`  ${C.dim}# macOS launchd / Windows 任务计划:用对应服务管理器重启。${C.reset}`)
    console.log(`  ${C.dim}# 或手动重启:${C.reset}`)
    console.log(`  ${C.cyan}lodestar-stop && lodestar-daemon${C.reset}`)
  }
}

main().catch((e: any) => {
  console.error(`${C.red}lodestar-update:${C.reset} ${e?.message ?? e}`)
  process.exit(1)
})
