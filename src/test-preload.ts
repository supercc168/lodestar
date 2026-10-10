/**
 * Isolate the Bun test process from real Lodestar credentials and XDG state.
 * (上游 b264b60 按线移植:mkdtemp 临时根 + 最小 config + env 注入 + exit 清理。)
 *
 * 必须是 bunfig.toml [test].preload 的第一项 —— src/config.ts 在模块加载时
 * 即读 CONFIG_FILE(config.ts `export const config = loadConfig()`),
 * env 注入必须先于任何读 paths/config 的模块执行(feishu-test-mock 也在其后)。
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const testRoot = mkdtempSync(join(tmpdir(), 'lodestar-test-'))
const configFile = join(testRoot, 'config.toml')
const dataDir = join(testRoot, 'data')
const codexHome = join(testRoot, 'codex')
const claudeConfigDir = join(testRoot, 'claude')

mkdirSync(dataDir, { recursive: true })
mkdirSync(codexHome, { recursive: true })
mkdirSync(claudeConfigDir, { recursive: true })
// config 模板(并集合并,保留本地差异点 D-02 保护线):
// - [feishu].app_id/app_secret 用本地哨兵值(src/config.ts 缺则 throw;
//   test-preload.test.ts 按该值锁定隔离不变式);
// - [runtime].projects_root 指向临时根,项目解析不落真实 homedir(上游同款行为);
// - [token_source.glm] 随上游并入:合并后上游 token-source 注册表在树内,
//   上游派生的测试依赖该确定性来源;本地 slim 适配层不受影响。
writeFileSync(configFile, [
  '[feishu]',
  'app_id = "test_app_id"',
  'app_secret = "test_app_secret"',
  '',
  '[runtime]',
  `projects_root = "${testRoot.replace(/\\/g, '\\\\')}"`,
  '',
  '[token_source.glm]',
  'base_url = "https://open.bigmodel.cn/api/anthropic"',
  'auth_token = "test-token"',
  'model = "GLM-5.2"',
  '',
  '[deepseek-harness]',
  'api_key = "test-dsh-key"',
  'model = "deepseek-v4-pro"',
  '',
].join('\n'))
writeFileSync(join(claudeConfigDir, 'settings.json'), '{"env":{}}\n')

process.env.NODE_ENV = 'test'
const testRuntime = join(testRoot, 'agent-runtime')
mkdirSync(testRuntime)
writeFileSync(join(testRuntime, 'package.json'), '{"private":true,"type":"module"}\n')
symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(testRuntime, 'node_modules'), 'junction')
process.env.LODESTAR_TEST_AGENT_RUNTIME_ROOT = testRuntime
process.env.LODESTAR_CONFIG = configFile
process.env.LODESTAR_DATA_DIR = dataDir
process.env.CODEX_HOME = codexHome
process.env.CLAUDE_CONFIG_DIR = claudeConfigDir

process.on('exit', () => {
  try { rmSync(testRoot, { recursive: true, force: true }) } catch {}
})
