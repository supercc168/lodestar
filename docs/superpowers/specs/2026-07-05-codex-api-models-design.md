# 设计:Codex API 档位（`[codex.models.*]` 自定义 provider）

日期:2026-07-05
状态:已批准,待实现

## 背景

lodestar 有两个后端 provider:`CodexProcess`（`codex app-server` 子进程,JSON-RPC）
和 `ClaudeAgentProcess`（`@anthropic-ai/claude-agent-sdk`)。Claude 侧已经有完整的
**per-slot API 路由**系统:`[claude.models.glm]` 配 `base_url` / `auth_token` / `model` /
`effort`,spawn 时按档位注入 `ANTHROPIC_*` env 直连第三方端点(见
`src/claude-models.ts`、`docs/claude-agent-backend.md`)。

Codex 侧没有对等能力:只有一个扁平的 `[codex.env]`(整体 spread 进 spawn env)和
单一固定档位 `gpt-5.5`。Codex 走哪个模型/端点,完全取决于用户全局
`~/.codex/config.toml` 的 `model_provider` —— 无法在 lodestar 里按档位/按飞书群声明,
也不随 lodestar config 走。

本设计给 Codex 加一套 `[codex.models.<slug>]` 档位系统,和 `[claude.models.*]` 同构:
每个档位声明自己的第三方 OpenAI 兼容端点(base_url + wire_api + key + model + effort),
lodestar spawn `codex app-server` 时用 `-c` 覆盖注入该 provider,并把 key 注入 env。

### 已验证事实（2026-07-05,本机实测)

- `codex-cli 0.142.5` 的 `codex app-server` 支持 `-c, --config <key=value>` 覆盖:
  dotted path(`foo.bar.baz`)覆盖嵌套值,value 按 TOML 解析,解析失败则当原始字符串。
  即 `codex app-server -c model_provider="x" -c model_providers.x.base_url="https://…" --listen stdio://` 合法。
- 用户当前全局 `~/.codex/config.toml` 已经在用自定义 provider(`model_provider = "custom"`
  → `[model_providers.custom] base_url = "https://api.wuhen-ai.com"`,`wire_api = "responses"`,
  `requires_openai_auth = true`)。即现有 `gpt-5.5` 档位其实已经走第三方 API,而非 ChatGPT 登录态。
- Codex `[model_providers.<slug>]` 认 `name` / `base_url` / `wire_api`(`chat` | `responses`)/
  `env_key`(装 key 的环境变量名)/ `requires_openai_auth` 等字段。选定 provider 靠顶层
  `model_provider = "<slug>"`。
- lodestar 现有 spawn:`codex-process.ts:259` 拼 `args = ['app-server','--listen','stdio://']`;
  `:265-270` 的 env 已经在叠 `...config.codex.env`;`threadParams()`(`:772-783`)与
  `startTurn()`(`:886-899`)把 `opts.model` 作为 `model` 发进 thread/start。

## 目标与行为

`config.toml` 新增 `[codex.models.<slug>]` 档位(可 0..N 个),schema 对齐
`[claude.models.*]`:

```toml
# 例:接第三方 OpenAI 兼容端点(自带 key)
[codex.models.kimi]
display_name = "Codex · Kimi"
description  = "Moonshot Kimi(OpenAI 兼容端点)"
base_url     = "https://api.moonshot.cn/v1"
wire_api     = "chat"          # chat | responses,默认 chat
api_key      = "sk-..."         # 注入到 lodestar 生成的 env_key
model        = "kimi-k2"
effort       = "high"           # low|medium|high|xhigh;缺省回落固定档 xhigh
# route     = "api"             # 可选;配了 base_url 即推断 api

# 例:复刻用户 wuhen 全局 provider,但由 lodestar 显式管理
[codex.models.wuhen]
display_name = "Codex · 无痕"
base_url     = "https://api.wuhen-ai.com"
wire_api     = "responses"
model        = "gpt-5.5"
requires_openai_auth = "true"   # 走 codex 的 OpenAI auth,不需要 api_key
```

行为:

- **新增 picker 档位**:每个配好的 `[codex.models.<slug>]` 在飞书 `model` 面板出现一个
  `codex:<slug>` 选项,与内建 `gpt-5.5`(登录/默认档)、Claude 三档并列。
- **spawn 覆盖**:选中某 `codex:<slug>` API 档位时,lodestar spawn:
  ```
  codex app-server \
    -c model_provider="lodestar_<slug>" \
    -c model_providers.lodestar_<slug>.name="<slug>" \
    -c model_providers.lodestar_<slug>.base_url="<base_url>" \
    -c model_providers.lodestar_<slug>.wire_api="<wire_api>" \
    -c model_providers.lodestar_<slug>.env_key="LODESTAR_CODEX_<SLUG>_KEY" \
    [-c model_providers.lodestar_<slug>.requires_openai_auth=true] \
    --listen stdio://
  ```
  并注入 env `LODESTAR_CODEX_<SLUG>_KEY=<api_key>`(配了 api_key 时);thread/start 的
  `model` = 该档位的 `model` id(真实模型,不是 `codex:<slug>` 这个路由 key)。
- **provider slug 命名空间**:lodestar 注入的 provider 一律用 `lodestar_<slug>` 前缀,
  绝不覆盖用户全局 `[model_providers.*]`(如 `custom`),两者隔离。
- **登录/默认档 `gpt-5.5`**:保持现状 —— 不注入任何 `-c`、不注入 key,继承用户全局
  `~/.codex/config.toml`。这是 Codex 侧的 "route: login" 等价物。
- **未配置拦截**:API 档位在 picker 里可见但选择被拦截(缺 base_url / key / model 时),
  提示去 config.toml 补全 —— 完全复刻 GLM 未配置的 `onModelEffortSelect` 守卫。
- **跳过 ChatGPT 登录预检**:`start()` 的 `isOpenAIChatGPTAuthenticated()` 门槛(`session.ts:698`)
  仅对登录档生效;API 档位(`route:api`)跳过,否则"没登录 ChatGPT"会误拦 key 鉴权的档位。

## 方案取舍

- **A. `[codex.models.*]` 档位 + `-c` 注入(采纳)**:与 `[claude.models.*]` 同构,
  per-slot、可按群切换、显式入 lodestar config、加端点零代码;`-c` 是 app-server 官方
  支持的稳定杠杆。
- B. 只扩 `[codex.env]` 语义塞 `OPENAI_API_KEY`/`OPENAI_BASE_URL`:全局唯一、和登录态
  互斥、picker 里切不了,覆盖不了"多端点/多群"诉求。仅作临时过渡,排除。
- C. 改用纯 HTTP/OpenAI SDK 自己实现 codex(不走 codex CLI):抛弃 codex app-server 的
  工具执行/审批/沙箱/rollout 全套能力,工作量巨大且丢功能,排除。

## 代码改动

### `src/config.ts`

- `LodestarConfig.codex` 从 `{ env }` 扩为 `{ env; models: Record<string, CodexModelConfig> }`。
- 新增 `CodexModelConfig` 接口(`display_name` / `description` / `model` / `base_url` /
  `wire_api` / `api_key` / `env_key` / `requires_openai_auth` / `route` / `effort`,全 optional string)。
- 新增 `codexModelSections()`,解析 `[codex.models.*]`,完全复刻现有 `claudeModelSections()`
  (`:180-207`)的白名单式字段过滤。
- `loadConfig()` 返回 `codex: { env: codexEnv, models: codexModelSections() }`。

### 新增 `src/codex-models.ts`（镜像 `src/claude-models.ts`）

- `CodexModelProfile { key: 'codex:<slug>'; name; displayName; description; modelId;
  route: 'login'|'api'; providerSlug; env: Record<string,string>; configArgs: string[]; configured }`。
- 纯函数(可无 mock 直测):
  - `codexEnvKeyName(slug)` → `LODESTAR_CODEX_<SANITIZED_SLUG>_KEY`(slug 大写、非 alnum→`_`)。
  - `codexEnvFromConfig(raw, slug)` → `{ [envKey]: api_key }`(仅配了 api_key 时)。
  - `codexConfigArgs(raw, slug)` → `-c` 覆盖字符串数组(base_url/wire_api/env_key/name/
    requires_openai_auth + `model_provider`)。
  - `toCodexProfile(slug, raw)` → `CodexModelProfile | null`;`route`/`configured` 判定同
    `claude-models.ts:74-101`(api 需 base_url +（api_key 或 requires_openai_auth)+ model)。
- 读 config 的封装:`codexModelProfiles()` / `codexModelProfile(model)` /
  `codexModelIsApiRoute(model)` / `codexModelConfigured(model)` / `codexModelEffort(model)` /
  `resolveCodexModelId(model)`(把 `codex:<slug>` → 真实 modelId;非档位 key 原样返回)/
  `codexSpawnOverrides(model)`(→ `{ modelId; configArgs; env }`,登录档返回空覆盖)。

### `src/codex-process.ts`

- `SpawnOpts`(`:69-75`)新增可选 `configArgs?: string[]` 与 `providerEnv?: Record<string,string>`。
- 构造器 args(`:259`)改为 `['app-server', ...(opts.configArgs ?? []), '--listen', 'stdio://']`。
- 构造器 env(`:265-270`)在 `...config.codex.env` 之后叠 `...(opts.providerEnv ?? {})`。
- `opts.model` 仍是真实 modelId(由 session 解析后传入),`threadParams()`/`startTurn()` 不改。

### `src/session.ts`

- `spawnAgent()`(`:510-516`)codex 分支:`const ov = codexSpawnOverrides(this.modelForSpawn())`,
  传 `model: ov.modelId`、`configArgs: ov.configArgs`、`providerEnv: ov.env`。
- `start()` 登录预检(`:698`):加 `&& !codexModelIsApiRoute(this.selectedModel)`,API 档位跳过。

### `src/session-model.ts`

- `fixedModelChoices(s)`(`:134-156`)在内建 `FIXED_MODEL_CHOICES` 之后 concat
  `codexModelChoices()`(config 驱动的 codex API 档位,`provider:'codex'`、`model:'codex:<slug>'`、
  effort 取 config 或回落 xhigh)。
- `normalizeFixedModelSelection`(`:88-105`)/ `onModelEffortSelect`(`:239-250`):把"命中固定项"
  的查找扩为"命中固定项 **或** 命中 codex API 档位",未配置的 codex API 档位回落 `gpt-5.5`
  并在选择时拦截(复刻 GLM 分支)。
- `configuredDefaultSelection()`(`:113-124`)接受 `codex:<slug>` 作为 `[claude] default_model`
  值(沿用现字段;识别 `codex:` 前缀)。

### `src/agent-process.ts`

- `providerFromModel`(`:27-29`)**不改**:`codex:<slug>` 不以 `claude:` 开头 → 仍归 'codex',
  与裸 `gpt-5.5` 一致。

## 数据流（API 档位情形)

```
飞书选 codex:kimi → applyModelSelection(codex, 'codex:kimi', effort)
  → spawnAgent(): codexSpawnOverrides('codex:kimi')
      = { modelId:'kimi-k2',
          configArgs:['-c','model_provider="lodestar_kimi"', '-c','model_providers.lodestar_kimi.base_url="https://api.moonshot.cn/v1"', …],
          env:{ LODESTAR_CODEX_KIMI_KEY:'sk-…' } }
  → new CodexProcess({ model:'kimi-k2', configArgs, providerEnv })
  → spawn: codex app-server -c … --listen stdio://  (env 注入 key)
  → thread/start model='kimi-k2' → 打到 moonshot 端点
```

## 错误处理

- 缺字段的 API 档位:`configured=false` → picker 可见但 `onModelEffortSelect` 拦截,
  提示补 `[codex.models.<slug>]`(消息含缺哪几项),复刻 GLM。
- `codexSpawnOverrides` 对登录档/未知 key 返回空覆盖(`configArgs:[]`,`env:{}`,
  `modelId` 原样)—— 绝不误伤现有 `gpt-5.5`。
- `-c` value 一律用 TOML 字符串字面量(`base_url="https://…"`)传,避免裸 URL 被 TOML 解析歧义;
  经 argv 数组传参不过 shell,双引号是字面字符、由 codex 解析成字符串。
- API 档位 spawn 失败(端点不可达/key 错):codex app-server turn 报错,走现有 result/error 通道。

## 测试

`src/codex-models.test.ts`(纯函数,无需 mock config):

1. `codexEnvKeyName('wuhen-ai')` → `LODESTAR_CODEX_WUHEN_AI_KEY`(大写、`-`→`_`)。
2. `codexConfigArgs({base_url,wire_api,model},'kimi')` → 含
   `model_provider="lodestar_kimi"`、`model_providers.lodestar_kimi.base_url="…"`、
   `.wire_api="chat"`、`.env_key="LODESTAR_CODEX_KIMI_KEY"` 的 `-c` 对。
3. `toCodexProfile` route 推断:配了 base_url → `api`;啥都没配 → `login`;显式 `route` 优先。
4. `configured`:api 缺 model → false;base_url+api_key+model 齐 → true;
   base_url+requires_openai_auth+model → true;login 恒 true。
5. `codexEnvFromConfig`:配 api_key → `{[envKey]:key}`;没配(靠 requires_openai_auth)→ `{}`。

`src/codex-process.test.ts` 补:

6. `buildCodexAppServerArgs(['-c','model_provider="x"'])` →
   `['app-server','-c','model_provider="x"','--listen','stdio://']`(把 args 拼装抽成可测纯函数)。

回归:`bun test` 全绿(现有用例不动);`bun run build` 五个 bundle 成功。

手工验收(见 plan Task 6):配一个 `[codex.models.*]` → 飞书切 `codex:<slug>` → 日志确认
`codex app-server -c model_provider="lodestar_<slug>"` → 发消息正常回包。

## 范围外

- setup 向导(`lodestar-setup`)不新增 codex 档位交互项(YAGNI,手写一节即可)。
- 不做端点健康检查/连通性探测(codex app-server 自行报错)。
- 不改 Codex 的 `model/list`、compact、rollout、审批等既有能力。
- 不迁移用户全局 `~/.codex/config.toml`(登录档继续继承它)。
- `gpt-5.5` 档位不改名、不改行为。
