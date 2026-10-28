/**
 * DeepSeek Harness Token Source(上游 0.20.x factory 注册形态;本地档位语义移植)。
 *
 * 上游该文件是 Token Source 注册表体系的一环(import 即登记;见
 * token-source-builtins.ts)。本地 fork 的 dsh 档位解析语义原样保留:
 *   - 档位(model/effort)与 API key 只从 `[deepseek-harness]` 配置段解析,缺省
 *     回落 DSH 默认档 `deepseek-v4-pro` 与官方 base URL;凭据只经 spawnEnv 注入,
 *     不落盘、不进卡片、不打印 capability(D-08 双轨:与 `[claude.models.deepseek]`
 *     零交集,两条路径按 provider 值分流)。
 *   - 同步路径不 spawn 子进程:目录刷新在 refreshModels(后台)里走 model/list,
 *     bootstrap 档位由 DSH_DEFAULT_MODEL 常量兜底(session-model 读同一配置段派生)。
 *   - DSH 原生模型名,无 [1m] 后缀语义;[1m] 是 Claude 兼容档的记账标识。
 */
import { registerTokenSourceFactory, scrubDshEnv, tokenSourceFactories, tokenSourceRuntimeModels, type TokenSource } from './token-source'
import { isDshReasoningEffort } from './agent-process'
import { queryDshRuntime } from './dsh-runtime'
import { DSH_HOME_DIR } from './paths'
import type { DshModel } from './dsh-protocol'
import { config, type DeepseekHarnessConfig } from './config'
import { fetchDeepseekBalance, fetchDeepseekModelIds } from './token-source-deepseek'
import { modelList } from './token-source-visibility'

export const DSH_TOKEN_SOURCE_ID = 'deepseek-harness'
export const DSH_DEFAULT_BASE_URL = 'https://api.deepseek.com'
/** DSH 目录的 bootstrap 默认档(03-01 冒烟:`model/list` 中 deepseek-v4-pro 为默认档)。 */
export const DSH_DEFAULT_MODEL = 'deepseek-v4-pro'
export const DSH_DISPLAY_NAME = 'DeepSeek Harness'

/** 从 `[deepseek-harness]` 配置段即时构建 DSH source(本地单档语义:选择键就是
 *  配置段本身,与 session-model 的可见性门、dshEffortForSpawn 读同一事实源)。
 *  不经实例注册表 —— 注册表承载上游 `[token_source.*]` 多账号目录(面板/热更新/
 *  额度聚合);本地固定档位流程从不绑定注册表 source,spawn 与历史查询经本函数,
 *  保证「段配好即能跑」,不会出现面板可见、spawn 找不到 source 的空窗。 */
export function dshSourceFromConfig(section: DeepseekHarnessConfig | undefined = config.deepseek_harness): TokenSource {
  const factory = tokenSourceFactories().find(entry => entry.kind === 'deepseek-harness')
  if (!factory) throw new Error('deepseek-harness factory is not registered')
  return factory.build({ ...(section ?? {}) })
}

registerTokenSourceFactory({
  kind: 'deepseek-harness', configSectionId: 'deepseek-harness',
  build(cfg) {
    const apiKey = cfg.api_key?.trim() ?? ''
    const baseUrl = cfg.base_url?.trim() || DSH_DEFAULT_BASE_URL
    const url = new URL(baseUrl)
    // DSH owns the official endpoint for its native protocol (Chat Completions
    // in older runtimes, Messages in newer ones). Never overwrite that route
    // with the shared account's API root. Custom endpoints remain explicit.
    const nativeOfficialEndpoint = url.origin === 'https://api.deepseek.com'
      && !url.username && !url.password && !url.search && !url.hash
      && ['', '/v1', '/anthropic', '/anthropic/v1'].includes(url.pathname.replace(/\/+$/, ''))
    const source: TokenSource = {
      id: DSH_TOKEN_SOURCE_ID, kind: 'deepseek-harness', agent: 'dsh', display: cfg.display?.trim() || DSH_DISPLAY_NAME,
      enabled: !!apiKey, models: [], defaultModel: cfg.model?.trim() || DSH_DEFAULT_MODEL,
      modelCatalogState: { status: apiKey ? 'idle' : 'disabled', updatedAt: Date.now() },
      spawnEnv(base) {
        // 顺序与上游一致:先 scrub ANTHROPIC_*(防 Claude 档凭据夹带),再清
        // DSH_*/DEEPSEEK_*/LODESTAR_DSH_*(防调用方旧值残留成并集),最后才注入。
        const env = scrubDshEnv(base)
        if (!apiKey) throw new Error('DeepSeek Harness API key is missing')
        env.DEEPSEEK_API_KEY = apiKey
        if (!nativeOfficialEndpoint) env.DEEPSEEK_BASE_URL = baseUrl
        env.LODESTAR_DSH_PROVIDER = 'deepseek-official'
        if (cfg.bin) env.LODESTAR_DSH_NODE = cfg.bin
        return env
      },
      async refreshModels() {
        if (!source.enabled) { source.models = []; source.modelCatalogState = { status: 'disabled', updatedAt: Date.now() }; return }
        source.modelCatalogState = { status: 'loading', updatedAt: null }
        try {
          const catalog: DshModel[] = await queryDshRuntime({ cwd: DSH_HOME_DIR,
            env: source.spawnEnv(process.env), profile: { loadProjectMcp: false } }, 'model/list',
            { models: [...modelList(cfg.models), ...modelList(cfg.custom_models)] })
          if (!Array.isArray(catalog) || !catalog.length) throw new Error('DeepSeek Harness model catalog is empty')
          for (const entry of catalog) {
            if (!entry.model || !entry.efforts.length || !entry.efforts.every(isDshReasoningEffort)
              || !isDshReasoningEffort(entry.defaultEffort) || !entry.efforts.includes(entry.defaultEffort)) {
              throw new Error(`Invalid DSH model/effort catalog: ${entry.model}`)
            }
          }
          const defaultModel = cfg.model?.trim() || catalog.find(model => model.isDefault)?.model
          if (!defaultModel || !catalog.some(model => model.model === defaultModel)) throw new Error('DSH default model is not in its catalog')
          source.models = catalog.map(({ model, display, efforts, defaultEffort, isCustom }) => {
            const configured = cfg.effort?.trim()
            if (configured && (!isDshReasoningEffort(configured) || !efforts.includes(configured))) {
              throw new Error(`DSH model ${model} does not support configured effort ${configured}`)
            }
            return { model, display, efforts, defaultEffort: configured ? configured as typeof defaultEffort : defaultEffort,
              origin: isCustom ? 'custom' : 'upstream' }
          })
          source.defaultModel = defaultModel
          source.modelCatalogState = { status: 'ready', updatedAt: Date.now() }
        } catch (error) {
          source.models = []
          source.modelCatalogState = { status: 'failed', updatedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }
          throw error
        }
      },
      resolveSpawnModel(model) { return tokenSourceRuntimeModels(source).find(entry => entry.model === model)?.model },
      readUsage() { return apiKey ? fetchDeepseekBalance(baseUrl, apiKey) : Promise.resolve({ kind: 'balance', state: 'no_credentials', windows: [] }) },
    }
    return source
  },
  setup: {
    commandSuffix: 'deepseek-harness',
    hint: () => 'DeepSeek 账号由 Claude Code 和 DeepSeek Harness 共用。发送 `deepseek-setup <api_key>` 配置两边；`deepseek-harness-setup [base_url] <api_key>` 同样更新共享账号。',
    parseArgs(args) {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      if (parts.length < 1 || parts.length > 2 || /^https?:\/\//i.test(parts.at(-1)!)) return { error: '用法：deepseek-harness-setup [base_url] <api_key>' }
      return { config: { agent: 'dsh', api_key: parts.at(-1)!, ...(parts.length === 2 ? { base_url: parts[0] } : {}) } }
    },
    async validate(cfg) { await fetchDeepseekModelIds(cfg.base_url ?? 'https://api.deepseek.com', cfg.api_key ?? '') },
  },
})
