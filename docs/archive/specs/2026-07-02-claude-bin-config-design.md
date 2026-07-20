# 设计:可配置 Claude Code 可执行路径(接入 reclaude)

日期:2026-07-02
状态:已批准,待实现

## 背景

lodestar 的 Claude 后端通过 `@anthropic-ai/claude-agent-sdk` 的 `query()` 拉起
Claude Code 无头子进程(stdio 上 stream-json 协议)。可执行文件由
`src/claude-agent-process.ts` 的 `findClaudeBin()` 自动查找:
`~/.local/npm-global/bin/claude` → `~/.local/bin/claude` → PATH 上的 `claude`,
都找不到则回退 SDK 自带二进制(日志 `executable=sdk-default`)。

用户环境使用 [reclaude](https://docs.reclaude.ai)(本地 daemon 代理,把 Claude Code
流量换成官方分配账号)。需要让 lodestar spawn `reclaude` 而非 `claude`。

### 已验证的 reclaude 事实(2026-07-02,v1.2.0,本机实测)

- `reclaude <args>` 将所有非管理子命令参数**原样透传**给 claude(帮助文档明示;
  `reclaude --version` 输出 `2.1.199 (Claude Code)` 实证)
- headless 模式可用:`reclaude -p "..."` 正常返回
- **stdout 纯净**:reclaude 自身输出(如 `同步配置…`)走 stderr,不污染
  stream-json 协议
- 每次启动自动确保 daemon 存活(launchd `com.reclaude.daemon` 亦开机自启)
- 路由机制对 lodestar 透明:凭证在 macOS 钥匙串(伪装 OAuth 的 `sk-rec-` token),
  流量经注入的 `HTTP(S)_PROXY=127.0.0.1:<daemon端口>` + `NODE_EXTRA_CA_CERTS`
  进本地 daemon,全部由 reclaude 自理
- 与 claude 同为原生可执行文件(Mach-O),SDK spawn 方式无差异

## 目标与行为

`config.toml` 新增可选配置:

```toml
[claude]
bin = "~/.local/bin/reclaude"
```

- 设置后:SDK 的 `pathToClaudeCodeExecutable` = 该路径(展开 `~`),跳过自动查找
- 未设置:行为与现状完全一致
- 设置了但文件不存在:**fail fast 报错,不静默回退**。静默回退会让用户以为在用
  reclaude 官方额度、实际烧别的 key

## 方案取舍

- **A. 配置化可执行路径(采纳)**:通用、~25 行 diff、路由机制全部留给包装器自理、
  可上游合并
- B. 零代码纯 `[claude.env]` 注入 proxy/CA:硬编码 reclaude 内部端口与 CA 路径,
  机制变更即静默失效,仅作临时过渡
- C. `findClaudeBin()` 硬编码 reclaude 优先:对 npm 包所有用户构成劫持,排除

## 代码改动(~25 行)

### `src/config.ts`(~5 行)

- `LodestarConfig.claude` 增加 `bin?: string`
- `loadConfig()` 读 `t.claude?.bin`,套用现有 `expandTilde()`

### `src/claude-agent-process.ts`(~15 行)

- `ClaudePathLookup` 增加 `configuredBin?: string | null`(沿用现有测试注入模式;
  `undefined` = 读 `config.claude.bin`,显式 `null` = 视为未配置,供测试隔离 config)
- `resolveClaudeExecutableConfig()` 开头:
  `const bin = lookup.configuredBin === undefined ? config.claude.bin : lookup.configuredBin`;
  有值 → `existsSync` 检查(可经 `lookup.exists` 注入),不存在则 throw 含完整路径的
  错误;Windows `.cmd/.bat` 复用现有 shell shim 分支;返回
  `{ pathToClaudeCodeExecutable, description: 'config:<路径>' }`
- `findClaudeBin()` 等自动查找逻辑不动

日志无需改:`sendInitialize` 已打 `executable=...`,生效后显示
`executable=config:/Users/.../reclaude`。

## 数据流(reclaude 情形)

```
飞书消息 → SDK query() → spawn reclaude <claude参数>
        → reclaude: 确保 daemon 存活 + 注入 proxy/CA env → 拉起 claude
        → 流量经本地 daemon → 换成官方分配账号 → Anthropic API
```

## 错误处理

- bin 路径不存在:throw 发生在 `sendInitialize` 的 try/catch 内 → 现有 error/exit
  事件 → 飞书侧现有会话错误提示;日志含完整路径
- daemon 异常:reclaude 被 spawn 时自检拉起,属其自身职责
- reclaude 的 stderr 输出:进入现有 `claude-agent-process[stderr]:` 日志通道,无害

## 测试

单测(`src/claude-agent-process.test.ts`,沿用 lookup 注入风格):

1. `configuredBin` 存在 → 返回该路径,description 为 `config:...`
2. `configuredBin` 指向不存在的路径 → throw 含路径的错误
3. `configuredBin: null` → 走原自动查找逻辑(与现有测试行为一致)

手工验收:config.toml 配 bin → 飞书群发消息 → 日志确认
`executable=config:...reclaude` → `hi` 控制台确认用量来自官方账号。

## 文档

README 增加 `[claude] bin` 配置说明,附 reclaude 示例与迁移提示:

- `[claude.env]` 里遗留的 GLM `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` 必须清掉,
  否则流量直指 GLM 端点,不经官方域名,reclaude 拦截不生效
- `[claude.models.*]` 里的 GLM profile 需换成官方模型名

## 范围外

- setup 向导(`lodestar-setup`)不增加 bin 交互项(YAGNI,手写一行配置即可)
- 不做 reclaude daemon 健康检查/自动重启(reclaude 自身职责)
