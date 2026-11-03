/** 发布门禁的生产依赖审计：打包 tarball → 独立目录实装 → npm audit --omit=dev。
 *  bun audit --production 不按依赖段过滤（1.3.11 实测与全量输出一致），开发树中
 *  @deepseek-ai/dsh 系列快照内嵌的传递依赖会误伤门禁；本脚本对齐 ci.yml 的
 *  canonical 方法——只审实际发布产物，不检查源码目录的锁文件快照。 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (args: string[], cwd?: string) => {
  const result = spawnSync(npm, args, { cwd, stdio: 'pipe', encoding: 'utf8', shell: process.platform === 'win32' })
  if (result.status !== 0) {
    console.error(`npm ${args.join(' ')} 失败（exit=${result.status}）`)
    if (result.stdout?.trim()) console.error(result.stdout.trim())
    if (result.stderr?.trim()) console.error(result.stderr.trim())
    process.exit(result.status ?? 1)
  }
  return result
}

const work = mkdtempSync(join(tmpdir(), 'lodestar-audit-production-'))
try {
  const packDir = join(work, 'pack')
  const installDir = join(work, 'install')
  mkdirSync(packDir, { recursive: true })
  const packed = run(['pack', '--pack-destination', packDir, '--json'], undefined)
  const entries = JSON.parse(packed.stdout) as Array<{ filename: string }>
  if (!Array.isArray(entries) || entries.length !== 1) throw new Error(`打包结果异常：${entries?.length ?? 0} 个`)
  const tarball = join(packDir, entries[0]!.filename)
  run(['install', '--prefix', installDir, '--ignore-scripts', '--no-fund', '--no-audit', tarball])
  const audit = run(['audit', '--prefix', installDir, '--omit=dev'])
  const summary = audit.stdout.trim().split('\n').filter(line => /vulnerabilit/i.test(line)).join(' | ')
  console.log(`生产依赖审计通过${summary ? `：${summary}` : ''}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
