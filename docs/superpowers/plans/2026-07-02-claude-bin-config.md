# `[claude] bin` 可配置可执行路径(接入 reclaude)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `config.toml` 新增 `[claude] bin` 可选配置,显式指定 Claude Agent SDK spawn 的可执行文件(如 reclaude 包装器),未配置时行为不变。

**Architecture:** lodestar 的 Claude 后端经 `@anthropic-ai/claude-agent-sdk` 的 `query()` 拉起 Claude Code 无头子进程;可执行文件由 `src/claude-agent-process.ts` 的 `resolveClaudeExecutableConfig()` 决定(当前只有自动查找)。本改动在该函数入口加"配置优先"分支:配置了 bin → 存在性检查后直接用(不存在 fail fast 抛错);未配置 → 原自动查找逻辑一行不动。配置解析走现有 `src/config.ts` 手写 TOML parser(已支持任意 `[section]`,只需读 `t.claude?.bin` 并 `expandTilde`)。

**Tech Stack:** Bun(运行时/测试/构建,无 tsconfig,TS 由 bun 直接转译)、bun:test(测试文件已用 `mock.module('./config', ...)` 隔离真实配置)。

**Spec:** `docs/superpowers/specs/2026-07-02-claude-bin-config-design.md`(已批准)

## Global Constraints

- 未配置 `[claude].bin` 时行为与现状完全一致(现有 20 个 `claude-agent-process.test.ts` 用例必须原样通过,不许改动它们)
- 配置了但文件不存在:**throw 含完整路径的错误,禁止静默回退到自动查找**
- `findClaudeBin()` / `whichClaude()` / `buildClaudeSpawnPath()` 等自动查找逻辑不动
- `assertClaudeCodeAvailable()`(`src/session.ts:435` 调用)保持宽松探测语义,不动(bin 配错由 `sendInitialize` 的 try/catch 报错)
- setup 向导(`src/setup.ts`)不新增交互项(spec 范围外)
- 注释与错误信息风格跟随现有代码(中文注释、`lodestar: ...` 前缀错误)
- 测试命令:`bun test`(先 `bun install`);构建验证:`bun run build`

---

### Task 1: `[claude] bin` 配置解析 + 可执行路径覆盖(TDD)

**Files:**
- Modify: `src/config.ts:44-48`(`LodestarConfig.claude` 接口)、`src/config.ts:147-156`(`loadConfig()` 返回值)
- Modify: `src/claude-agent-process.ts:89-94`(`ClaudePathLookup` 类型)、`src/claude-agent-process.ts:161-176`(`resolveClaudeExecutableConfig()`)
- Test: `src/claude-agent-process.test.ts`(新增一个 describe 块,插在第 93 行 `describe('Claude model profiles', ...)` 结束之后)

**Interfaces:**
- Consumes: 现有 `config`(`src/config.ts` 导出单例)、`expandTilde()`(config.ts 内部已有)、`existsSync`/`windowsShellShim()`/`spawnWindowsShellShim()`/`findClaudeBin()`(claude-agent-process.ts 内部已有)
- Produces: `config.claude.bin?: string`(已展开 `~` 的绝对路径或 undefined);`ClaudePathLookup.configuredBin?: string | null`(`undefined` = 读 `config.claude.bin`,显式 `null` = 视为未配置,测试隔离用);`resolveClaudeExecutableConfig()` 配置生效时返回 `{ pathToClaudeCodeExecutable: <bin>, description: 'config:<bin>' }`(win32 `.cmd/.bat` 时 description 为 `windows-shell-shim:<bin>` 并带 `spawnClaudeCodeProcess`)

**注意:** 调用点 `sendInitialize()`(`src/claude-agent-process.ts:536`)无参调用 `resolveClaudeExecutableConfig()`,`configuredBin` 为 `undefined` → 自动读到 `config.claude.bin`,**无需改调用点**。测试文件顶部的 `mock.module('./config', ...)` mock 里没有 `bin` 字段(即 `undefined`),现有用例不受影响,**mock 不需要改**。

- [ ] **Step 1: 写失败测试**

在 `src/claude-agent-process.test.ts` 第 93 行(`describe('Claude model profiles', ...)` 的收尾 `})`)之后、`describe('Claude permission mode', ...)` 之前,插入:

```ts
describe('Claude configured executable ([claude] bin)', () => {
  test('uses configured bin as the SDK executable', () => {
    const bin = '/home/me/.local/bin/reclaude'
    const executable = resolveClaudeExecutableConfig({
      platform: 'linux',
      configuredBin: bin,
      exists: path => path === bin,
    })

    expect(executable.pathToClaudeCodeExecutable).toBe(bin)
    expect(executable.spawnClaudeCodeProcess).toBeUndefined()
    expect(executable.description).toBe(`config:${bin}`)
  })

  test('throws instead of silently falling back when configured bin is missing', () => {
    expect(() => resolveClaudeExecutableConfig({
      platform: 'linux',
      configuredBin: '/nope/reclaude',
      exists: () => false,
    })).toThrow('/nope/reclaude')
  })

  test('runs configured Windows .cmd bin through the shell shim spawn hook', () => {
    const bin = win32.join('C:\\Users\\me\\bin', 'reclaude.cmd')
    const executable = resolveClaudeExecutableConfig({
      platform: 'win32',
      configuredBin: bin,
      exists: path => path === bin,
    })

    expect(executable.pathToClaudeCodeExecutable).toBe(bin)
    expect(typeof executable.spawnClaudeCodeProcess).toBe('function')
    expect(executable.description).toBe(`windows-shell-shim:${bin}`)
  })

  test('explicit null configuredBin falls back to auto discovery', () => {
    const executable = resolveClaudeExecutableConfig({
      platform: 'win32',
      pathEnv: '',
      configuredBin: null,
      exists: () => false,
    })

    expect(executable).toEqual({ description: 'sdk-default' })
  })
})
```

(`win32` 已在测试文件第 3 行从 `node:path` 导入,无需新增 import。)

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/claude-agent-process.test.ts`
Expected: 前两个新用例 FAIL(`configuredBin` 被无视,走了自动查找:test 1 拿到 `sdk-default` 描述断言不等,test 2 没有 throw);后两个可能碰巧过。共 24 个用例中至少 2 个 FAIL。

- [ ] **Step 3: 改 `src/config.ts`**

`LodestarConfig` 的 `claude` 字段(第 44-48 行)改为:

```ts
  /** Env vars injected into the Claude Code subprocess used by
   * `@anthropic-ai/claude-agent-sdk`. Empty record = inherit the user's
   * local Claude Code configuration. */
  claude: {
    /** 显式指定 SDK spawn 的 Claude Code 可执行文件(如 reclaude 这类
     * 参数透传包装器)。未设置 = 自动查找。 */
    bin?: string
    env: Record<string, string>
    models: Record<string, ClaudeModelConfig>
  }
```

`loadConfig()` 中,`const claudeEnv = envSection('claude.env')`(第 149 行)之后加一行,并改返回值:

```ts
  const claudeBin = t.claude?.bin ? expandTilde(t.claude.bin) : undefined
```

```ts
    claude: { bin: claudeBin, env: claudeEnv, models: claudeModelSections() },
```

- [ ] **Step 4: 改 `src/claude-agent-process.ts`**

`ClaudePathLookup`(第 89-94 行)改为:

```ts
type ClaudePathLookup = {
  platform?: NodeJS.Platform
  pathEnv?: string
  homeDir?: string
  exists?: (path: string) => boolean
  /** undefined = 读 config.claude.bin;显式 null = 视为未配置(测试隔离 config 用)。 */
  configuredBin?: string | null
}
```

`resolveClaudeExecutableConfig()`(第 161-176 行)整体替换为:

```ts
export function resolveClaudeExecutableConfig(lookup: ClaudePathLookup = {}): ClaudeExecutableConfig {
  const platform = lookup.platform ?? process.platform
  const configured = lookup.configuredBin === undefined ? config.claude.bin : lookup.configuredBin
  if (configured) {
    const exists = lookup.exists ?? existsSync
    // [claude].bin 配错时必须 fail fast:静默回退会让用户以为在烧包装器
    // (如 reclaude)的额度,实际走了别的 key。
    if (!exists(configured)) {
      throw new Error(`lodestar: [claude].bin not found: ${configured} (config.toml)`)
    }
    if (platform === 'win32' && windowsShellShim(configured)) {
      return {
        pathToClaudeCodeExecutable: configured,
        spawnClaudeCodeProcess: spawnWindowsShellShim,
        description: `windows-shell-shim:${configured}`,
      }
    }
    return { pathToClaudeCodeExecutable: configured, description: `config:${configured}` }
  }
  const bin = findClaudeBin(lookup)
  if (!bin) return { description: 'sdk-default' }
  if (platform === 'win32' && windowsShellShim(bin)) {
    return {
      pathToClaudeCodeExecutable: bin,
      spawnClaudeCodeProcess: spawnWindowsShellShim,
      description: `windows-shell-shim:${bin}`,
    }
  }
  return {
    pathToClaudeCodeExecutable: bin,
    description: bin,
  }
}
```

(`config` 已在该文件第 18 行导入,无需新增 import。)

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test src/claude-agent-process.test.ts`
Expected: 24 pass, 0 fail(20 个既有 + 4 个新增)

- [ ] **Step 6: 跑全量测试**

Run: `bun test`
Expected: 全部 pass, 0 fail(基线:改动前 `bun test` 全绿,若基线本身有 fail 需先停下报告)

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/claude-agent-process.ts src/claude-agent-process.test.ts
git commit -m "feat(claude): [claude] bin 显式指定可执行文件(接入 reclaude 等包装器)"
```

---

### Task 2: 文档(README + backend memo)+ 构建验证

**Files:**
- Modify: `README.md`(在 `### 🔔 HTTP 通知端点` 小节之前插入新小节)
- Modify: `docs/claude-agent-backend.md:43`(“模型路由的真相源…”段落之后)

**Interfaces:**
- Consumes: Task 1 的行为(`[claude].bin` 配置键、`config:<路径>` 日志描述、fail-fast 报错)
- Produces: 无代码接口,仅文档

- [ ] **Step 1: README 新增小节**

在 `README.md` 的 `### 🔔 HTTP 通知端点` 一行之前插入(保持前后各一个空行):

````markdown
### 🔀 自定义 Claude Code 可执行文件(reclaude 等)

默认自动查找 `claude`(`~/.local/npm-global/bin` → `~/.local/bin` → PATH,都没有则用 SDK 自带二进制)。要换成 [reclaude](https://docs.reclaude.ai) 这类“参数原样透传给 claude”的包装器,在 `config.toml` 显式指定:

```toml
[claude]
bin = "~/.local/bin/reclaude"
```

配置后跳过自动查找;路径不存在会在会话启动时直接报错,不会静默回退。日志里 `executable=config:<路径>` 可确认生效。

迁移到 reclaude 时注意:`[claude.env]` 或 `~/.claude/settings.json` 里遗留的 GLM `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 必须清掉 —— base URL 指向 GLM 时流量不经官方域名,reclaude 的拦截不会生效,烧的还是 GLM 额度。`[claude.models.*]` 里的 GLM profile 也需换回官方模型档位。
````

- [ ] **Step 2: backend memo 补充可执行文件解析说明**

在 `docs/claude-agent-backend.md` 第 43 行“模型路由的真相源是 `~/.claude/settings.json`…”段落之后插入一段:

```markdown
可执行文件解析:`resolveClaudeExecutableConfig()` 默认自动查找 `claude`(`~/.local/npm-global/bin` → `~/.local/bin` → PATH → SDK 自带)。`config.toml` 设 `[claude].bin`(支持 `~`)可显式覆盖,用于 reclaude 这类参数透传包装器;路径不存在时 `sendInitialize` 直接抛错,不静默回退。日志 `executable=config:<路径>` 确认生效。
```

- [ ] **Step 3: 构建验证**

Run: `bun run build`
Expected: daemon / setup / stop / update / version 五个 bundle 全部成功,无 TS 报错

- [ ] **Step 4: Commit**

```bash
git add README.md docs/claude-agent-backend.md
git commit -m "docs: [claude] bin 配置说明与 reclaude 迁移提示"
```

---

### Task 3: 手工验收(真实 reclaude 环境,需人工)

**Files:** 无代码改动;操作 `~/.config/lodestar/config.toml`(或 `$LODESTAR_CONFIG` 指向的文件)

**Interfaces:**
- Consumes: Task 1 的运行时行为

前置已实测事实(2026-07-02,reclaude v1.2.0,见 spec):`reclaude` 参数原样透传 claude、stdout 纯净(自身输出走 stderr)、headless `-p` 可用、daemon launchd 自启。

- [ ] **Step 1: 配置** — `config.toml` 加:

```toml
[claude]
bin = "~/.local/bin/reclaude"
```

同时确认 `[claude.env]` 无 GLM 的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 残留(`~/.claude/settings.json` 同理)。

- [ ] **Step 2: 重启 daemon** — 开发态 `bun run start`(或已安装的 `lodestar-stop` 后重启)

- [ ] **Step 3: 验证 spawn** — 飞书群发一条消息,daemon 日志应出现
`claude-agent-process: spawn SDK query ... executable=config:/Users/chiuan/.local/bin/reclaude`,且 stderr 通道出现 reclaude 的 `同步配置…` 属正常

- [ ] **Step 4: 验证额度口径** — 回复正常返回;`reclaude status` 的 daemon 正常、群里 `hi` 控制台/footer 用量来自官方账号(非 GLM 套餐)

- [ ] **Step 5: 验证 fail fast** — 临时把 bin 改成不存在路径,重启后发消息应收到会话错误(日志含 `lodestar: [claude].bin not found: ...`),改回后恢复
