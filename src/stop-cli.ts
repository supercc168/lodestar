/**
 * CLI entry for `lodestar-stop` bin.
 *
 * 读 daemon.pid → 用 isOurDaemon 校验 cmdline (避免 PID 回收误杀) → 发
 * SIGTERM 让 daemon 走自己的 cleanup (清 PID 文件、写 alive marker、把
 * SIGINT 转给子进程)。然后轮询等 PID 文件被 cleanup 删掉,或超时报错。
 *
 * Windows 没有 POSIX SIGTERM, Node 的 process.kill(pid, 'SIGTERM') 在
 * Win32 上其实等价于无条件强杀 (TerminateProcess) — daemon 拿不到信号、
 * cleanup 跑不到、SIGBREAK handler 也不会触发。所以这里 Win 直接走
 * taskkill, 优雅 vs 强杀语义反正都没了, 让平台原生 API 接管就行。
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { PID_FILE } from './paths'
import { isOurDaemon } from './pid-guard'

const C = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  green: '\x1b[32m',
  yellow:'\x1b[33m',
  red:   '\x1b[31m',
  dim:   '\x1b[2m',
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  if (!existsSync(PID_FILE)) {
    console.log(`${C.yellow}Lodestar daemon 未运行${C.reset} ${C.dim}(${PID_FILE} 不存在)${C.reset}`)
    return
  }

  const raw = readFileSync(PID_FILE, 'utf8').split('\n')
  const pid = parseInt((raw[0] ?? '').trim(), 10)
  const marker = (raw[1] ?? '').trim()
  if (!Number.isFinite(pid) || pid <= 0) {
    console.error(`${C.red}PID 文件格式坏:${C.reset} ${PID_FILE}`)
    process.exit(1)
  }

  if (marker && !isOurDaemon(pid, marker)) {
    console.log(`${C.yellow}PID ${pid} 上没有 daemon (stale 文件)${C.reset}`)
    console.log(`${C.dim}手删 ${PID_FILE} 后再试${C.reset}`)
    return
  }

  console.log(`${C.bold}停止 daemon${C.reset} (pid ${pid})...`)
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' })
    } else {
      process.kill(pid, 'SIGTERM')
    }
  } catch (e: any) {
    console.error(`${C.red}发信号失败:${C.reset} ${e?.message ?? e}`)
    process.exit(1)
  }

  // PID 文件由 daemon 自己 cleanup 删掉; 等它消失就代表优雅退出完成。
  // 5s 超时, 超时不删 PID 文件由后续启动的 pid-guard 自己清理。
  for (let i = 0; i < 50; i++) {
    if (!existsSync(PID_FILE)) {
      console.log(`${C.green}✓ daemon 已停${C.reset}`)
      return
    }
    await sleep(100)
  }
  console.log(`${C.yellow}已发 SIGTERM, 但 5s 内 daemon 没清掉 ${PID_FILE}${C.reset}`)
  console.log(`${C.dim}它可能还在收尾 (落盘 alive marker / 关 WS); 下次启动 pid-guard 会自动判别。${C.reset}`)
}

main().catch((e: any) => {
  console.error(`${C.red}lodestar-stop:${C.reset} ${e?.message ?? e}`)
  process.exit(1)
})
