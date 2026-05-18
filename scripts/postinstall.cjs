#!/usr/bin/env node
// Auto-launch lodestar-setup right after `npm i -g`. Tricky because npm
// 7+ default pipes postinstall stdio into its own log — `console.log`
// is invisible, plain `stdio:'inherit'` spawn inherits the same pipe.
// Two escape routes here:
//
//   • Windows: spawn `cmd /c start "" cmd /k node <bundle>` to open a
//     NEW console window. The new window has its own real terminal,
//     completely outside npm's pipe; `/k` keeps the window open after
//     the wizard exits so the user can read the success message.
//
//   • Linux/macOS: fs.openSync('/dev/tty','r+') gives a fd attached to
//     the user's real terminal. Pass it as the spawned child's stdio
//     and it inherits the terminal directly, bypassing npm.
//
// Banner output goes to the same terminal device, not console.log, so
// the user sees "✓ Lodestar 已安装" even though npm captures stdout.
//
// If both escape routes fail (no console / CI / weird sandbox), we
// fall back to a hint, and the daemon entry (cli.ts) auto-triggers the
// wizard on first run regardless.

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const setupBundle = path.join(__dirname, '..', 'dist', 'lodestar-setup.js')

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
    // No console accessible — write to stdout (npm likely swallows it).
    try { process.stdout.write(msg) } catch {}
  }
}

function fallback (reason) {
  if (reason) termWrite(`  \x1b[2m(${reason})\x1b[0m\n`)
  termWrite('  下一步: 在 cmd / PowerShell 里跑 \x1b[32mlodestar-daemon\x1b[0m')
  termWrite(' (会自动拉起向导)\n')
  termWrite('  或者只跑向导: \x1b[32mlodestar-setup\x1b[0m\n\n')
  process.exit(0)
}

termWrite('\n  \x1b[1m\x1b[36m✓ Lodestar 已安装\x1b[0m\n\n')

// Path 1: npm started us with --foreground-scripts. Our own stdio is
// already a real TTY. Just inherit-spawn the wizard, same window.
if (process.stdout.isTTY && process.stdin.isTTY) {
  termWrite('  \x1b[2m启动配置向导...\x1b[0m\n\n')
  const child = spawn(process.execPath, [setupBundle], { stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code == null ? 0 : code))
  child.on('error', (e) => fallback(`spawn 失败: ${e.message}`))
  return
}

// Path 2: Windows. Open a NEW console window — that window is outside
// npm's stdio pipe and has a real terminal of its own. `cmd /k` keeps
// it open after the wizard exits so the success message is readable.
if (process.platform === 'win32') {
  termWrite('  \x1b[2m启动配置向导 (新窗口) ...\x1b[0m\n')
  termWrite('  \x1b[2m向导会在另一个 cmd 窗口里跑, 完成后按 Enter / 输入 exit 关掉它即可。\x1b[0m\n\n')
  try {
    const child = spawn(
      'cmd.exe',
      ['/c', 'start', 'Lodestar Setup', 'cmd', '/k', process.execPath, setupBundle],
      { detached: true, stdio: 'ignore', windowsHide: false },
    )
    child.unref()
    process.exit(0)
  } catch (e) {
    fallback(`新窗口启动失败: ${e.message}`)
  }
  return
}

// Path 3: Linux / macOS. Open the user's controlling terminal directly
// as a fd and pass it as child stdio. Bypasses npm's pipe in-place,
// same terminal window.
try {
  const ttyFd = fs.openSync('/dev/tty', 'r+')
  termWrite('  \x1b[2m启动配置向导...\x1b[0m\n\n')
  const child = spawn(process.execPath, [setupBundle], {
    stdio: [ttyFd, ttyFd, ttyFd],
  })
  child.on('exit', (code) => process.exit(code == null ? 0 : code))
  child.on('error', (e) => fallback(`spawn 失败: ${e.message}`))
} catch (e) {
  fallback(`/dev/tty 打不开: ${e.message}`)
}
