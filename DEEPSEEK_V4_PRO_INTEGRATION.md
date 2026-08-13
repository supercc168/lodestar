# DeepSeek V4 Pro 接入 Lodestar / Claude Code

Lodestar 新增 `claude:deepseek` 档位,走 DeepSeek 官网 Anthropic 兼容端点。
实现完全复刻现有 GLM/Grok 档位(`src/claude-models.ts` + `[claude.models.deepseek]` config 节)。

## 官方接入参数(2026-08-14 对齐官方 8-13 更新,端点实测)

对 `https://api.deepseek.com/anthropic/v1/messages` 打真实 Anthropic Messages 请求验证:

| 参数 | 值 | 说明 |
|------|-----|------|
| `base_url` | `https://api.deepseek.com/anthropic` | **必须带 `/anthropic` 后缀**;不带会走 OpenAI 兼容协议,Claude Code 无法工作 |
| `auth_token` | DeepSeek API key(`sk-...`) | 映射到 `ANTHROPIC_AUTH_TOKEN`,以 `Authorization: Bearer` 发送 |
| `model` | `deepseek-v4-pro[1m]` | V4 Pro 正式版(0813),reasoning 模型(响应带 `thinking`)。`[1m]` 后缀让 Claude Code 识别 1M 上下文;端点接受并回显无后缀 |
| `effort` | `max` | 官方 Claude Code 接入文档同档(CLAUDE_CODE_EFFORT_LEVEL=max),低/高/最高三档思考强度中的最高档 |

**model id 实测对照(2026-08-14)**:
- `deepseek-v4-pro[1m]` → HTTP 200,回显 `deepseek-v4-pro` ← **本档主力**
- `deepseek-v4-pro` → 同样可用,但 Claude Code 不知道是 1M ctx(无 `[1m]` 标记)
- `deepseek-v4-flash` → 快速档,**0731 起同样支持思考模式**(响应带 thinking),便宜 ~1/3
- `deepseek-reasoner` → 独立推理模型别名
- `GET /v1/models` → 404(Anthropic 兼容端点不列模型,属正常)
- `POST /v1/messages/count_tokens` → 支持,返回 `{"input_tokens":N}`

**服务端模型映射已上线(2026-08-13 官方 Harness 更新)**:
- `claude-opus*` → `deepseek-v4-pro`
- `claude-haiku*` / `claude-sonnet*` → `deepseek-v4-flash`
- `claude-fable*` → `deepseek-v4-flash`

即官方 Claude 模型名不会再在 DeepSeek 端点报错,会服务端正确路由。

## 代码改动(`src/claude-models.ts`)

1. `DEFAULT_CLAUDE_MODELS` 加 `deepseek` 条目(`route: 'api'`,与 glm 同构)。
2. `DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-pro[1m]'` + `DEFAULT_DEEPSEEK_FLASH_MODEL = 'deepseek-v4-flash'`。
3. `toProfile()` deepseek 分支:配了 token 时 alias 按官方接入文档拆分 ——
   fable/opus/sonnet 三档锁主力,haiku 锁 `deepseek-v4-flash`;
   并补 `DEFAULT_DEEPSEEK_ENV` 缺省(`CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash`、
   `CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432`),档位显式 `env` 配置优先。
4. `claudeModelTierEnv()` 的 api 路径对 deepseek 同样拆分(spawn 边界兜底,
   会覆盖 profile env 的 alias 残余,与 GLM/Grok 的"四档全锁"不同)。

## 运行时配置

在 `~/.config/lodestar/config.toml` 加(真实 key 只放这里,**不要提交入库**):

```toml
[claude.models.deepseek]
display_name = "Claude · DeepSeek V4 Pro"
model        = "deepseek-v4-pro[1m]"
base_url     = "https://api.deepseek.com/anthropic"
auth_token   = "sk-你的-deepseek-api-key"
effort       = "max"
```

改完后 `bun run build` + 重启 daemon(`launchctl kickstart -k gui/$(id -u)/com.supercc168.lodestar`)。
飞书 model 面板即出现 **Claude · DeepSeek V4 Pro**(引用 id `claude:deepseek`)。

## 端点 smoke 自检

```bash
curl -sS https://api.deepseek.com/anthropic/v1/messages \
  -H "Authorization: Bearer sk-你的-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"deepseek-v4-pro[1m]","max_tokens":16,"messages":[{"role":"user","content":"say PONG"}]}'
# 期望:HTTP 200,响应 content 含 thinking + text="PONG",model 回显 deepseek-v4-pro
```

## 注意

- 官方 Harness(`deepseek-ai/deepseek-harness`)已于 2026-08-13 开源(MIT)并发布
  npm `@deepseek-ai/dsh` 0.1.0-rc.5(`npx @deepseek-ai/dsh web`);它与本档位是两条路
  —— Lodestar 走 Claude Code harness + DeepSeek Anthropic 端点,不依赖 dsh。
- DeepSeek Anthropic 兼容接口不保证支持全部 Anthropic 特性(部分高级 tool use 行为可能有差异),
  但 Claude Code 核心编码/工具调用可用。
- 子 agent/haiku 走 `deepseek-v4-flash`(便宜 ~1/3),单独给 haiku 指定其他模型不会生效
  (spawn 边界 `claudeModelTierEnv` 硬锁,与 grok 档位同样的收敛行为)。
- **2026-08-17 起 V4 全系改为峰谷定价**(闲时半价),注意任务排期。
- 官方文档:https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code
