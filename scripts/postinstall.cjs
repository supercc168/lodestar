#!/usr/bin/env node
// Postinstall banner — 只告诉用户下一步跑什么, 不在这里拉起向导。
//
// 为什么不自动拉向导: npm 7+ pipe 了 postinstall 的 stdio, 自动拉向导只能
// 靠接管 /dev/tty 把终端塞给子进程 —— 这套机制脆弱 (作者原注 "Tricky")。
// 实测在部分 mac 环境 /dev/tty 接管失败时, 向导的 readline 拿不到输入死等,
// 而父进程 npm 又 wait 在向导退出上 → npm 和向导互相卡死, 终端冻住 (文件
// 其实早装好了); 杀掉还会触发 npm 回滚删文件。
//
// 稳的做法是 trigger-on-first-run: 用户在真终端首跑 lodestar-daemon 时,
// cli.ts 发现没 config + isTTY 就自动进入向导 (真 TTY, readline 一定正常)。
// 所以这里只打个提示就 process.exit(0), 不 spawn 任何子进程, 永不卡死。

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

// 自愈:确保当前平台的 SDK native binary 已装。走 SDK 默认入口后该 binary 是必需,
// 但 npm i -g 对 nested platform optional 在某些 npm 版本/历史残留下会漏装。
// 装漏了就在这里补,不依赖 npm 行为。非交互、stdio ignore,不碰 tty(区别于曾导致
// macOS 卡死的 readline 向导)。
;(function ensureNativeBinary () {
  const base = `claude-agent-sdk-${process.platform}-${process.arch}`
  const variants = process.platform === 'linux' ? [base, `${base}-musl`] : [base]
  const nm = path.join(__dirname, '..', 'node_modules', '@anthropic-ai')
  const has = (name) =>
    fs.existsSync(path.join(nm, name)) ||
    fs.existsSync(path.join(nm, 'claude-agent-sdk', 'node_modules', '@anthropic-ai', name))
  if (variants.some(has)) return
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    execFileSync(npm, ['install', '--include=optional', '--no-save', '--no-audit', '--no-fund'], {
      cwd: path.join(__dirname, '..'),
      stdio: 'ignore',
      timeout: 180000,
    })
  } catch {
    // 补装失败:静默(optional)。daemon 启动时 SDK 会报明确的 "Native CLI binary not found"
  }
})()

function termWrite (msg) {
  try {
    if (process.platform === 'win32') {
      const fd = fs.openSync('\\\\.\\CONOUT$', 'w')
      fs.writeSync(fd, msg)
      fs.closeSync(fd)
    } else {
      fs.writeFileSync('/dev/tty', msg)
    }
  } catch {
    // No controlling tty (CI / pipe) — best-effort stdout, npm 多半会吞掉。
    try { process.stdout.write(msg) } catch {}
  }
}

termWrite('\n  \x1b[1m\x1b[36m✓ Lodestar 已安装\x1b[0m\n')
termWrite('\n  \x1b[2m下一步: 在终端跑 \x1b[32mlodestar-daemon\x1b[0m\x1b[2m 进入配置向导\x1b[0m')
termWrite('\n  \x1b[2m(首次运行会自动拉起向导; 也可直接跑 \x1b[32mlodestar-setup\x1b[0m\x1b[2m)\x1b[0m\n\n')

process.exit(0)
