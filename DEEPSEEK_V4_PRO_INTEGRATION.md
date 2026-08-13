# DeepSeek V4 Pro 接入 Lodestar / Claude Code

Lodestar 新增 `claude:deepseek` 档位,走 DeepSeek 官网 Anthropic 兼容端点。
实现完全复刻现有 GLM/Grok 档位(`src/claude-models.ts` + `[claude.models.deepseek]` config 节)。

## 官方接入参数(2026-08-13 实测校验)

对 `https://api.deepseek.com/anthropic/v1/messages` 打真实 Anthropic Messages 请求验证:

| 参数 | 值 | 说明 |
|------|-----|------|
| `base_url` | `https://api.deepseek.com/anthropic` | **必须带 `/anthropic` 后缀**;不带会走 OpenAI 兼容协议,Claude Code 无法工作 |
| `auth_token` | DeepSeek API key(`sk-...`) | 映射到 `ANTHROPIC_AUTH_TOKEN`,以 `Authorization: Bearer` 发送 |
| `model` | `deepseek-v4-pro` | V4 最强档,reasoning 模型(响应带 `thinking`)。实测 HTTP 200 ✓ |
| `effort` | `xhigh` | 触发 extended thinking,与 GLM/grokcc 一致 |

**model id 实测对照**:
- `deepseek-v4-pro` → 回显 `deepseek-v4-pro`,响应含 `thinking` 块 ← **本档主力**
- `deepseek-chat` → 回显 `deepseek-v4-flash`(V4 快速档,非 thinking,更便宜)
- `deepseek-reasoner` → 独立推理模型别名
- `GET /v1/models` → 404(Anthropic 兼容端点不列模型,属正常)

## 代码改动(`src/claude-models.ts`)

1. `DEFAULT_CLAUDE_MODELS` 加 `deepseek` 条目(`route: 'api'`,与 glm 同构)。
2. 新增 `DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-pro'` 回落常量。
3. `toProfile()` 加 `name === 'deepseek'` 分支:配了 token 时把四档子 agent alias
   (`ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL`)全锁回 `deepseek-v4-pro`,
   防官方 model id 泄漏。`claudeModelTierEnv` 的通用 api 路径会再兜底锁一遍。

## 运行时配置

在 `~/.config/lodestar/config.toml` 加(真实 key 只放这里,**不要提交入库**):

```toml
[claude.models.deepseek]
display_name = "Claude · DeepSeek V4 Pro"
model        = "deepseek-v4-pro"
base_url     = "https://api.deepseek.com/anthropic"
auth_token   = "sk-你的-deepseek-api-key"
effort       = "xhigh"
```

改完后 `bun run build` + 重启 daemon(`launchctl kickstart -k gui/$(id -u)/com.supercc168.lodestar`)。
飞书 model 面板即出现 **Claude · DeepSeek V4 Pro**(引用 id `claude:deepseek`)。

## 端点 smoke 自检

```bash
curl -sS https://api.deepseek.com/anthropic/v1/messages \
  -H "Authorization: Bearer sk-你的-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"deepseek-v4-pro","max_tokens":16,"messages":[{"role":"user","content":"say PONG"}]}'
# 期望:HTTP 200,响应 content 含 thinking + text="PONG",model 回显 deepseek-v4-pro
```

## 注意

- DeepSeek Anthropic 兼容接口不保证支持全部 Anthropic 特性(部分高级 tool use 行为可能有差异),
  但 Claude Code 核心编码/工具调用可用。
- 子 agent 四档 alias 会全部锁到 `deepseek-v4-pro`,单独给 haiku/sonnet 指定更便宜模型不会生效
  (与 grok 档位同样的收敛行为)。
- 官方文档:https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code
