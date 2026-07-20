# `setting_sources = "auto"` 智能档 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 lodestar 的 `[projects.<群>]` 增加 `setting_sources = "auto"` 智能档 —— 检测到项目 `.claude/` 或 `CLAUDE.md` 就自动加载 `['user','project','local']`(等价于在该目录启动 claude code),否则退回 `['user']`。

**Architecture:** 改动集中在 `settingSourcesFromProfile` 单函数:新增可选第二参 `workDir`,`auto`(含-token 判定,非精确整值)命中时 `existsSync` 探测项目配置;显式列表加白名单过滤。唯一调用点 `sendInitialize` 传入 `this.opts.workDir`,并把解析出的 `settingSources` 打进 spawn 日志。config.ts 补注释,README 补档位说明与 hooks 运维警告。

**Tech Stack:** TypeScript(bun 运行时)、`@anthropic-ai/claude-agent-sdk` v0.3.181、`bun:test`、`node:fs`(`existsSync`/`join`)。

## Global Constraints

- 语言/运行时:TypeScript on bun;测试用 `bun:test`,跑单文件 `bun test src/claude-agent-process.test.ts`(无 tsconfig、无 `test` npm 脚本)。
- **不得回归**现有 5 条 `settingSourcesFromProfile` 测试(`undefined`/`{}`/`'project'`/`'user, project'`/`''`/`' , '`);基线全绿(48 pass 0 fail)。
- SDK 语义(v0.3.181 已实证):`settingSources` 含 `'project'` 才加载项目 `CLAUDE.md`/`.claude/skills`/`.claude/agents`/`settings.json`(含 hooks);`'local'` 单独控制 `settings.local.json`。**锁 SDK 版本,升级时重验 `.claude/agents/` 加载(依赖未公开二进制行为)。**
- `auto` 不变量:两分支都含 `user`,永不产出丢 `user` 的数组;绝不把非法源(如 `'auto'`)转发给 SDK。
- **提交纪律**:当前在 `main` 分支。执行提交前**先开 `feat/setting-sources-auto` 分支**(用户已知)。spec 文件 `docs/superpowers/specs/2026-07-04-setting-sources-auto-design.md` 尚未提交,随第一个 task 一并纳入。
- 参考 spec:`docs/superpowers/specs/2026-07-04-setting-sources-auto-design.md`。

---

## File Structure

| 文件 | 职责 | 动作 |
| --- | --- | --- |
| `src/claude-agent-process.ts` | `settingSourcesFromProfile` 解析器(加 `workDir` + `auto` + 白名单);调用点 `:696`;spawn 日志 `:709` | Modify |
| `src/claude-agent-process.test.ts` | 解析器单测(现有 5 + 新增 7);temp-dir 助手 | Modify |
| `src/config.ts` | `ProjectProfile.settingSources` 文档注释 + parse 注释 | Modify |
| `README.md` | `[projects.*]` 表 `setting_sources` 行 + `auto`/hooks 警告 | Modify |
| `~/.config/lodestar/config.toml` | `[projects.etmmo]` 加 `setting_sources = "auto"`(部署,仓库外,不提交) | Deploy |

---

### Task 1: `settingSourcesFromProfile` 加 `auto` 智能档 + 白名单(TDD)

**Files:**
- Modify: `src/claude-agent-process.ts:462-471`(函数体)
- Test: `src/claude-agent-process.test.ts:1-4`(imports)、`:1002-1016`(新增测试与助手)

**Interfaces:**
- Consumes:`ProjectProfile`(`./config`,字段 `settingSources?: string`);`existsSync`、`join`(文件顶部已 import);`log`(`./log`,已 import)。
- Produces:`settingSourcesFromProfile(profile: ProjectProfile | undefined, workDir?: string): string[]` —— 供 Task 2 的调用点使用。返回值仅含 `'user'`/`'project'`/`'local'`。

- [ ] **Step 1: 扩测试 imports + temp-dir 助手**

`src/claude-agent-process.test.ts` 第 2 行改为(加 `mkdirSync`、`rmSync`):

```ts
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'node:fs'
```

第 4 行改为(加 `afterAll`):

```ts
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
```

在 `describe('Claude project profile overrides', () => {`(约 `:1002`)块内、第一个 `test(` 之前插入助手:

```ts
  const ssTmpDirs: string[] = []
  function tmpProjectDir(entries: { claudeDir?: boolean; claudeMd?: boolean } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'lodestar-ss-'))
    ssTmpDirs.push(dir)
    if (entries.claudeDir) mkdirSync(join(dir, '.claude'))
    if (entries.claudeMd) writeFileSync(join(dir, 'CLAUDE.md'), '# proj\n')
    return dir
  }
  afterAll(() => {
    for (const d of ssTmpDirs) rmSync(d, { recursive: true, force: true })
  })
```

- [ ] **Step 2: 写失败测试(7 条)**

紧接现有 `settingSourcesFromProfile falls back when only blanks given` 测试之后插入:

```ts
  test('settingSourcesFromProfile auto detects project .claude → three sources', () => {
    const dir = tmpProjectDir({ claudeDir: true })
    expect(settingSourcesFromProfile({ settingSources: 'auto' }, dir)).toEqual(['user', 'project', 'local'])
  })

  test('settingSourcesFromProfile auto detects CLAUDE.md → three sources', () => {
    const dir = tmpProjectDir({ claudeMd: true })
    expect(settingSourcesFromProfile({ settingSources: 'auto' }, dir)).toEqual(['user', 'project', 'local'])
  })

  test('settingSourcesFromProfile auto with no project config → user', () => {
    const dir = tmpProjectDir()
    expect(settingSourcesFromProfile({ settingSources: 'auto' }, dir)).toEqual(['user'])
  })

  test('settingSourcesFromProfile auto without workDir → user', () => {
    expect(settingSourcesFromProfile({ settingSources: 'auto' })).toEqual(['user'])
  })

  test('settingSourcesFromProfile AUTO is case-insensitive', () => {
    const dir = tmpProjectDir({ claudeDir: true })
    expect(settingSourcesFromProfile({ settingSources: 'AUTO' }, dir)).toEqual(['user', 'project', 'local'])
  })

  test('settingSourcesFromProfile "auto,project" stays auto (never drops user)', () => {
    const hit = tmpProjectDir({ claudeDir: true })
    expect(settingSourcesFromProfile({ settingSources: 'auto,project' }, hit)).toEqual(['user', 'project', 'local'])
    const miss = tmpProjectDir()
    expect(settingSourcesFromProfile({ settingSources: 'auto,project' }, miss)).toEqual(['user'])
  })

  test('settingSourcesFromProfile drops unknown tokens via whitelist', () => {
    expect(settingSourcesFromProfile({ settingSources: 'user,bogus' })).toEqual(['user'])
  })
```

- [ ] **Step 3: 跑测试,确认失败**

Run: `bun test src/claude-agent-process.test.ts -t "settingSourcesFromProfile"`
Expected: 新增 7 条 FAIL(现逻辑 `'auto'` → `['auto']`,不等于期望),现有 3 条仍 PASS。

- [ ] **Step 4: 实现解析器**

`src/claude-agent-process.ts` 把 `:462-471` 整段替换为:

```ts
/** Default setting sources when no project profile overrides them. */
const DEFAULT_SETTING_SOURCES: readonly string[] = ['user']

/** Valid SDK setting sources; anything else in an explicit list is dropped. */
const VALID_SETTING_SOURCES = new Set(['user', 'project', 'local'])

/** Resolve SDK `settingSources` from a project profile's comma-separated
 * string. Falls back to `['user']`.
 *
 * Special value `auto` (exclusive — may appear in a list but ignores the rest):
 * if `<workDir>/.claude` or `<workDir>/CLAUDE.md` exists, expand to
 * `['user','project','local']` (parity with launching claude in that dir);
 * otherwise `['user']`. Both branches keep `user`, so `auto` never triggers the
 * project-only "dropped ~/.claude/settings.json → hang" trap.
 *
 * Explicit lists are whitelist-filtered to valid sources; unknown tokens are
 * dropped (logged), never forwarded to the SDK. */
export function settingSourcesFromProfile(
  profile: ProjectProfile | undefined,
  workDir?: string,
): string[] {
  const raw = profile?.settingSources
  if (!raw) return [...DEFAULT_SETTING_SOURCES]
  const tokens = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  if (tokens.length === 0) return [...DEFAULT_SETTING_SOURCES]

  if (tokens.includes('auto')) {
    const extra = tokens.filter(t => t !== 'auto')
    if (extra.length) {
      log(`claude-agent-process: setting_sources "auto" is exclusive — ignoring [${extra.join(',')}]`)
    }
    const hasProjectConfig = !!workDir
      && (existsSync(join(workDir, '.claude')) || existsSync(join(workDir, 'CLAUDE.md')))
    return hasProjectConfig ? ['user', 'project', 'local'] : ['user']
  }

  const valid = tokens.filter(t => VALID_SETTING_SOURCES.has(t))
  const dropped = tokens.filter(t => !VALID_SETTING_SOURCES.has(t))
  if (dropped.length) {
    log(`claude-agent-process: setting_sources dropping unknown token(s) [${dropped.join(',')}]`)
  }
  return valid.length ? valid : [...DEFAULT_SETTING_SOURCES]
}
```

- [ ] **Step 5: 跑测试,确认通过**

Run: `bun test src/claude-agent-process.test.ts`
Expected: PASS,总数由 48 增至 55(48 + 7),0 fail。

- [ ] **Step 6: 提交**

```bash
git checkout -b feat/setting-sources-auto   # 若尚未在该分支
git add docs/superpowers/specs/2026-07-04-setting-sources-auto-design.md \
        docs/superpowers/plans/2026-07-04-setting-sources-auto.md \
        src/claude-agent-process.ts src/claude-agent-process.test.ts
git commit -m "feat(model): settingSources 加 auto 智能档 + 白名单过滤"
```

---

### Task 2: 接入调用点 + spawn 日志

**Files:**
- Modify: `src/claude-agent-process.ts:696`(调用点)、`:709`(spawn 日志)

**Interfaces:**
- Consumes:`settingSourcesFromProfile(profile, workDir)`(Task 1);`this.opts.workDir: string`。
- Produces:无新导出;运行期 spawn 日志新增 `settingSources=<a+b+c>` 字段。

- [ ] **Step 1: 调用点传入 workDir**

`src/claude-agent-process.ts:696` 由

```ts
    const settingSources = settingSourcesFromProfile(profile)
```

改为

```ts
    const settingSources = settingSourcesFromProfile(profile, this.opts.workDir)
```

- [ ] **Step 2: spawn 日志带上解析结果**

`src/claude-agent-process.ts:709` 由

```ts
      log(`claude-agent-process: spawn SDK query model=${model ?? 'default'} effort=${this.opts.effort} route=${routeLabel} cwd=${this.opts.workDir} executable=${executable.description}`)
```

改为(插入 `settingSources=${settingSources.join('+')}`):

```ts
      log(`claude-agent-process: spawn SDK query model=${model ?? 'default'} effort=${this.opts.effort} route=${routeLabel} cwd=${this.opts.workDir} settingSources=${settingSources.join('+')} executable=${executable.description}`)
```

- [ ] **Step 3: 跑测试确认无回归 + 构建通过**

Run: `bun test src/claude-agent-process.test.ts && bun run build`
Expected: 测试 55 pass 0 fail;`bun run build` 五个产物成功(无类型/打包错误)。

- [ ] **Step 4: 提交**

```bash
git add src/claude-agent-process.ts
git commit -m "feat(model): 调用点传 workDir + spawn 日志打 settingSources"
```

---

### Task 3: 文档(config.ts 注释 + README)

**Files:**
- Modify: `src/config.ts:90-91`(字段注释)、`:213`(parse 注释)
- Modify: `README.md:174`(表行)、`:180` 后(警告块)

**Interfaces:** 无代码接口;纯文档。

- [ ] **Step 1: config.ts 字段注释**

`src/config.ts:90-91` 由

```ts
  /** Comma-separated setting sources, e.g. `"project"` or `"user,project"`. */
  settingSources?: string
```

改为

```ts
  /** Comma-separated setting sources, e.g. `"project"` or `"user,project"`.
   * Special value `"auto"`: auto-detect `<cwd>/.claude` or `<cwd>/CLAUDE.md` →
   * `['user','project','local']` if present, else `['user']`.
   * See `settingSourcesFromProfile` in claude-agent-process.ts. */
  settingSources?: string
```

- [ ] **Step 2: config.ts parse 注释**

`src/config.ts:213` 由

```ts
          case 'setting_sources': profile.settingSources = value; break
```

改为

```ts
          // 原样存储;`"auto"` 与白名单校验在 settingSourcesFromProfile 处理
          case 'setting_sources': profile.settingSources = value; break
```

- [ ] **Step 3: README 表行**

`README.md:174` 由

```
| `setting_sources` | `project` 只读项目级设置,不加载用户级全局插件/技能 | `user` |
```

改为

```
| `setting_sources` | `auto`(推荐)检测到项目 `.claude/` 或 `CLAUDE.md` 就自动 `user,project,local`、否则退回 `user`(始终含 `user`,不卡死);`project` 只读项目级设置,不加载用户级全局插件/技能;也可显式逗号列表 | `user` |
```

- [ ] **Step 4: README 追加 `auto` 警告块**

在 `README.md:180`(`strict_mcp = "true"` 那段说明)之后、`:182` 的 `> ⚠️ **这组配置必须完整…**` 之前,插入一个空行加以下 blockquote:

```
> ⚠️ **`auto` 档要点**:仅对 **Claude 引擎**有效(Codex 无论如何自动读 `AGENTS.md`)。`auto` 是**独占值**,别写成 `auto,project`。命中后会**整体加载项目 `.claude/settings.json` 的 hooks**(`SessionStart`/`UserPromptSubmit`/`PreToolUse`/`Stop`),它们每轮在 daemon 内执行且无 TTY 回显 —— `PreToolUse` 退出非零会**拦掉该次工具调用**、表现为"莫名卡住/失败的一轮";`settingSources` 全有全无,**无法只要 skills/agents 而摘掉 hooks**。接入前先审项目 hooks 是否会在自动化通道阻塞。
```

- [ ] **Step 5: 提交**

```bash
git add src/config.ts README.md
git commit -m "docs(model): README/config 补 setting_sources=auto 档位与 hooks 警告"
```

---

## Deployment(手工,仓库外,非 TDD)

> 由用户在本机执行;daemon 由 LaunchAgent `com.supercc168.lodestar` 托管。

- [ ] **D1: 构建** — `bun run build`
- [ ] **D2: 重载 daemon** — `launchctl kickstart -k gui/$(id -u)/com.supercc168.lodestar`
- [ ] **D3: 开启 etmmo** — 编辑 `~/.config/lodestar/config.toml`,`[projects.etmmo]` 段加一行:

```toml
[projects.etmmo]
cwd             = "/Users/doge/svn/etmmo"
setting_sources = "auto"
```

- [ ] **D4: 验收** — 在 etmmo 飞书群发一条消息,查 daemon 日志确认出现 `settingSources=user+project+local`;群内验证项目 skill(如 `et-*`)、`/start` 命令、项目 `CLAUDE.md` 规范生效。若看到 hooks 阻塞/卡住,回到 spec「hooks 运维警告」排查项目 `settings.json`。

---

## Self-Review

**1. Spec coverage**(逐节对照 spec):
- 语义(含-token auto / 白名单 / 检测规则)→ Task 1 ✓
- 代码改动(函数签名、调用点 `:696`、日志 `:709`、`.claude` 检测)→ Task 1 + Task 2 ✓
- 测试 7 条(含 `auto,project` #6、未知 token #7)+ 回归 → Task 1 Step 2/5 ✓
- config.ts 注释 → Task 3 Step 1-2 ✓
- README(auto 行 + hooks 警告 + Claude-only)→ Task 3 Step 3-4 ✓
- 上线(build + kickstart + config.toml + 验收)→ Deployment ✓
- SDK 版本风险 → Global Constraints ✓
- 无遗漏需求。

**2. Placeholder scan:** 无 TBD/TODO;每个代码步给了完整可粘贴代码与精确行号。

**3. Type consistency:** 全程 `settingSourcesFromProfile(profile, workDir?)`,返回 `string[]`;Task 2 调用与 Task 1 定义一致;测试签名一致。`VALID_SETTING_SOURCES` 仅内部使用,不跨 task。✓
