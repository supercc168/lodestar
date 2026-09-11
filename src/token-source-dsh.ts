/**
 * DeepSeek Harness 凭据适配层(03-02 Task 2;上游 722e45a 的**语义移植,形态重写**)。
 *
 * 上游该文件是一段工厂注册 + 动态模型目录拉取。本地 TokenSource 是函数式 slim
 * 适配层,项目铁律(src/AGENTS.md「For AI Agents」)禁止引入注册表、插件 API、
 * 双层 model 面板与 source 级目录刷新,故本文件只导出一个纯工厂
 * `dshSourceFromConfig()`,与 `claudeSourceFromProfile` / `codexSourceFromProfile`
 * 同构:拿配置段,返回 `TokenSource`。
 *
 * 边界与双轨(D-08):
 *   - 本文件是 provider 'dsh' 的**唯一凭据入口**:清洗 → 注入都在 `spawnEnv` 内完成,
 *     不落盘、不进卡片、不打印 capability。
 *   - 只读 `[deepseek-harness]`;`[claude.models.deepseek]`(Claude 兼容 deepseek 档)
 *     与本文件零交集,两条路径按 provider 值分流。
 *   - 模型目录来源是**配置驱动**(配置段的 model + effort),不在这里 spawn 子进程 ——
 *     同步路径不拉目录,面板档位由 session-model 读同一配置段派生。
 */
import { config, type DeepseekHarnessConfig } from './config'
import type { TokenSource } from './token-source'
import { scrubAnthropicEnv } from './token-source'

export const DSH_TOKEN_SOURCE_ID = 'deepseek-harness'
export const DSH_DEFAULT_BASE_URL = 'https://api.deepseek.com'
/** DSH 目录的 bootstrap 默认档(03-01 冒烟:`model/list` 中 deepseek-v4-pro 为默认档)。 */
export const DSH_DEFAULT_MODEL = 'deepseek-v4-pro'
export const DSH_DISPLAY_NAME = 'DeepSeek Harness'

/** 从 `[deepseek-harness]` 配置段构造 DSH TokenSource(缺省读当前全局 config)。 */
export function dshSourceFromConfig(
  section: DeepseekHarnessConfig | undefined = config.deepseek_harness,
): TokenSource {
  const apiKey = section?.api_key?.trim() ?? ''
  const baseUrl = section?.base_url?.trim() || DSH_DEFAULT_BASE_URL
  const model = section?.model?.trim() || DSH_DEFAULT_MODEL
  const displayName = section?.display?.trim() || DSH_DISPLAY_NAME
  const bin = section?.bin?.trim() || undefined
  return {
    id: DSH_TOKEN_SOURCE_ID,
    kind: 'api',
    provider: 'dsh',
    displayName,
    description: `DeepSeek Harness 原生后端(${baseUrl});凭据只经 spawn env 注入子进程。`,
    selectionModel: model,
    enabled: () => apiKey.length > 0,
    // DSH 原生模型名,无 [1m] 后缀语义 —— [1m] 是 Claude 兼容档的记账标识。
    resolveSpawnModel: () => model,
    spawnEnv(base) {
      // 顺序与上游一致:先 scrub ANTHROPIC_*(防 Claude 档凭据夹带),再清 DSH_*/
      // DEEPSEEK_*/LODESTAR_DSH_NODE(防调用方旧值残留成并集),最后才注入。
      const env = scrubAnthropicEnv(base)
      for (const key of Object.keys(env)) {
        if (key.startsWith('DSH_') || key.startsWith('DEEPSEEK_') || key === 'LODESTAR_DSH_NODE') delete env[key]
      }
      if (!apiKey) throw new Error('DeepSeek Harness API key is missing')
      env.DEEPSEEK_API_KEY = apiKey
      env.DEEPSEEK_BASE_URL = baseUrl
      if (bin) env.LODESTAR_DSH_NODE = bin
      return env
    },
    // dsh 没有 Codex 的 app-server provider/config 覆盖语义。
    spawnOverrides: () => ({ modelId: undefined, configArgs: [], env: {} }),
    usageSource: () => 'provider',
    isApiRoute: () => true,
  }
}
