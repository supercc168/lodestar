# Claude Agent SDK Backend Memo

## Goal
让 Lodestar 在保留 Codex 支持的同时，可以把非 GPT 模型交给 Claude Agent SDK 执行。外层飞书群、Card Kit、`hi` / `stop` / `restart` / `model` 等会话体验保持不变；差异只落在 session 后端进程。

## Confirmed Facts
- 不能使用 `claude -p` 作为每轮一次的命令。
- Claude Agent SDK 的推荐长驻模式是 `query({ prompt: AsyncIterable<SDKUserMessage> })`，它会启动一个 Claude Code SDK transport 进程，并通过 `--input-format stream-json` / `--output-format stream-json` 做双向流。
- 本机 SDK 长驻探针已验证：同一个 `query()` 后端可连续处理多轮 user message，并保持同一个 `session_id`。
- SDK 在没有第一条用户输入时不会发 `init`；收到第一条 input 后才返回 `system/init`。
- 本机 Claude Code 已可用，当前上游由用户侧配置路由到 GLM-5.2。SDK 需要 `settingSources: ['user']` 才会读取用户配置。

## Design
新增一个 Lodestar 内部后端接口，让 `Session` 不直接依赖 `CodexProcess` 的具体类：

- `CodexProcess` 继续负责 GPT / Codex app-server。
- `ClaudeAgentProcess` 负责 Claude Agent SDK streaming input。
- `model` 命令展示固定档位（现状，见 `src/session-model.ts` 的 `FIXED_MODEL_CHOICES`）：
  - `claude:fable`（Fable 5）/ `claude:opus`（Opus 5）：官方登录档位，直传 `claude-fable-5` / `claude-opus-5`，走用户 Anthropic 登录态，绝不注入 API key，effort 锁 max。
  - `claude:glm`：第三方 API 路由，token 配在 `[claude.models.glm]`，spawn 时注入 `ANTHROPIC_*` env，effort 跟随 config（如 xhigh）；未配 token 时 picker 可见但选择被拦截。
  - `claude:grok` / `claude:grokcc`：Wuhen / CatCodex 的 Grok Anthropic Messages 路由，统一由 Claude Agent SDK 启动；无痕档锁官方最高 `xhigh`，CatCodex 档锁网关兼容 `xhigh`，并都设置 `thinking: disabled` 以关闭 Claude 专属 adaptive 控制。
  - `codex`（GPT-5.6 Sol）：Codex app-server 后端，内建档 effort 锁 `max`；`[codex.models.*]` 可提供非 Grok 的第三方 API 档位。
  - `claude:deepseek`（2026-08-13 复活）：DeepSeek 官网 Anthropic 兼容端点（`[claude.models.deepseek]`），主力 `deepseek-v4-pro[1m]`，haiku/子 agent 锁 `deepseek-v4-flash`，effort 锁 `max`；详见 `DEEPSEEK_V4_PRO_INTEGRATION.md`。
  - （早期的 `claude:default` 已随二元化 / per-model 路由下线。）
- 持久化模型选择扩展为 provider-aware，旧数据默认视为 Codex。
- 会话 resume id 也按 provider 分开保存，避免 Claude session id 覆盖 Codex thread id。
- `[[askusr: ...]]` 是 Codex 专属 host marker；Claude 不消费这个 marker，Claude 需要问用户时走 SDK 自己的 `AskUserQuestion` / `request_user_dialog` 路径。

## Claude Model Profiles
内置档位位于 `src/claude-models.ts`:官方 `fable`(Fable 5)/ `opus`(Opus 5)走用户的 Anthropic 登录态、绝不注入 API key;`glm`、`grok`、`grokcc` 是第三方 API 路由，token 在 `config.toml` 对应的 `[claude.models.*]` 配置。也可在 `config.toml` 覆盖档位或加新档位:

```toml
# 新群默认档位(可选;不写则默认 fable 登录档位)
[claude]
default_model = "glm"

# GLM 第三方路由:base_url + auth_token 只注入该档位,不碰官方登录档位
[claude.models.glm]
base_url   = "https://open.bigmodel.cn/api/anthropic"
auth_token = "<GLM API key>"
model      = "glm-5.2[1m]"   # 直连智谱;[1m] 开满 1M 上下文
effort     = "xhigh"          # 复刻 GLM-5.2 最高思维;官方登录档位锁 max

[claude.models.grok]
base_url   = "https://api.wuhen-ai.com"
auth_token = "<Wuhen token>"
model      = "grok-4.6"
effort     = "xhigh"

[claude.models.grokcc]
base_url   = "https://catcodexapi.com" # Claude SDK 使用根地址，不追加 /v1
auth_token = "<CatCodex token>"
model      = "grok-4.6"
effort     = "xhigh"
```

模型路由的真相源是 `config.toml` 的 `[claude.models.*]`(第三方 per-model token 路由):`ClaudeAgentProcess.buildSpawnEnv` 只在 GLM 一类 API 档位 spawn 时注入 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`,官方 Fable 5 / Opus 登录档位保持干净凭据基线。随后两类档位都会设置 `GSD_RUNTIME=claude`。第一方登录档按飞书当前选定主力注入子 agent alias：选 Fable 5 → fable/opus/sonnet 全为 `claude-fable-5`、haiku=`claude-sonnet-5`；选 Opus 5 → fable/opus/sonnet 全为 `claude-opus-5`、haiku=`claude-sonnet-5`（选 Opus 不注入 Fable，选 Fable 不注入 Opus）；第三方 API 档则把四个 alias 全部锁到当前 profile.model,避免官方 Claude id 泄漏到兼容端点。`[claude.models.*]` 的字段仅认 `display_name / description / model / base_url / auth_token / api_key / route / effort` 以及扁平 `env_<NAME>`；第三方档即使在 config 中分开声明四种 alias,也会在 spawn 边界收敛为当前 model。**别把第三方 env 写进 `~/.claude/settings.json`**:SDK 经 `settingSources:['user']` 会加载它、污染登录档位;`[claude.env]` 仅作可选 escape hatch。

Grok 只属于 Claude backend。[xAI 官方 reasoning 文档](https://docs.x.ai/developers/model-capabilities/text/reasoning)规定 Grok 4.6 effort 为 `low` / `medium` / `high`(默认) / `xhigh`——`xhigh` 是 Grok 4.6 新增的官方最高档(4.5 只有 low/medium/high)。无痕路由按官方最高 `xhigh` 启动；CatCodex 的 Anthropic 网关在 `high` 下可返回纯文本并忽略工具调用，而 `xhigh + thinking: disabled` 连续完成 raw 强制工具选择及 SDK `tool_use/tool_result`，因此 CatCodex 档位锁定 `xhigh`(4.6 起与官方档恰好一致)。两路的 `thinking: { type: "disabled" }` 都只为避免兼容端点接收 Claude 专属 adaptive-thinking 协议，不关闭 Grok 自身 reasoning。失败仍以原始错误暴露，不静默换模型/provider。任何 `[codex.models.*]` 中真实 model id 为 `grok-*` 的 profile 都不进入 picker/TokenSource，Codex spawn 边界也会直接拒绝；旧 `codex:grok*` 持久选择恢复时迁到同名 Claude 档位。

可执行文件解析:`resolveClaudeExecutableConfig({ apiRoute })` 默认自动查找 `claude`(`~/.local/npm-global/bin` → `~/.local/bin` → PATH → SDK 自带)。`config.toml` 设 `[claude].bin`(支持 `~`)可显式覆盖,路径不存在时 `sendInitialize` 直接抛错,不静默回退。若配置的是 Unix `reclaude`,Lodestar 不把它直接传给 SDK(直接传会退回 CLI stream-json,丢失 dialog/control 协议),而是给 SDK 提供的 native command 建一个临时 PATH shim,再由 reclaude 注入 proxy/CA 后查找这个 `claude`;日志为 `executable=config-reclaude-sdk-native:<路径>`。**关键:第三方 API 路由(GLM/Grok 等,`route:api`)会强制绕开 `[claude].bin`、使用 SDK 自带 native 入口** —— reclaude 的 gateway 会把注入的 `ANTHROPIC_BASE_URL` 劫持回官方 Anthropic,第三方 model id 在官方 deployment 上不存在。官方登录档位走 reclaude + SDK native shim,第三方走 SDK native 直连端点。

SDK `model`:官方档位直传 `claude-fable-5` / `claude-opus-5`;第三方档位把 profile 的上游 id 交给 SDK native 入口,配套 `[claude.models.*]` 注入的 `ANTHROPIC_BASE_URL` 打到对应 Anthropic 兼容端点。reclaude 只负责官方登录档位的代理/证书注入,不再替代 SDK transport。早期把 `ANTHROPIC_DEFAULT_*_MODEL` 写入全局 settings/env 的做法已废弃:启动 env 会先清掉 Fable/Opus/Sonnet/Haiku 四个 alias,随后按飞书选定主力(第一方)或当前第三方 profile 重新注入。

第三方 Claude API 档位可用 `bun scripts/claude-stream-probe.ts claude:<slug>` 做隔离兼容性检查。探针不会发送飞书消息或复用生产 session；它核对飞书选择对应的 profile model 是否原样进入 SDK init，并验证原始 SSE content-block 顺序、强制 tool choice、text/tool-use/tool-result 全链路。非 Grok 档还要求 thinking 与工具前文本；Grok 复用生产兼容参数，允许无 thinking block 以及合法的 tool-first 顺序。探针非零退出表示端点本次未满足 Claude Agent 工作流，Lodestar 不得静默改用其它模型。

## Claude Event Mapping
`ClaudeAgentProcess` 把 SDK message 映射为现有 Session 已会处理的事件：

- `system/init` -> `init`
- assistant text block -> `assistant_text` + `assistant_block_stop`
- assistant `tool_use` block -> `tool_use`
- user `tool_result` message -> `tool_result`
- `result` -> `token_usage` + `result`
- `system/compact_boundary` -> `context_compacted`
- `system/model_refusal_fallback` -> `model_refusal_fallback`
- `system/model_refusal_no_fallback` -> `model_refusal_no_fallback`

模型拒答降级:主模型 `stop_reason='refusal'` 后,SDK 重试到备用模型(`model_refusal_fallback`)或无备用模型直接失败(`model_refusal_no_fallback`)。Session 收到后在运行中卡 footer 瞬时高亮提示(8s 后让 Thinking/Writing/Working 相位标签恢复),并在 `closeTurnCard` 把提示注入完成卡 footer 第一行持久留痕(与 `🚨 压缩×N`、`📎 发送文件` 同通道,✅ 状态标保留)。`scope` 区分语义:`session`=主线程换模型波及整个会话 → `🔄 模型降级 A→B`;`local`=子 agent / `/btw` 副问 / 后台 fork 局部降级,主会话模型不变 → `🔄 子任务降级 A→B`;无备用 → `⚠️ A 拒绝,未降级`。`scope` 缺省(老 CLI)归一 `session`,`direction` 非 `retry`(legacy revert/sticky)防御性丢弃,每 turn 只提示首次(幂等)。

权限:Claude SDK 使用 `permissionMode: default`,让 `AskUserQuestion` 能进入 `canUseTool`;其它工具在 callback 内立即 allow,保持原来的全自动行为。Ask callback 挂起并 emit `can_use_tool` 给 Session,飞书按钮回调再通过 `sendPermissionResponse()` resolve。

失败工具保护:SDK 注册 `PostToolUse` / `PostToolUseFailure` 进程内 hooks。连续第 2 次完全相同的工具失败会向模型追加“不要原样重试、重新读状态并换参数/策略”的上下文；provider 通用的 `Session` 指纹检测在第 3 次软中断当前 turn、关闭卡片且不重放原任务。排队真人消息在进程健康时续投，进程退出或开卡失败时保留到下一条普通消息；一次失败、成功工具或不同 input/error 都会重置序列。

Claude 自带 ask 工具接到 SDK `canUseTool`：

- query 配置 `toolConfig.askUserQuestion.previewFormat = markdown`,由 SDK native transport 下发 `AskUserQuestion`。
- 将 dialog payload 规范化成现有 `AskUserQuestion` 卡片的 `questions` 结构。
- 先登记 pending control，再 emit `tool_use` / `can_use_tool`，避免同步回包 race。
- 用户点击选项或群里回复后，仍通过 `updatedInput.answers` 回填给 SDK。

## First Version Scope
- 支持 Claude backend 普通任务执行、工具展示、工具结果展示、打断、停止、重启、模型切换。
- 支持 Claude usage / cost / context window 在 footer 展示。
- 跨 Codex / Claude provider 切换只在空闲或下次启动边界生效；当前 turn 或排队消息存在时直接拒绝。
- `compact`：Codex 走 app-server `thread/compact/start`；Claude backend 借 CLI 内建 `/compact` slash command(其 `supportsNonInteractive=true`,streamInput 下作为 local command 执行),`compactThread()` push 一条 `/compact` user 消息触发,完成后复用 `compact_boundary → context_compacted` 同一套收尾。
- host-side `[[askusr: ...]]` 只对 Codex 生效；Claude 使用 SDK ask，不混用 Codex marker。
- 不重启 live daemon；代码变更后只报告需要重启。

## Codex Parity Audit
以改动前 Codex 行为为基线逐项对照：

- 启动与恢复：Codex 仍走 `codex app-server --listen stdio://`，仍检查 `codex login`，仍等待 app-server `init` 后把 session 置为 ready；`restart` 仍用 Codex thread id 恢复。
- turn 调度：Codex 的 eager-open、cold-start、mid-turn buffer、OneSecond reaction、stop interrupt、result 后 drain 逻辑保持同一条 Session 路径；不会在当前 turn 中途迁移到 Claude。
- 模型选择：Codex app-server 仍负责校验模型/effort；内建档固定为 `gpt-5.6-sol`/`max`，API 档按各自 profile 的真实 model id 与 effort 启动。
- 卡片与控制台：Codex action value 保持旧形状，不额外带 `provider`；Codex 控制台标题保持原来的 `当前模型`，不显示 `(Codex)`；Codex `agy` 转发按钮默认仍显示 `转 Codex`。
- 使用量与上下文：Codex token usage、context window、manual compact、thread goal、plan delta 事件仍按原 app-server 事件处理。
- 持久化兼容：旧版 `session-resume-map.json` 的 string 值按 Codex thread id 读取；旧版 `session-model-map.json` 的 string/object 若无 provider，按模型名前缀推断，普通 GPT 模型仍按 Codex 读取。

## Claude Differences From Codex
这些差异来自 Claude Agent SDK 能力边界或本机模型路由，不能伪装成 Codex 完全同构：

- 启动时机：Claude SDK 在没有第一条 user input 前不会发 `system/init`，所以 `hi` 启动 Claude 后不会强等 init；首条消息触发 init 和真实 session id。
- 模型项:Claude 暴露 Fable 5、Opus 5、GLM，以及 Grok 无痕/CatCodex API 档位；登录档位与第三方 profile 各自解析明确的 SDK model id 和环境。Codex 不暴露或启动 Grok。
- resume id：Claude `session_id` 与 Codex thread id 分开保存；切换 provider 不共享上下文。
- compact：Claude SDK 始终没有暴露 Codex `thread/compact/start` 的等价触发接口(0.3.222 仍未);但 CLI 内建 `/compact` slash command 支持 `supportsNonInteractive`,故 `compactThread()` 改为 push 一条 `/compact` user 消息、由 CLI 本地执行压缩,完成后 emit `compact_boundary → context_compacted`,与 Codex 走同一套 `session-compact.ts` 收尾。差异:对话太短时 CLI 回 "Not enough messages to compact." 而不发 `compact_boundary`,watch 的 result 兜底(claude-only)以 no-op 收尾,卡片显示「⚪ 上下文太少,无需压缩」,不干等 120s 超时。
- ask：Codex 的 `[[askusr: ...]]` host marker 不给 Claude 使用；Claude 的 ask 来自 SDK `AskUserQuestion` / user-dialog，仍渲染成同一套飞书问答卡。

## Audit Fixes
本轮对照后补掉的遗漏：

- 跨 provider 切换只允许在空闲/启动边界执行；当前 turn 或排队消息存在时直接拒绝，避免中途切换改变原 turn 调度。
- 旧后端的迟到 `session_id` / exit 事件不会覆盖当前已选择后端的 `lastSessionId` 或新进程状态。
- Claude 启动前会显式检查 `claude` 可执行文件；找不到时直接启动失败并提示，不让 session 先进入 ready 再异步报错。
- Claude streaming-input 后端在首条用户输入前不会发 `init`；Lodestar 启动 Claude 时只等待短暂同步/早期错误，不再把“无输入所以没 init”当启动失败。
- Claude 使用 `permissionMode: default` 以保留 `canUseTool`;非 Ask 工具由 callback 秒放,`AskUserQuestion` 才进入飞书问答卡。
- Codex 控制台和启动消息恢复原显示，不新增 `Codex ·` / `(Codex)` 这类额外标记。
- Codex 不再调用不存在的 `thread/settings/update`;模型选择保存后只在空闲边界停止并重建进程,有 thread id 时沿用原 thread,无 id 时 fresh start。
- Claude/Codex 的模型选择在当前 turn、启动、排队或另一项重建进行时统一拒绝;空闲切换成功后才允许下一轮使用新 profile。
- 每个 turn 冻结 provider/model/effort 与 usage source;后续 model 点击不会改写旧卡片的 footer、续卡或额度路由。provider 真变化时才清理 turn anchors。
- Claude 的 quota 只对 `claude:glm` 查询 GLM;Fable/Opus 明确显示不适用,Codex 第三方档位不复用 ChatGPT 全局缓存。
- Claude `buildSpawnEnv` 会清理继承环境和 `[claude.env]` 中的 `ANTHROPIC_DEFAULT_FABLE_MODEL`、`OPUS`、`SONNET`、`HAIKU` alias,再按飞书选定主力(第一方)或当前第三方 API profile 注入。
- `[[askusr: ...]]` 处理链路加 provider 守卫，Claude 输出同名 marker 不会触发 Codex host ask 卡或续跑。
- Claude `canUseTool` 接入现有 `AskUserQuestion` 卡片和 `updatedInput.answers` 回填协议，并修复同步权限回包 race。
- spawn prompt 按 provider 分开：Codex 继续收到 `[[askusr: ...]]` 说明，Claude 收到 “使用 AskUserQuestion，不要输出 askusr marker”。
- `agy` 转发按钮在 Codex 下保持 `转 Codex`，在 Claude 下显示 `转 Claude`，实际仍进入同一 session 用户消息路径。
- 对话卡续卡 banner 在 Codex 下保持 `Codex turn` 原文，在 Claude 下显示 `Claude turn`。
- Grok 选择、默认值和旧持久化值统一落到 Claude provider；Codex Grok profile 从 picker/TokenSource 过滤并在 spawn 边界拒绝。
- Grok query 使用路由专属 effort（无痕 `high` / CatCodex `xhigh`）+ disabled Claude adaptive thinking；这只改善兼容率，不掩盖上游 content-block 错误。

## Verification Plan
- SDK 长驻探针：同一 `ClaudeAgentProcess` 处理两轮输入，返回同一 `session_id`。
- Claude ask smoke：独立临时目录启动 `ClaudeAgentProcess(model=claude:glm)`，要求模型调用 `AskUserQuestion`，自动回填答案后期待 `DONE`。
- 单元测试：`bun test`。
- 构建验证：`bun run build`。

## Verification Result
- `bun test`: 112 pass。
- `bun run build`: daemon / setup / stop / update / version 全部 bundle 成功。
- Claude init probe: `sendInitialize()` 后无首条输入时 8 秒内没有 stream `init`；`start()` 已改为短暂等待早期错误后 ready，冷启动首条用户消息会先发 input 再由 SDK 触发 init。
- Claude 模型切换不再依赖 `setModelSettings`:空闲切换会重建 SDK query,忙碌时明确拒绝,避免把未验证的热更新协议当成成功。
- Claude ask smoke: `claude:glm` 启动时 SDK 日志显示 `model=opus`；实际触发 `AskUserQuestion`，自动回答后 assistant 输出 `DONE`，`result subtype=success` 且 `is_error=false`。
- smoke 结束时本机 Claude 插件的 `SessionEnd` hook 在 stderr 报 `/bin/sh` ENOENT；`/bin/sh` 本机存在，turn 已成功完成。该警告来自外部 Claude 插件 hook，不属于 Lodestar ask/model 路径失败。

2026-07-29 Grok Claude-only 路由验证：

- SDK 固定 `@anthropic-ai/claude-agent-sdk@0.3.220`（内置 Claude Code `2.1.220`），本机全局 Claude Code `2.1.201`。同一套已安装 SDK 对 CatCodex 既完成过完整 tool-use/tool-result，也出现过 `Content block not found`，故不能归因于一个确定的本机版本不兼容。
- `claude:grok`（Wuhen）用官方 `high + disabled` 时，原始协议与 SDK 均完成 text/tool-use/tool-result，工具内观测到 `CLAUDE_EFFORT=high`，`rawPassed/sdkPassed/passed` 均为 true。
- `claude:grokcc` 使用 `https://catcodexapi.com` 根地址 + `grok-4.5`；`/v1` 会让 SDK 报模型不存在/无权限，直接请求内部 `grok-4.5-build-free` 又得到 503。`high + disabled` 连续两轮均只返回文本、没有 SDK tool-use，其中一轮连原始强制 tool choice 也未兑现。
- Claude SDK 类型说明：`high` 是通用深度推理默认档；`xhigh` 官方只对指定 Claude 模型原生生效，其他模型通常回退到 `high`。但 CatCodex 网关对这两个入参产生了可观测的工具行为差异，因此该路由保留 `xhigh` 作为传输兼容参数，而不是把它解释为 xAI reasoning 档位。
- CatCodex 的 `xhigh + disabled` 连续两轮均确认 `queryEffort=xhigh`、`queryThinking=disabled`，原始强制 tool choice 与 SDK text/tool-use/tool-result 全链路通过；Wuhen 的 `high + disabled` SDK 工具闭环也通过。两条流仍可看到 thinking，符合 Grok 4.5 reasoning 不能关闭的官方语义。
- Grok/TokenSource/Session 定向测试 `13 pass / 0 fail`，全部发布产物构建成功；全量 `bun test` 为 `942 pass / 1 fail`，唯一失败是未修改的 `install/yiui-gsd/yiui-gsd.test.ts` mtime 亚毫秒精度断言（目标文件系统截断为整数毫秒），与既有基线一致。

## Codex API 档位（`[codex.models.*]`）

Codex 侧的 per-slot API 路由,与 `[claude.models.*]` 同构(见 `src/codex-models.ts`)。每个非 Grok 的 `[codex.models.<slug>]` 声明一个第三方 OpenAI 兼容端点(`base_url` / `wire_api` / `api_key` 或 `requires_openai_auth` / `model` / `effort`)。飞书面板出现 `codex:<slug>` 档位;`session.spawnAgent()` 经 `codexSpawnOverrides()` 把它解析为 `codex app-server -c model_provider="lodestar_<slug>" -c model_providers.lodestar_<slug>.*=…` 覆盖 + `LODESTAR_CODEX_<SLUG>_KEY` env 注入。`model_provider` 用 `lodestar_<slug>` 前缀隔离用户全局 `[model_providers.*]`;thread/start 的 `model` 是档位声明的真实模型 id(非 `codex:<slug>` 路由 key)。内建 `gpt-5.6-sol` 是登录/默认档,不注入 provider 覆盖、继承用户全局 `~/.codex/config.toml`;其 GSD 子 agent 静态策略统一 bake 为同一 Sol。未配置的 API 档位在 `onModelEffortSelect`/`normalizeFixedModelSelection` 被拦截/回落 `gpt-5.6-sol`(复刻 GLM 守卫);API 档位在 `start()` 跳过 `isOpenAIChatGPTAuthenticated()` 预检。

Grok 是唯一的强制 Claude-only 例外：不要再写 `[codex.models.grok*]`。`bun scripts/codex-responses-probe.ts codex:<slug>` 只用于其它 Responses profile，并会拒绝真实 `grok-*` model id。
