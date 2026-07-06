# Codex API 档位（`[codex.models.*]` 自定义 provider）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `config.toml` 新增 `[codex.models.<slug>]` 档位,让 lodestar 用 `codex app-server -c` 覆盖注入自定义 OpenAI 兼容 provider(base_url + wire_api + key + model),在飞书 `model` 面板按档位/按群切换 Codex 的 API 端点 —— 与 `[claude.models.*]` 的 GLM 路由同构;现有 `gpt-5.5` 登录/默认档位不变。

**Architecture:** 新增 `src/codex-models.ts`(镜像 `src/claude-models.ts`)集中解析 `[codex.models.*]` 档位、生成 spawn `-c` 覆盖与 env 注入。`session.spawnAgent()` 在 codex 分支把选中档位解析成 `{ modelId, configArgs, providerEnv }` 传给 `CodexProcess`;`CodexProcess` 构造器把 `configArgs` 拼进 app-server 命令行、把 `providerEnv` 叠进 spawn env。`session-model.ts` 把 config 驱动的 codex API 档位并进 picker,并复刻 GLM 的"未配置拦截"守卫。model key 用 `codex:<slug>`(不以 `claude:` 开头 → `providerFromModel` 仍归 'codex',无需改)。

**Tech Stack:** Bun(运行时/测试/构建,无 tsconfig,TS 由 bun 直接转译)、bun:test(测试用 `mock.module('./config', …)` 隔离真实配置,见 `src/claude-agent-process.test.ts:6`)。

**Spec:** `docs/superpowers/specs/2026-07-05-codex-api-models-design.md`(已批准)

## Global Constraints

- 现有 `gpt-5.5` 登录/默认档位**行为完全不变**:不注入 `-c`、不注入 key,继承用户全局 `~/.codex/config.toml`。
- `providerFromModel`(`src/agent-process.ts:27-29`)**不改** —— `codex:<slug>` 不以 `claude:` 开头,仍归 'codex'。
- lodestar 注入的 codex provider id 一律 `lodestar_<sanitized-slug>` 前缀,**绝不覆盖**用户全局 `[model_providers.*]`。
- 未配置的 API 档位(缺 base_url / key / model):picker 可见但 `onModelEffortSelect` 拦截,`normalizeFixedModelSelection` 回落 `gpt-5.5`(复刻 GLM 分支)。
- `-c` value 一律用 TOML 字符串字面量传(`base_url="https://…"`);经 argv 数组、不过 shell。
- 注释与错误信息风格跟随现有代码(中文注释、`❌`/`lodestar:` 前缀)。
- 现有测试必须原样全绿(不许改动既有用例);测试命令 `bun test`(先 `bun install`);构建 `bun run build`。

---

### Task 1: `[codex.models.*]` 配置解析 + `src/codex-models.ts` 档位解析（TDD)

**Files:**
- Modify: `src/config.ts:36-40`（`LodestarConfig.codex` 接口）、`src/config.ts:67-85`（在 `ClaudeModelConfig` 旁加 `CodexModelConfig`)、`src/config.ts:180-207`（加 `codexModelSections()`)、`src/config.ts:242-255`（`loadConfig()` 返回值)
- Create: `src/codex-models.ts`
- Test: `src/codex-models.test.ts`

**Interfaces:**
- Consumes: `config`(`src/config.ts` 导出单例)、`CODEX_EFFORT` / `isCodexReasoningEffort` / `type CodexReasoningEffort`（`src/codex-process.ts:83,85-87,77`)
- Produces:
  - `config.codex.models: Record<string, CodexModelConfig>`；`CodexModelConfig`（全 optional string:`display_name`/`description`/`model`/`base_url`/`wire_api`/`api_key`/`env_key`/`requires_openai_auth`/`route`/`effort`)
  - `src/codex-models.ts` 导出:`codexProviderSlug(slug):string`、`codexEnvKeyName(slug):string`、`codexEnvFromConfig(raw,slug):Record<string,string>`、`codexConfigArgs(raw,slug):string[]`、`toCodexProfile(slug,raw):CodexModelProfile|null`、`codexModelProfiles():CodexModelProfile[]`、`codexModelProfile(model):CodexModelProfile|null`、`codexModelIsApiRoute(model):boolean`、`codexModelConfigured(model):boolean`、`codexModelEffort(model):CodexReasoningEffort|undefined`、`resolveCodexModelId(model):string|undefined`、`codexSpawnOverrides(model):{modelId:string|undefined;configArgs:string[];env:Record<string,string>}`、`codexModelChoices():Array<{provider:'codex';model:string;displayName:string;description:string;effort:CodexReasoningEffort}>`、`interface CodexModelProfile`

- [ ] **Step 1: 写失败测试**

创建 `src/codex-models.test.ts`:

```ts
import { describe, expect, mock, test } from 'bun:test'

mock.module('./config', () => ({
  config: {
    codex: {
      env: {},
      models: {
        kimi: {
          display_name: 'Codex · Kimi',
          base_url: 'https://api.moonshot.cn/v1',
          wire_api: 'chat',
          api_key: 'sk-kimi',
          model: 'kimi-k2',
          effort: 'high',
        },
        // 缺 model → 未配置
        broken: { base_url: 'https://x.example.com', api_key: 'sk-x' },
        // 登录档(无 base_url)
        legacy: { model: 'gpt-5.5' },
      },
    },
    claude: { env: {}, models: {} },
  },
}))

const {
  codexProviderSlug,
  codexEnvKeyName,
  codexEnvFromConfig,
  codexConfigArgs,
  toCodexProfile,
  codexModelProfiles,
  codexModelProfile,
  codexModelIsApiRoute,
  codexModelConfigured,
  codexModelEffort,
  resolveCodexModelId,
  codexSpawnOverrides,
  codexModelChoices,
} = await import('./codex-models')

describe('codex model slug helpers', () => {
  test('provider slug is lodestar-prefixed and sanitized', () => {
    expect(codexProviderSlug('wuhen-ai')).toBe('lodestar_wuhen_ai')
  })
  test('env key name is uppercase sanitized', () => {
    expect(codexEnvKeyName('wuhen-ai')).toBe('LODESTAR_CODEX_WUHEN_AI_KEY')
  })
})

describe('codexConfigArgs', () => {
  test('builds -c overrides for provider + endpoint', () => {
    const args = codexConfigArgs(
      { base_url: 'https://api.moonshot.cn/v1', wire_api: 'chat', model: 'kimi-k2' },
      'kimi',
    )
    // flat ['-c','k=v', …];断言关键对存在
    expect(args).toContain('model_provider="lodestar_kimi"')
    expect(args).toContain('model_providers.lodestar_kimi.base_url="https://api.moonshot.cn/v1"')
    expect(args).toContain('model_providers.lodestar_kimi.wire_api="chat"')
    expect(args).toContain('model_providers.lodestar_kimi.env_key="LODESTAR_CODEX_KIMI_KEY"')
    // 每个 k=v 前面都跟一个 '-c'
    expect(args.filter(a => a === '-c').length).toBe((args.length) / 2)
  })
  test('adds requires_openai_auth when set', () => {
    const args = codexConfigArgs(
      { base_url: 'https://api.wuhen-ai.com', requires_openai_auth: 'true', model: 'gpt-5.5' },
      'wuhen',
    )
    expect(args).toContain('model_providers.lodestar_wuhen.requires_openai_auth=true')
  })
  test('defaults wire_api to chat', () => {
    const args = codexConfigArgs({ base_url: 'https://x' }, 'x')
    expect(args).toContain('model_providers.lodestar_x.wire_api="chat"')
  })
})

describe('codexEnvFromConfig', () => {
  test('injects api_key under generated env key', () => {
    expect(codexEnvFromConfig({ api_key: 'sk-1' }, 'kimi')).toEqual({ LODESTAR_CODEX_KIMI_KEY: 'sk-1' })
  })
  test('empty when no api_key (requires_openai_auth path)', () => {
    expect(codexEnvFromConfig({ requires_openai_auth: 'true' }, 'wuhen')).toEqual({})
  })
})

describe('toCodexProfile', () => {
  test('infers api route from base_url and computes configured', () => {
    const p = toCodexProfile('kimi', {
      base_url: 'https://api.moonshot.cn/v1', api_key: 'sk', model: 'kimi-k2',
    })!
    expect(p.key).toBe('codex:kimi')
    expect(p.route).toBe('api')
    expect(p.modelId).toBe('kimi-k2')
    expect(p.configured).toBe(true)
  })
  test('api route missing model is not configured', () => {
    const p = toCodexProfile('broken', { base_url: 'https://x', api_key: 'sk' })!
    expect(p.route).toBe('api')
    expect(p.configured).toBe(false)
  })
  test('login route (no base_url) is always configured with empty overrides', () => {
    const p = toCodexProfile('legacy', { model: 'gpt-5.5' })!
    expect(p.route).toBe('login')
    expect(p.configured).toBe(true)
    expect(p.configArgs).toEqual([])
    expect(p.env).toEqual({})
  })
  test('explicit route wins over inference', () => {
    const p = toCodexProfile('forced', { route: 'login', base_url: 'https://x' })!
    expect(p.route).toBe('login')
  })
})

describe('config-driven lookups', () => {
  test('codexModelProfile resolves by codex: key', () => {
    expect(codexModelProfile('codex:kimi')?.modelId).toBe('kimi-k2')
    expect(codexModelProfile('gpt-5.5')).toBeNull()
  })
  test('codexModelIsApiRoute / codexModelConfigured', () => {
    expect(codexModelIsApiRoute('codex:kimi')).toBe(true)
    expect(codexModelConfigured('codex:kimi')).toBe(true)
    expect(codexModelConfigured('codex:broken')).toBe(false)
    expect(codexModelConfigured('gpt-5.5')).toBe(true) // 未知 key 当就绪
  })
  test('codexModelEffort reads per-slot effort', () => {
    expect(codexModelEffort('codex:kimi')).toBe('high')
  })
  test('resolveCodexModelId maps codex: key to real id; bare id unchanged', () => {
    expect(resolveCodexModelId('codex:kimi')).toBe('kimi-k2')
    expect(resolveCodexModelId('gpt-5.5')).toBe('gpt-5.5')
  })
  test('codexSpawnOverrides: api slot carries args+env; login empty', () => {
    const api = codexSpawnOverrides('codex:kimi')
    expect(api.modelId).toBe('kimi-k2')
    expect(api.env).toEqual({ LODESTAR_CODEX_KIMI_KEY: 'sk-kimi' })
    expect(api.configArgs.length).toBeGreaterThan(0)
    const login = codexSpawnOverrides('gpt-5.5')
    expect(login).toEqual({ modelId: 'gpt-5.5', configArgs: [], env: {} })
  })
  test('codexModelChoices lists only api slots (incl unconfigured)', () => {
    const choices = codexModelChoices()
    const models = choices.map(c => c.model).sort()
    expect(models).toEqual(['codex:broken', 'codex:kimi'])
    expect(choices.find(c => c.model === 'codex:kimi')!.effort).toBe('high')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/codex-models.test.ts`
Expected: FAIL —— `Cannot find module './codex-models'`(文件还没建)。

- [ ] **Step 3: 改 `src/config.ts` — 加 `CodexModelConfig` 接口**

在 `ClaudeModelConfig` 接口结束（第 85 行 `}`）之后插入:

```ts

/** 第三方 Codex provider(OpenAI 兼容端点)接入配置,对应 `[codex.models.<slug>]`。
 * 配了 base_url 即视为 API 路由:spawn 时用 `codex app-server -c` 覆盖注入一个
 * `lodestar_<slug>` provider,并把 api_key 注入 env。都不配 = 登录档,继承用户
 * 全局 `~/.codex/config.toml`。见 src/codex-models.ts。 */
export interface CodexModelConfig {
  display_name?: string
  description?: string
  model?: string
  base_url?: string
  /** `chat` | `responses`;缺省 `chat`。第三方 OpenAI 兼容端点多用 chat。 */
  wire_api?: string
  api_key?: string
  /** 覆盖装 key 的环境变量名(缺省 lodestar 生成 LODESTAR_CODEX_<SLUG>_KEY)。 */
  env_key?: string
  /** 走 codex 的 OpenAI auth(如无痕 wuhen);置 "true" 时可不配 api_key。 */
  requires_openai_auth?: string
  /** 显式声明路由;缺省由是否配了 base_url 推断。 */
  route?: 'login' | 'api'
  /** 该档位锁定的思考强度(none|minimal|low|medium|high|xhigh);缺省回落 xhigh。 */
  effort?: string
}
```

- [ ] **Step 4: 改 `src/config.ts` — `LodestarConfig.codex` 接口**

`LodestarConfig` 的 `codex` 字段(第 36-40 行)替换为:

```ts
  /** Env vars injected into the spawned `codex app-server` subprocess.
   * Empty record = no injection; Codex uses the user's ChatGPT login. */
  codex: {
    env: Record<string, string>
    /** Per-slot 第三方 provider 档位,对应 `[codex.models.<slug>]`。空 record =
     * 只有内建 gpt-5.5 登录/默认档。见 src/codex-models.ts。 */
    models: Record<string, CodexModelConfig>
  }
```

- [ ] **Step 5: 改 `src/config.ts` — 加 `codexModelSections()` 并接进返回值**

在 `claudeModelSections()` 定义结束(第 207 行 `}`,即 `return out` 后的收尾 `}`)之后插入(与 claudeModelSections 同构,只换 prefix 与字段白名单):

```ts
  const codexModelSections = (): Record<string, CodexModelConfig> => {
    const out: Record<string, CodexModelConfig> = {}
    const prefix = 'codex.models.'
    for (const [sectionName, section] of Object.entries(t)) {
      if (!sectionName.startsWith(prefix)) continue
      const key = sectionName.slice(prefix.length).trim()
      if (!key) continue
      const profile: CodexModelConfig = {}
      for (const [rawKey, value] of Object.entries(section)) {
        if (typeof value !== 'string' || value.length === 0) continue
        const field = rawKey.trim()
        if (
          field === 'display_name' ||
          field === 'description' ||
          field === 'model' ||
          field === 'base_url' ||
          field === 'wire_api' ||
          field === 'api_key' ||
          field === 'env_key' ||
          field === 'requires_openai_auth' ||
          field === 'route' ||
          field === 'effort'
        ) {
          ;(profile as Record<string, string>)[field] = value
        }
      }
      out[key] = profile
    }
    return out
  }
```

`loadConfig()` 返回值里 `codex: { env: codexEnv }`(第 246 行)替换为:

```ts
    codex: { env: codexEnv, models: codexModelSections() },
```

- [ ] **Step 6: 创建 `src/codex-models.ts`**

```ts
import { config, type CodexModelConfig } from './config'
import { CODEX_EFFORT, isCodexReasoningEffort, type CodexReasoningEffort } from './codex-process'

export interface CodexModelProfile {
  key: string            // 'codex:<slug>'
  name: string           // 原始 slug
  displayName: string
  description: string
  /** 发给 app-server thread/start 的真实模型 id。 */
  modelId: string
  route: 'login' | 'api'
  /** lodestar 注入的 provider id(model_provider 覆盖值);login 恒 ''。 */
  providerSlug: string
  /** spawn 注入的 env(装 key);login / 无 api_key 时为空。 */
  env: Record<string, string>
  /** spawn 追加的 `-c` 覆盖对(flat: '-c','k=v',…);login 恒 []。 */
  configArgs: string[]
  /** login 恒 true;api 需 base_url +(api_key 或 requires_openai_auth)+ model。 */
  configured: boolean
}

const DEFAULT_WIRE_API = 'chat'

/** slug 归一为合法的 provider id / env 片段:非 [A-Za-z0-9_] → '_'。 */
function sanitizeSlug(slug: string): string {
  return slug.trim().replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'slot'
}

/** lodestar 注入的 codex provider id,前缀隔离用户全局 [model_providers.*]。 */
export function codexProviderSlug(slug: string): string {
  return `lodestar_${sanitizeSlug(slug)}`
}

/** 装 api_key 的环境变量名。 */
export function codexEnvKeyName(slug: string): string {
  return `LODESTAR_CODEX_${sanitizeSlug(slug).toUpperCase()}_KEY`
}

function wireApiOf(raw: CodexModelConfig): string {
  const w = raw.wire_api?.trim()
  return w === 'responses' || w === 'chat' ? w : DEFAULT_WIRE_API
}

function requiresOpenaiAuth(raw: CodexModelConfig): boolean {
  return raw.requires_openai_auth?.trim() === 'true'
}

/** api_key → { envKey: key };没配(靠 requires_openai_auth)→ {}。 */
export function codexEnvFromConfig(raw: CodexModelConfig, slug: string): Record<string, string> {
  const key = raw.api_key?.trim()
  if (!key) return {}
  const envKey = raw.env_key?.trim() || codexEnvKeyName(slug)
  return { [envKey]: key }
}

/** 该档位追加的 `-c` 覆盖对(flat 数组:'-c','k=v','-c','k=v',…)。 */
export function codexConfigArgs(raw: CodexModelConfig, slug: string): string[] {
  const provider = codexProviderSlug(slug)
  const base = `model_providers.${provider}`
  const envKey = raw.env_key?.trim() || codexEnvKeyName(slug)
  const args: string[] = [
    '-c', `model_provider="${provider}"`,
    '-c', `${base}.name="${sanitizeSlug(slug)}"`,
  ]
  const baseUrl = raw.base_url?.trim()
  if (baseUrl) args.push('-c', `${base}.base_url="${baseUrl}"`)
  args.push('-c', `${base}.wire_api="${wireApiOf(raw)}"`)
  args.push('-c', `${base}.env_key="${envKey}"`)
  if (requiresOpenaiAuth(raw)) args.push('-c', `${base}.requires_openai_auth=true`)
  return args
}

function routeOf(raw: CodexModelConfig): 'login' | 'api' {
  if (raw.route === 'api' || raw.route === 'login') return raw.route
  return raw.base_url?.trim() ? 'api' : 'login'
}

export function toCodexProfile(slug: string, raw: CodexModelConfig): CodexModelProfile | null {
  const name = slug.trim()
  if (!name) return null
  const route = routeOf(raw)
  const modelId = raw.model?.trim() || ''
  const env = route === 'api' ? codexEnvFromConfig(raw, slug) : {}
  const configArgs = route === 'api' ? codexConfigArgs(raw, slug) : []
  const configured =
    route === 'login' ||
    (!!raw.base_url?.trim() &&
      (!!raw.api_key?.trim() || requiresOpenaiAuth(raw)) &&
      !!modelId)
  return {
    key: `codex:${name}`,
    name,
    displayName: raw.display_name?.trim() || `Codex · ${name}`,
    description: raw.description?.trim() || `使用 ${name} 路由运行 Codex 后端。`,
    modelId,
    route,
    providerSlug: route === 'api' ? codexProviderSlug(slug) : '',
    env,
    configArgs,
    configured,
  }
}

export function codexModelProfiles(): CodexModelProfile[] {
  return Object.entries(config.codex.models)
    .map(([slug, raw]) => toCodexProfile(slug, raw))
    .filter((p): p is CodexModelProfile => p !== null)
}

export function codexModelProfile(model: string | null | undefined): CodexModelProfile | null {
  if (!model?.startsWith('codex:')) return null
  const name = model.slice('codex:'.length)
  if (!name) return null
  return codexModelProfiles().find(p => p.name === name || p.key === model) ?? null
}

/** 该档位是否第三方 API 路由(true = spawn 时注入 provider + key)。 */
export function codexModelIsApiRoute(model: string | null | undefined): boolean {
  return codexModelProfile(model)?.route === 'api'
}

/** 该档位是否可用:登录/未知档恒 true;API 路由需 base_url + key + model 配好。 */
export function codexModelConfigured(model: string | null | undefined): boolean {
  const p = codexModelProfile(model)
  return p ? p.configured : true
}

/** 该档位 config 声明的 effort(仅 API 路由);非法/未配 → undefined。 */
export function codexModelEffort(model: string | null | undefined): CodexReasoningEffort | undefined {
  const p = codexModelProfile(model)
  if (!p || p.route !== 'api') return undefined
  const raw = config.codex.models[p.name]?.effort?.trim()
  return raw && isCodexReasoningEffort(raw) ? raw : undefined
}

/** codex:<slug> → 真实 modelId;非档位 key(裸 gpt-5.5)原样;未知 codex: → undefined。 */
export function resolveCodexModelId(model: string | null | undefined): string | undefined {
  const p = codexModelProfile(model)
  if (p) return p.modelId || undefined
  if (model?.startsWith('codex:')) return undefined
  return model ?? undefined
}

/** spawn 时的 codex provider 覆盖。登录/未知档 → 空覆盖 + 原样 modelId,
 * 绝不误伤现有 gpt-5.5。 */
export function codexSpawnOverrides(model: string | null | undefined): {
  modelId: string | undefined
  configArgs: string[]
  env: Record<string, string>
} {
  const p = codexModelProfile(model)
  if (!p || p.route === 'login') {
    return { modelId: resolveCodexModelId(model), configArgs: [], env: {} }
  }
  return { modelId: p.modelId || undefined, configArgs: p.configArgs, env: p.env }
}

/** picker 用:每个配好的 codex API 档位一个选项(含未配置的,选择时再拦截)。 */
export function codexModelChoices(): Array<{
  provider: 'codex'
  model: string
  displayName: string
  description: string
  effort: CodexReasoningEffort
}> {
  return codexModelProfiles()
    .filter(p => p.route === 'api')
    .map(p => ({
      provider: 'codex' as const,
      model: p.key,
      displayName: p.displayName,
      description: p.description,
      effort: codexModelEffort(p.key) ?? CODEX_EFFORT,
    }))
}
```

- [ ] **Step 7: 跑测试确认通过**

Run: `bun test src/codex-models.test.ts`
Expected: 全部 pass(约 15 个用例)。

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/codex-models.ts src/codex-models.test.ts
git commit -m "feat(codex): [codex.models.*] 档位解析 + provider 覆盖生成"
```

---

### Task 2: `CodexProcess` spawn 消费 provider 覆盖（TDD)

**Files:**
- Modify: `src/codex-process.ts:69-75`（`SpawnOpts`)、`src/codex-process.ts:258-271`（构造器 args + env）
- Test: `src/codex-process.test.ts`（在文件末尾追加一个 describe)

**Interfaces:**
- Consumes: `SpawnOpts.configArgs` / `SpawnOpts.providerEnv`（Task 3 的 `session.spawnAgent()` 提供,来自 `codexSpawnOverrides`)
- Produces: `buildCodexAppServerArgs(configArgs:string[]):string[]`（导出纯函数,拼 app-server 命令行);构造器把 `configArgs` 插进 args、`providerEnv` 叠进 env

- [ ] **Step 1: 写失败测试**

在 `src/codex-process.test.ts` 顶部 import 块（第 6-13 行 `import { … } from './codex-process'`)加入 `buildCodexAppServerArgs`:

```ts
import {
  buildCodexAppServerArgs,
  diffUsageTotals,
  effectiveTurnTokens,
  contextCompactionNoticeFromMessage,
  contextCompactionNoticeFromNotification,
  CodexProcess,
  imageGenerationOutput,
  usageFromTokenUsagePayload,
} from './codex-process'
```

在文件末尾追加:

```ts
describe('buildCodexAppServerArgs', () => {
  test('no overrides → bare app-server on stdio', () => {
    expect(buildCodexAppServerArgs([])).toEqual(['app-server', '--listen', 'stdio://'])
  })
  test('inserts -c overrides before --listen', () => {
    const args = buildCodexAppServerArgs(['-c', 'model_provider="lodestar_kimi"'])
    expect(args).toEqual([
      'app-server',
      '-c', 'model_provider="lodestar_kimi"',
      '--listen', 'stdio://',
    ])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/codex-process.test.ts`
Expected: FAIL —— `buildCodexAppServerArgs` 未导出(`SyntaxError`/`undefined`)。

- [ ] **Step 3: 改 `src/codex-process.ts` — `SpawnOpts`**

`SpawnOpts` 接口(第 69-75 行)替换为:

```ts
export interface SpawnOpts {
  workDir: string
  resumeSessionId?: string
  model?: string
  effort: CodexReasoningEffort
  appendSystemPrompt?: string
  /** 追加到 `codex app-server` 命令行的 `-c` 覆盖对(flat:'-c','k=v',…),
   * 由 codex API 档位注入自定义 provider。缺省 = 无覆盖(登录/默认档)。 */
  configArgs?: string[]
  /** 叠加进 spawn env 的 provider 接入变量(装 api_key)。缺省 = 无注入。 */
  providerEnv?: Record<string, string>
}
```

- [ ] **Step 4: 改 `src/codex-process.ts` — 加 `buildCodexAppServerArgs` 并用于构造器**

在 `resolveCodexBin()` 定义之前(第 30 行 `export function resolveCodexBin(): string {` 之上)插入导出纯函数:

```ts
/** 拼 `codex app-server` 命令行:把 provider 覆盖 `-c` 对插在 `--listen` 之前。 */
export function buildCodexAppServerArgs(configArgs: string[] = []): string[] {
  return ['app-server', ...configArgs, '--listen', 'stdio://']
}

```

构造器里(第 259 行)`const args = ['app-server', '--listen', 'stdio://']` 替换为:

```ts
    const args = buildCodexAppServerArgs(opts.configArgs)
```

spawn 的 env 块(第 265-270 行)在 `...config.codex.env,` 之后加一行:

```ts
      env: {
        ...(process.env as Record<string, string>),
        NPM_CONFIG_LOGLEVEL: 'error',
        PATH: buildSpawnPath(),
        ...config.codex.env,
        ...(opts.providerEnv ?? {}),
      },
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test src/codex-process.test.ts`
Expected: 全绿(既有用例 + 2 个新增)。

- [ ] **Step 6: Commit**

```bash
git add src/codex-process.ts src/codex-process.test.ts
git commit -m "feat(codex): CodexProcess spawn 消费 configArgs/providerEnv 注入自定义 provider"
```

---

### Task 3: session 接线 —— picker 档位 + spawn 覆盖 + 守卫（TDD 覆盖归一化)

**Files:**
- Modify: `src/session.ts`（import 区、`spawnAgent()` codex 分支 `:510-516`、登录预检 `:698`)
- Modify: `src/session-model.ts`（import `:1-17`、`resolvedEffort` `:73-79`、`normalizeFixedModelSelection` `:88-105`、`configuredDefaultSelection` `:113-124`、`choiceDescription` `:127-132`、`fixedModelChoices` `:134-156`、`onModelEffortSelect` `:239-250`)
- Test: `src/session.test.ts`（追加 `normalizeFixedModelSelection` / `configuredDefaultSelection` 的 codex 档位用例 —— 用该文件既有的"原地改 `config` 单例 + finally 还原"模式,配合 `./feishu-test-mock`;**不要**在 `mock.module('./config')` 的 `codex-models.test.ts` 里 import `./session-model`,那会拖入 feishu 依赖图并在 import 期崩)

**Interfaces:**
- Consumes: Task 1 的 `codexSpawnOverrides` / `codexModelChoices` / `codexModelConfigured` / `codexModelIsApiRoute` / `codexModelEffort`；Task 2 的 `CodexProcess` 新 SpawnOpts
- Produces: picker 含 codex API 档位;选中 API 档位时 `CodexProcess` 收到 `configArgs`/`providerEnv`;未配置 API 档位被拦截/归一化到 `gpt-5.5`

- [ ] **Step 1: 写失败测试（归一化 + 默认档,放 session.test.ts)**

在 `src/session.test.ts` 的 `describe('configuredDefaultSelection ([claude] default_model)', …)` 块(约第 341 行)**之后**插入两个新 describe。沿用该文件既有的"存 prev → 原地改 `config` 单例 → `finally` 还原"模式(不新增 import,`config` / `normalizeFixedModelSelection` / `configuredDefaultSelection` 均已在文件顶部导入):

```ts
describe('normalizeFixedModelSelection ([codex.models.*] api 档位)', () => {
  test('配好的 codex api 档位保留 + 跟随 config effort', () => {
    const prev = config.codex.models
    ;(config.codex as any).models = {
      kimi: { base_url: 'https://api.moonshot.cn/v1', api_key: 'sk', model: 'kimi-k2', effort: 'high' },
    }
    try {
      expect(normalizeFixedModelSelection('codex', 'codex:kimi', null)).toEqual({ model: 'codex:kimi', effort: 'high' })
    } finally {
      ;(config.codex as any).models = prev
    }
  })

  test('未配置的 codex api 档位(缺 model)回落 gpt-5.5/xhigh', () => {
    const prev = config.codex.models
    ;(config.codex as any).models = { broken: { base_url: 'https://x', api_key: 'sk' } }
    try {
      const r = normalizeFixedModelSelection('codex', 'codex:broken', null)
      expect(r.model).toBe('gpt-5.5')
      expect(r.effort).toBe('xhigh')
    } finally {
      ;(config.codex as any).models = prev
    }
  })

  test('裸 gpt-5.5 保持登录默认档', () => {
    expect(normalizeFixedModelSelection('codex', 'gpt-5.5', null).model).toBe('gpt-5.5')
  })
})

describe('configuredDefaultSelection ([codex] api 档位)', () => {
  test('default_model="codex:kimi" + 配好 → 默认档位 codex:kimi(effort 跟随 config)', () => {
    const prevModels = config.codex.models
    const prevDefault = config.claude.defaultModel
    ;(config.codex as any).models = {
      kimi: { base_url: 'https://api.moonshot.cn/v1', api_key: 'sk', model: 'kimi-k2', effort: 'high' },
    }
    ;(config.claude as any).defaultModel = 'codex:kimi'
    try {
      expect(configuredDefaultSelection()).toEqual({ provider: 'codex', model: 'codex:kimi', effort: 'high' })
    } finally {
      ;(config.codex as any).models = prevModels
      ;(config.claude as any).defaultModel = prevDefault
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/session.test.ts`
Expected: FAIL —— `codex:kimi` 未命中(当前 `normalizeFixedModelSelection` / `configuredDefaultSelection` 只查 `FIXED_MODEL_CHOICES`)→ `codex:kimi` 归一化回落 `gpt-5.5`、`configuredDefaultSelection()` 返回 null,新用例断言不等。

- [ ] **Step 3: 改 `src/session-model.ts` — import**

第 15 行 `import { claudeModelConfigured, claudeModelEffort, claudeModelIsApiRoute } from './claude-models'` 之后加一行:

```ts
import {
  codexModelChoices,
  codexModelConfigured,
  codexModelEffort,
  codexModelIsApiRoute,
} from './codex-models'
```

- [ ] **Step 4: 改 `src/session-model.ts` — `resolvedEffort` 加 codex 分支**

`resolvedEffort`(第 73-79 行)替换为:

```ts
function resolvedEffort(item: typeof FIXED_MODEL_CHOICES[number]): AgentReasoningEffort {
  if (item.provider === 'claude') {
    const configured = claudeModelEffort(item.model)
    if (configured) return configured
  }
  if (item.provider === 'codex') {
    const configured = codexModelEffort(item.model)
    if (configured) return configured
  }
  return item.effort
}
```

- [ ] **Step 5: 改 `src/session-model.ts` — `normalizeFixedModelSelection` 认 codex api 档位**

`normalizeFixedModelSelection`(第 88-105 行)替换为:

```ts
export function normalizeFixedModelSelection(
  provider: AgentProvider,
  model: string | null | undefined,
  _effort: AgentReasoningEffort | null | undefined,
): { model: string; effort: AgentReasoningEffort } {
  const all = [...FIXED_MODEL_CHOICES, ...codexModelChoices()]
  const hit = all.find(c => c.provider === provider && c.model === model)
  // 第三方 API 路由(claude GLM / codex 自定义 provider)持久化了但当前未配置 →
  // 回落到该 provider 的登录默认档(claude→claude:fable,codex→gpt-5.5)。否则
  // restore 会以未鉴权状态拉起该档位:既跑不通,又绕过 picker 的配置门槛。
  const unconfiguredApiRoute =
    (provider === 'claude' && claudeModelIsApiRoute(model) && !claudeModelConfigured(model)) ||
    (provider === 'codex' && codexModelIsApiRoute(model) && !codexModelConfigured(model))
  if (hit && unconfiguredApiRoute) {
    const fallback = defaultFixedChoiceFor(provider)
    return { model: fallback.model, effort: resolvedEffort(fallback) }
  }
  const choice = hit ?? defaultFixedChoiceFor(provider)
  return { model: choice.model, effort: resolvedEffort(choice) }
}
```

- [ ] **Step 6: 改 `src/session-model.ts` — `configuredDefaultSelection` 认 `codex:` 前缀**

`configuredDefaultSelection`(第 113-124 行)函数体替换为:

```ts
export function configuredDefaultSelection(): {
  provider: AgentProvider
  model: string
  effort: AgentReasoningEffort
} | null {
  const raw = config.claude.defaultModel?.trim()
  if (!raw) return null
  const wanted = raw.startsWith('claude:') || raw.startsWith('codex:') || raw === 'gpt-5.5'
    ? raw
    : `claude:${raw}`
  const hit = [...FIXED_MODEL_CHOICES, ...codexModelChoices()].find(c => c.model === wanted)
  if (!hit) return null
  return { provider: hit.provider, model: hit.model, effort: resolvedEffort(hit) }
}
```

- [ ] **Step 7: 改 `src/session-model.ts` — `choiceDescription` 加 codex 未配置提示**

`choiceDescription`(第 127-132 行)替换为:

```ts
function choiceDescription(item: typeof FIXED_MODEL_CHOICES[number]): string {
  if (item.provider === 'claude' && claudeModelIsApiRoute(item.model) && !claudeModelConfigured(item.model)) {
    return `${item.description}(未配置 · 需在 config.toml 的 [claude.models.glm] 填 base_url + auth_token + model)`
  }
  if (item.provider === 'codex' && codexModelIsApiRoute(item.model) && !codexModelConfigured(item.model)) {
    return `${item.description}(未配置 · 需在 config.toml 的 [codex.models.<slug>] 填 base_url + api_key + model)`
  }
  return item.description
}
```

- [ ] **Step 8: 改 `src/session-model.ts` — `fixedModelChoices` 并入 codex 档位**

`fixedModelChoices`(第 134-156 行)函数体第一行 `const currentProvider = …` 之前不变,把 `return FIXED_MODEL_CHOICES.map(item => {` 改为对合并数组 map:

```ts
export function fixedModelChoices(s: Session): cards.ModelChoice[] {
  const currentProvider = s.currentProvider()
  const currentModel = s.currentModelLabel()
  const currentEffort = s.currentEffortLabel()
  return [...FIXED_MODEL_CHOICES, ...codexModelChoices()].map(item => {
    const selected = currentProvider === item.provider && currentModel === item.model
    const effort = resolvedEffort(item)
    return {
      provider: item.provider,
      model: item.model,
      displayName: item.displayName,
      description: choiceDescription(item),
      isDefault: false,
      selected,
      efforts: [{
        effort,
        description: '',
        isDefault: true,
        selected: selected && currentEffort === effort,
      }],
    }
  })
}
```

- [ ] **Step 9: 改 `src/session-model.ts` — `onModelEffortSelect` 校验并入 codex + 未配置拦截**

`onModelEffortSelect` 里第 239 行 `const fixed = FIXED_MODEL_CHOICES.find(c => c.provider === provider && c.model === model)` 替换为:

```ts
  const fixed = [...FIXED_MODEL_CHOICES, ...codexModelChoices()]
    .find(c => c.provider === provider && c.model === model)
```

紧接其后的 GLM 未配置守卫(第 245-250 行 `if (provider === 'claude' && …)` 整个 if 块)之后插入 codex 版守卫:

```ts
  if (provider === 'codex' && codexModelIsApiRoute(model) && !codexModelConfigured(model)) {
    return {
      ok: false,
      message: `Codex API 档位(${model})未配置:请在 ~/.config/lodestar/config.toml 的 [codex.models.<slug>] 填写 base_url、api_key(或 requires_openai_auth)和 model 后重试(内建 gpt-5.5 走全局 codex 配置,无需配置)`,
    }
  }
```

- [ ] **Step 10: 改 `src/session.ts` — import + `spawnAgent()` codex 分支**

在 session.ts 顶部 import 区找到从 `./session-model` 或其它引入 claude-models 的位置附近,新增(若已有 `./codex-models` import 则合并):

```ts
import { codexModelIsApiRoute, codexSpawnOverrides } from './codex-models'
```

`spawnAgent()` 的 codex 分支(第 510-516 行 `return new CodexProcess({ … })`)替换为:

```ts
    const overrides = codexSpawnOverrides(this.modelForSpawn())
    return new CodexProcess({
      workDir: this.workDir,
      model: overrides.modelId,
      effort: this.effortForSpawn(),
      resumeSessionId,
      appendSystemPrompt: this.spawnDeveloperInstructions(),
      configArgs: overrides.configArgs,
      providerEnv: overrides.env,
    })
```

- [ ] **Step 11: 改 `src/session.ts` — API 档位跳过 ChatGPT 登录预检**

登录预检(第 698 行)替换为:

```ts
    if (
      this.selectedProvider === 'codex' &&
      !codexModelIsApiRoute(this.selectedModel) &&
      !feishu.isOpenAIChatGPTAuthenticated()
    ) {
```

- [ ] **Step 12: 跑测试**

Run: `bun test src/session.test.ts`
Expected: 归一化 + 默认档共 4 个新用例全绿(其余既有用例不受影响)。

- [ ] **Step 13: 跑全量测试**

Run: `bun test`
Expected: 全部 pass, 0 fail(基线:改动前 `bun test` 全绿;若基线本身有 fail 需先停下报告)。

- [ ] **Step 14: 构建验证**

Run: `bun run build`
Expected: daemon / setup / stop / update / version 五个 bundle 全部成功,无 TS 报错。

- [ ] **Step 15: Commit**

```bash
git add src/session.ts src/session-model.ts src/codex-models.test.ts
git commit -m "feat(codex): model 面板并入 codex API 档位 + spawn 覆盖 + 未配置守卫"
```

---

### Task 4: 文档（README + backend memo)

**Files:**
- Modify: `README.md`（在 Claude 模型档位/自定义可执行文件相关小节附近插入 codex 档位说明)
- Modify: `docs/claude-agent-backend.md`（末尾或 Codex Parity 段落附近补一段 codex API 档位说明)

**Interfaces:**
- Consumes: Task 1-3 的配置键(`[codex.models.*]`)与行为
- Produces: 无代码接口,仅文档

- [ ] **Step 1: README 新增小节**

在 `README.md` 里 Claude 模型/`[claude.models.*]` 相关小节之后(用编辑器搜 `[claude.models` 定位,插在该小节结尾、下一个 `###` 之前,前后各留一个空行)插入:

````markdown
### 🧩 Codex API 档位(自定义 provider)

默认 `Codex · GPT-5.5` 档位继承用户全局 `~/.codex/config.toml`(`model_provider` 指向哪就走哪)。要在飞书 `model` 面板里按档位/按群切换 Codex 的第三方 OpenAI 兼容端点,在 `config.toml` 加 `[codex.models.<slug>]`:

```toml
# 第三方 OpenAI 兼容端点(自带 key)
[codex.models.kimi]
display_name = "Codex · Kimi"
base_url     = "https://api.moonshot.cn/v1"
wire_api     = "chat"          # chat | responses,默认 chat
api_key      = "sk-..."
model        = "kimi-k2"
effort       = "high"          # none|minimal|low|medium|high|xhigh,默认回落 xhigh

# 走 codex OpenAI auth 的端点(无需 api_key)
[codex.models.wuhen]
base_url     = "https://api.wuhen-ai.com"
wire_api     = "responses"
model        = "gpt-5.5"
requires_openai_auth = "true"
```

配好后面板出现 `codex:<slug>` 档位。lodestar spawn 时用 `codex app-server -c model_provider="lodestar_<slug>" …` 注入一个前缀隔离的 provider,并把 `api_key` 注入 env —— **不改你全局 `~/.codex/config.toml`,也不覆盖你已有的 `[model_providers.*]`**。缺 `base_url` / `api_key` / `model` 的档位在面板可见但选择被拦截。API 档位跳过 `codex login` 的 ChatGPT 登录检查(用 key 鉴权)。

> 已知限制(Windows):macOS/Linux 下 codex 以离散 argv 直接 spawn(不过 shell),`-c` 的 TOML 字面量精确传入;但 Windows 为兼容 `.cmd`/`.bat` shim 走 `shell:true`,`-c model_providers.<slug>.base_url="…"` 里的引号可能被 cmd.exe 处理。Windows 用户如遇自定义 provider 不生效,可改用全局 `~/.codex/config.toml` 配置。
````

- [ ] **Step 2: backend memo 补充 codex 档位说明**

在 `docs/claude-agent-backend.md` 末尾追加一节:

```markdown
## Codex API 档位（`[codex.models.*]`)

Codex 侧的 per-slot API 路由,与 `[claude.models.*]` 同构(见 `src/codex-models.ts`)。每个 `[codex.models.<slug>]` 声明一个第三方 OpenAI 兼容端点(`base_url` / `wire_api` / `api_key` 或 `requires_openai_auth` / `model` / `effort`)。飞书面板出现 `codex:<slug>` 档位;`session.spawnAgent()` 经 `codexSpawnOverrides()` 把它解析为 `codex app-server -c model_provider="lodestar_<slug>" -c model_providers.lodestar_<slug>.*=…` 覆盖 + `LODESTAR_CODEX_<SLUG>_KEY` env 注入。`model_provider` 用 `lodestar_<slug>` 前缀隔离用户全局 `[model_providers.*]`;thread/start 的 `model` 是档位声明的真实模型 id(非 `codex:<slug>` 路由 key)。内建 `gpt-5.5` 是登录/默认档,不注入任何覆盖、继承用户全局 `~/.codex/config.toml`。未配置的 API 档位在 `onModelEffortSelect`/`normalizeFixedModelSelection` 被拦截/回落 `gpt-5.5`(复刻 GLM 守卫);API 档位在 `start()` 跳过 `isOpenAIChatGPTAuthenticated()` 预检。
```

- [ ] **Step 3: 构建验证(无代码变更,确认文档不破坏构建)**

Run: `bun run build`
Expected: 五个 bundle 成功。

- [ ] **Step 4: Commit**

```bash
git add README.md docs/claude-agent-backend.md
git commit -m "docs: [codex.models.*] 自定义 provider 档位说明"
```

---

### Task 5: 手工验收（真实第三方端点,需人工)

**Files:** 无代码改动;操作 `~/.config/lodestar/config.toml`(或 `$LODESTAR_CONFIG` 指向的文件)

**Interfaces:**
- Consumes: Task 1-3 的运行时行为

前置已实测事实(2026-07-05,codex-cli 0.142.5):`codex app-server` 支持 `-c key=value` 覆盖(见 spec)。

- [ ] **Step 1: 配置** — `config.toml` 加一个真实可达端点,例如:

```toml
[codex.models.kimi]
display_name = "Codex · Kimi"
base_url     = "https://api.moonshot.cn/v1"
wire_api     = "chat"
api_key      = "sk-<真实 key>"
model        = "kimi-k2"
effort       = "high"
```

- [ ] **Step 2: 重启 daemon** — 按记忆中的重启方式(`perl setsid` 延迟脚本,见项目记忆 lodestar-daemon-restart);不要在同会话 `stop && start`。

- [ ] **Step 3: 验证 picker** — 飞书群发 `model`,面板应出现 `Codex · Kimi`;未配置端点则显示"(未配置 …)"后缀。

- [ ] **Step 4: 验证 spawn** — 选中 `Codex · Kimi` 后发一条消息,daemon 日志应出现
`codex-process: spawn … app-server`,且进程 args 含 `-c model_provider="lodestar_kimi"`(可临时在 `spawn` 前 `log(args.join(' '))` 验证,或用 `ps` 看命令行);回包正常。

- [ ] **Step 5: 验证隔离** — `~/.codex/config.toml` 的 `model_provider` / `[model_providers.custom]` 保持原样未被改写;切回 `Codex · GPT-5.5` 仍走全局配置。

- [ ] **Step 6: 验证未配置拦截** — 加一个只写 `base_url` 缺 `model` 的档位,`model` 面板可见但点选返回"未配置"提示;归一化后重启不会把 session 带到该档位。
