/**
 * 隔离生效断言(FIX-06/上游 b264b60 验收判据的可执行形态)。
 *
 * bunfig [test].preload 首项 test-preload.ts 必须在任何模块加载前把
 * config/XDG 运行状态指向临时目录 —— 本文件锁定该不变式:preload 顺序
 * 回退、env 注入丢失或 paths.ts 消费点改动后,这里会先红,阻止测试
 * 静默读写宿主真实 config/运行状态。
 *
 * 断言刻意不 import ./config:个别测试文件会 mock.module('./config'),
 * 跨文件泄漏会让这里拿到替身;改用 Bun.TOML.parse 直接解析临时 config
 * 原文 + import ./paths(无测试 mock 它)取模块加载时刻的解析结果。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { CONFIG_FILE, DATA_DIR } from './paths'

const TMP = tmpdir()

describe('test-preload isolation (upstream b264b60)', () => {
  test('用例 1: LODESTAR_CONFIG 存在、位于 os.tmpdir() 下,文件可读且解析含 [feishu]', () => {
    const configPath = process.env.LODESTAR_CONFIG
    expect(configPath).toBeDefined()
    expect(configPath!.startsWith(TMP)).toBe(true)
    const raw = readFileSync(configPath!, 'utf8')
    const parsed = Bun.TOML.parse(raw) as { feishu?: { app_id?: string; app_secret?: string } }
    expect(parsed.feishu?.app_id).toBe('test_app_id')
    expect(parsed.feishu?.app_secret).toBe('test_app_secret')
  })

  test('用例 2: paths.ts 模块加载时注入已生效——CONFIG_FILE/DATA_DIR 即 env 值', () => {
    // preload 先于模块加载的证明:paths.ts 在 import 时刻读 env 定值,
    // 若 env 注入晚于首个模块加载,这两个常量会落到宿主真实路径。
    expect(CONFIG_FILE).toBe(process.env.LODESTAR_CONFIG!)
    expect(DATA_DIR).toBe(process.env.LODESTAR_DATA_DIR!)
  })

  test('用例 3: CLAUDE_CONFIG_DIR/CODEX_HOME/LODESTAR_DATA_DIR 均指向 tmp 前缀,不指向 $HOME 真实路径', () => {
    const home = homedir()
    for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'LODESTAR_DATA_DIR'] as const) {
      const value = process.env[key]
      expect(value).toBeDefined()
      expect(value!.startsWith(TMP)).toBe(true)
      expect(value!.startsWith(home)).toBe(false)
    }
  })
})
