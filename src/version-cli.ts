/**
 * CLI entry for `lodestar-version` bin. 打印 npm 实际装的 lodestar 版本(读
 * 包根 package.json,而不是编译时内联的常量),顺带探测 claude CLI 版本和
 * runtime,排障时一眼确认环境。
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const C = { reset: '\x1b[0m', bold: '\x1b[1m', cyan: '\x1b[36m', green: '\x1b[32m', dim: '\x1b[2m' }

function lodestarVersion(): string {
  // dist/lodestar-version.js → 包根 package.json 是 ../package.json;开发时
  // src/version-cli.ts 同样 ../package.json。两条路径都落在包根。
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '(unknown)'
  } catch { return '(unknown)' }
}

function claudeVersion(): string {
  // execSync 默认走 shell,Windows 上能直接跑 claude.cmd(不像 spawn 会 EINVAL)。
  try {
    const out = execSync('claude --version', { timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    return out || '(unknown)'
  } catch { return '(未找到 / 未安装)' }
}

console.log(`${C.bold}Lodestar${C.reset} ${C.green}v${lodestarVersion()}${C.reset}`)
console.log(`${C.dim}Claude Code:${C.reset} ${claudeVersion()}`)
console.log(`${C.dim}Runtime:${C.reset}     ${process.version} (${process.platform}-${process.arch})`)
