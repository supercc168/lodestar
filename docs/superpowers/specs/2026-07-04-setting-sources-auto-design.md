# 设计:`setting_sources = "auto"` 智能档 —— 自动识别项目 AI 环境配置

日期:2026-07-04
状态:已批准,待实现

## 背景

lodestar 的 Claude 引擎(`src/claude-agent-process.ts`)通过
`@anthropic-ai/claude-agent-sdk` 的 `query()` 拉起 Claude Code 无头子进程,
其 `settingSources` 选项决定加载哪些层级的 Claude 配置(`user` = `~/.claude/`,
`project` = 项目 `.claude/` + `CLAUDE.md`,`local` = `.claude/settings.local.json`)。

当前 `settingSourcesFromProfile(profile)` 的行为:

- 未配 `setting_sources` → 默认 `['user']`,只加载用户级全局配置
- 配了 → 按逗号切分原样使用(如 `"project"` → `['project']`)

问题:一个飞书群绑定的工程项目(如 `[projects.etmmo]`,cwd = `/Users/doge/svn/etmmo`)
即便自己带了完整的项目级配置(`CLAUDE.md`、`.claude/settings.json` 含 hooks、
`.claude/skills/` 112 个、`.claude/agents/` 19 个、`.claude/commands/`),默认也**不会**
被加载——只有用户级 `~/.claude` 生效。想还原"在项目目录直接启动 claude code"的效果,
今天必须手写 `setting_sources = "user,project,local"`,且要求配置者理解:纯 `project`
会丢掉 `~/.claude/settings.json` 导致卡死([README 警告][readme])。

### 已验证事实(2026-07-04,本机)

- `settingSourcesFromProfile` 仅一个非测试调用点:`claude-agent-process.ts:696`,
  该处 `this.opts.workDir`(agent 实际 cwd)可用
- `config.ts` 解析器对 `setting_sources` 不做白名单校验,值原样存入
  `profile.settingSources` —— `auto` 可无改动流过
- etmmo 仓库确有完整 `.claude/`;`~/.claude/settings.json` 干净(无 `ANTHROPIC_*` env),
  叠加 `project`/`local` 不污染登录档位
- 测试基建可复用 `worktree.test.ts` 的 `mkdtempSync` + `tmpdir` 模式
- **SDK 语义已实证**(读 v0.3.181 的 `sdk.d.ts` + 原生 `claude` 二进制):
  `settingSources` 含 `project` 才加载项目 `CLAUDE.md`/`.claude/skills`/`.claude/agents`/
  `settings.json`(含 hooks);`local` 单独控制 `settings.local.json`;默认 `['user']` 均不加载。
  ⚠️ **项目 `.claude/agents/` 的加载是 SDK 二进制的未公开行为**(公开文档未列、甚至相反),
  v0.3.181 实测有效 —— **锁 SDK 版本,升级时重验 agents 加载**

## 目标与行为

新增哨兵值 `auto`(大小写不敏感)。规范写法是**单独一个 `auto`**;
`setting_sources = "auto"` 时:

- 检测该群 agent 的 cwd(`workDir`)是否存在项目级 Claude 配置:
  **`.claude/` 目录存在** 或 **`CLAUDE.md` 存在**
- **命中** → 解析为 `['user', 'project', 'local']`(等价于在该目录启动 claude code:
  全局 + 项目 + 本地的 settings/skills/agents/CLAUDE.md,含项目 hooks)
- **未命中** → 退回 `['user']`(现状默认)

**混写防呆(评审 #1,必修)**:`auto` **不是**精确整值匹配,而是**逗号切分后只要含
`auto` token 就进 auto 模式**,其余 token 忽略并 `log()` 一条提示。理由:若用精确匹配,
`"auto,project"` 会掉进逗号分支得到 `['auto','project']` —— SDK 只认 `user|project|local`,
`auto` 非法会被丢 → 实际变 `['project']` → **丢掉 user 源、重现"失去
`~/.claude/settings.json` → 卡死"**,且静默无报错。含-token 判定杜绝此坑。
同时非 `auto` 的逗号分支也做一次白名单过滤(只留 `user/project/local`,未知 token 丢弃并
`log()`),过滤后为空则退回 `['user']`。

不变量:auto 的两个分支都含 `user`,因此 `auto` **永不**触发纯 `project` 的"丢弃
`~/.claude/settings.json` → 卡死"陷阱;比手写 `project` 更安全,是"零风险开启项目级"的
推荐档位。

`auto` 只作用于 `settingSources`。项目 MCP 仍由独立的 `load_project_mcp` 显式开启
(它有 stdio 握手卡死风险,不应被 `auto` 隐式打开);`strict_mcp`/`tools`/
`keep_lodestar_instructions` 行为不变。

## 方案取舍

- **C. 加 `auto` 智能档(采纳)**:可复用通用能力,单函数 + 单调用点 diff,始终含
  `user` 故无卡死风险,不改其他群行为
- A. 只给 etmmo 手写 `setting_sources = "user,project,local"`:纯配置零代码,但不通用、
  每个新项目都要手配且要懂卡死坑
- B. 改 `DEFAULT_SETTING_SOURCES` 默认加载项目级:影响全部群,hooks/token 风险面扩大,
  且对无 `.claude/` 的项目引入无谓开销,排除

## 代码改动

### `src/claude-agent-process.ts`(~15 行)

- `settingSourcesFromProfile(profile)` → `settingSourcesFromProfile(profile, workDir?)`
  - 未配 `settingSources` → `['user']`(不变)
  - 逗号切分 → trim → lowercase → filter 空,得到 `tokens`
  - **`tokens` 含 `'auto'`** → auto 模式:
    - `hasProjectConfig = !!workDir && (existsSync(join(workDir, '.claude')) ||
      existsSync(join(workDir, 'CLAUDE.md')))`
    - 若 `tokens` 除 `auto` 外还有别的值 → `log()` 提示"auto 是独占档,忽略其余 token"
    - 返回 `hasProjectConfig ? ['user', 'project', 'local'] : ['user']`
  - **否则**(显式列表)→ 白名单过滤 `tokens ∩ {user,project,local}`,丢弃的未知 token
    `log()` 一条;过滤后为空 → `['user']`
- 调用点 `:696` 改为 `settingSourcesFromProfile(profile, this.opts.workDir)`
- **日志落点(评审 #3)**:放在 `:696` **解析之后**(此时结果数组已算出),或并入 `:709`
  那条本就 always 打 `cwd` 的 spawn 日志;**不要**放 `:694` 的 profile 日志处(那在
  `:696` 之前、拿不到结果)。形如
  `settingSources=auto→[user,project,local] (detected project config at <cwd>)`
  / `→[user] (no project config at <cwd>)`,喂给"排查卡死"链路
- `existsSync`/`join` 已在文件顶部 import(用于 `readProjectMcpServers`),无需新增依赖
- **`.claude` 检测粒度(评审 #4,可选)**:`existsSync` 对同名普通文件也算命中;实践可忽略,
  要严谨则对 `.claude` 那一支改用 `statSync(...).isDirectory()`。默认保持 `existsSync`

### `src/config.ts`

- 无逻辑改动;在 `ProjectProfile.settingSources` 或解析 `case 'setting_sources'` 处补注释,
  说明 `auto` 是受支持的特殊值

## 数据流

```
飞书消息 → 选中 [projects.<群>] profile(settingSources="auto")
        → spawn 前 settingSourcesFromProfile(profile, workDir)
        → existsSync(<cwd>/.claude || <cwd>/CLAUDE.md) ?
              命中 → SDK settingSources=['user','project','local']
                     → 加载项目 CLAUDE.md + skills + agents + settings(含 hooks)
              未命中 → SDK settingSources=['user']
```

## 错误处理

- `workDir` 未传(测试或异常路径)→ `hasProjectConfig` 为 false → 安全退回 `['user']`,
  不抛错
- `existsSync` 对不可读/不存在路径返回 false,天然退回 `['user']`
- 混写 `auto,<x>` → 含-token 判定进 auto 模式,不会产出非法 `['auto',...]`(评审 #1)
- 显式列表含未知 token → 白名单过滤丢弃 + `log()`;不把非法源传给 SDK
- 显式列表(不含 `auto`)行为与现状一致,零回归

## 测试(`src/claude-agent-process.test.ts`,复用 `mkdtempSync`)

新增(auto 分支):

1. `auto` + tmp 目录含 `.claude/` → `['user','project','local']`
2. `auto` + tmp 目录仅含 `CLAUDE.md` → `['user','project','local']`
3. `auto` + 空 tmp 目录 → `['user']`
4. `auto` + 不传 `workDir` → `['user']`(安全兜底)
5. `AUTO`(大写)+ 含 `.claude/` → 与 `auto` 等价
6. **`"auto,project"` + 含 `.claude/` → `['user','project','local']`**(评审 #1:含-token 判定,
   不得退化成 `['auto','project']`);未命中时 → `['user']`(不得掉 user)
7. `"user,bogus"`(未知 token)→ `['user']`(白名单过滤;`bogus` 丢弃)

回归(须继续通过):`undefined`/`{}`/`'project'`/`'user, project'`/`''`/`' , '` 全部行为不变。

手工验收:`[projects.etmmo]` 配 `setting_sources = "auto"` → 重建 + kickstart daemon →
飞书群发消息 → 日志确认 `settingSources=auto→[user,project,local]` → 群内验证项目
skill / `/start` 命令 / 项目 CLAUDE.md 规范生效。

## 文档

- README `[projects.*]` 表:`setting_sources` 行补 `auto` 值说明 ——「检测到项目
  `.claude/` 或 `CLAUDE.md` 就自动 `user,project,local`,否则退回 `user`;始终含 `user`,
  不会踩 project-only 卡死坑;**`auto` 是独占档,别写成 `auto,project`**」;点明该开关
  **仅对 Claude 引擎有效**(Codex 无论如何自动读 `AGENTS.md`)
- **运维警告(评审 #2,须显著,非脚注)**:命中 `auto` 会**整体加载**项目
  `.claude/settings.json` 的 hooks(`SessionStart`/`UserPromptSubmit`/`PreToolUse`/`Stop`),
  **每轮在 daemon 内执行**。`PreToolUse` hook 退出非零会**直接拦掉该次工具调用**;
  daemon 无 TTY 显示 hook stderr → 表现为"莫名卡住/失败的一轮"。`settingSources` 是
  **全有全无**:无法只要 skills/agents/CLAUDE.md 而丢掉 hooks —— 要摘 hooks 只能不开
  `auto`,或改项目自己的 `settings.json`。接入前先审一遍项目 hooks 会不会在自动化通道里
  阻塞
- token 成本:命中后大量 skill 的名称+描述进系统提示(etmmo 有 112 个),属"忠实还原
  claude code in dir"的固有代价

## 上线

1. `bun run build`
2. kickstart launchd daemon(`com.supercc168.lodestar`,见 launchd 部署约定)
3. `~/.config/lodestar/config.toml` 的 `[projects.etmmo]` 加 `setting_sources = "auto"`
4. 日志确认命中三源

## 范围外

- 不自动开启 `load_project_mcp`(独立显式开关,避免 MCP 握手卡死)
- 不在 `lodestar-setup` 向导加 `auto` 交互项(手写一行即可)
- 不改 Codex 引擎路径(其 `AGENTS.md` 加载与 `settingSources` 无关)

[readme]: ../../../README.md
