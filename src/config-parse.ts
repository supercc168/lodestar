/** Claude 档位配置的纯类型与纯解析函数,从 config.ts 拆出。
 *
 *  拆分原因:多个测试文件用 `mock.module('./config')` 替换 config 单例做隔离,
 *  而 bun 的模块 mock 无法被 mock.restore() 撤销 —— 在显式多文件同批运行
 *  (`bun test a.test.ts b.test.ts`)时会泄漏到同作用域其他文件,导致从 './config'
 *  真实导入 parseClaudeModelProfile 的测试(config.test.ts)拿到被 mock 后的残缺
 *  对象而抛 SyntaxError。把纯函数 + 它依赖的 type 放到这个不依赖 config 单例的
 *  独立模块,解析逻辑的单测改从 './config-parse' 导入,即不受 './config' mock
 *  影响。config.ts 仍 re-export 两者,对外 API 不变。 */

export interface ClaudeModelConfig {
  display_name?: string
  description?: string
  model?: string
  /** 第三方路由(如 GLM)的接入配置。官方 Anthropic 档位(Fable 5/Opus)
   * 留空 —— 它们走用户的 Claude 登录态,绝不注入 API key。设置任一即视为
   * API 路由:spawn 时按档位注入对应 ANTHROPIC_* env(见 claude-models.ts
   * claudeModelEnv)。GLM 的 token 应放在 [claude.models.glm] 这个档位节里,
   * 不要放全局 [claude.env],否则会污染官方登录档位。 */
  base_url?: string
  auth_token?: string
  api_key?: string
  /** 显式声明路由类型;缺省时由是否配置了 base_url/auth_token 推断。 */
  route?: 'login' | 'api'
  /** 该档位在 model 面板锁死的思考强度(low/medium/high/xhigh/max)。第三方
   * 路由(GLM)用它复刻各自最优配置 —— 如 GLM-5.2 直连智谱走 xhigh 触发
   * extended thinking。官方档位不读此字段(锁 max)。非法值忽略、回落固定值。 */
  effort?: string
  /** Per-档位 env 注入(仅 API 路由档位生效)。config 里用扁平标量 env_<NAME>
   *  表达(本解析器只支持 scalar),如 env_ANTHROPIC_DEFAULT_OPUS_MODEL。
   *  spawn 时合并进档位 env:选 GLM 时注入别名→GLM 模型映射,官方登录档位
   *  raw.env 恒空→不注入→三档别名走 Claude Code 默认解析,零污染。
   *  注意:env 非空会让 toProfile 把 route 推断为 'api',故 env_* 只能配在
   *  已配 base_url/auth_token 的第三方档位(如 glm),不可配官方登录档位。 */
  env?: Record<string, string>
}

/** 从单个 [claude.models.<name>] section 组装 ClaudeModelConfig。
 *  env_<NAME> 扁平标量收进 profile.env(绕过手写解析器对嵌套 table 的不支持)。
 *  放在独立模块(而非 config.ts)便于单测解析逻辑,且不受测试里
 *  mock.module('./config') 的污染影响(见文件头说明)。 */
export function parseClaudeModelProfile(section: Record<string, unknown>): ClaudeModelConfig {
  const profile: ClaudeModelConfig = {}
  for (const [rawKey, value] of Object.entries(section)) {
    if (typeof value !== 'string' || value.length === 0) continue
    const field = rawKey.trim()
    if (field.startsWith('env_')) {
      const envKey = field.slice(4)
      if (envKey) {
        ;((profile.env ??= {}) as Record<string, string>)[envKey] = value
      }
      continue
    }
    if (
      field === 'display_name' ||
      field === 'description' ||
      field === 'model' ||
      field === 'base_url' ||
      field === 'auth_token' ||
      field === 'api_key' ||
      field === 'route' ||
      field === 'effort'
    ) {
      ;(profile as Record<string, string>)[field] = value
    }
  }
  return profile
}
