/**
 * Isolate the Bun test process from real Lodestar credentials and XDG state.
 * (上游 b264b60 按线移植:mkdtemp 临时根 + 最小 config + env 注入 + exit 清理。)
 *
 * 必须是 bunfig.toml [test].preload 的第一项 —— src/config.ts 在模块加载时
 * 即读 CONFIG_FILE(config.ts `export const config = loadConfig()`),
 * env 注入必须先于任何读 paths/config 的模块执行(feishu-test-mock 也在其后)。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testRoot = mkdtempSync(join(tmpdir(), 'lodestar-test-'))
const configFile = join(testRoot, 'config.toml')
const dataDir = join(testRoot, 'data')
const codexHome = join(testRoot, 'codex')
const claudeConfigDir = join(testRoot, 'claude')

mkdirSync(dataDir, { recursive: true })
mkdirSync(codexHome, { recursive: true })
mkdirSync(claudeConfigDir, { recursive: true })
// config 模板用本地 schema(与上游模板的差异点,D-02 保护线):
// - 本地必需键仅 [feishu].app_id/app_secret(src/config.ts 缺则 throw);
// - [runtime].projects_root 指向临时根,项目解析不落真实 homedir(上游同款行为);
// - 不写上游 [token_source.*] 段 —— 本地凭据/模型注入走 slim 适配层
//   (resolveTokenSource* 系列),该 TOML schema 本地无效。
writeFileSync(configFile, [
  '[feishu]',
  'app_id = "test_app_id"',
  'app_secret = "test_app_secret"',
  '',
  '[runtime]',
  `projects_root = "${testRoot.replace(/\\/g, '\\\\')}"`,
  '',
].join('\n'))
writeFileSync(join(claudeConfigDir, 'settings.json'), '{"env":{}}\n')

process.env.NODE_ENV = 'test'
process.env.LODESTAR_CONFIG = configFile
process.env.LODESTAR_DATA_DIR = dataDir
process.env.CODEX_HOME = codexHome
process.env.CLAUDE_CONFIG_DIR = claudeConfigDir

process.on('exit', () => {
  try { rmSync(testRoot, { recursive: true, force: true }) } catch {}
})
