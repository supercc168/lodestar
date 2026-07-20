# yiui-gsd 飞书 Lodestar 稳定可用 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让飞书 Lodestar 在 Codex/Claude 双后端下，用 GSD 状态卡按钮稳定管理任务，规划入口只走 yiui-gsd，并完成 macOS 可用的 `.planning` 桥接与 Claude 全局去 OMC/superpowers。

**Architecture:** Daemon 侧新增 `PlanningBridge` + `GsdStore` + GSD 状态卡/`gsd_*` card actions；元数据与链接只由 daemon 写盘。Agent 仅在「继续/开新任务」时被注入固定 GSD prompt，按项目 `yiui-gsd` 推进 phase。Claude 通过项目 `.claude` 入口发现 skill，并在用户全局关闭 OMC/superpowers。

**Tech Stack:** Bun/TypeScript（`src/`）、Feishu Card Kit schema 2.0、现有 `daemon.handleCardAction` / `session-commands` / `cards/*` 模式、PowerShell/`pwsh` 脚本对齐、`.gsd` 本地 git。

**Spec:** `docs/archive/specs/2026-07-20-yiui-gsd-feishu-stable-design.md`

## Global Constraints

- 唯一事实源：`.gsd/TRACKER.md` → 活跃 `TASK.md` → `.planning/STATE.md`；飞书卡不是第二状态源。
- 至多一个「运行中」任务；切换前必须先暂停旧任务。
- 元数据突变（建任务/暂停/完成/切活跃）只由 daemon `GsdStore` 执行；agent 不得口头改 TRACKER 充当权威。
- Provider **跟随当前群** `selectedProvider`，不强制切 Codex。
- 规划入口只允许 **yiui-gsd**；禁止 superpowers / OMC / ralplan / ralph / ultrawork / “plan this” 作为 GSD 入口。
- macOS/Linux：`.planning` 用 **symlink**；Windows：junction。禁止 `Remove-Item -Recurse` 删除链接时误删 canonical。
- 不自动重启 live daemon；代码改完只报告需重启；重启必须用户**当条消息**明确授权。
- 计划文档与历史资料落在 `docs/archive/**`，不再使用 `docs/superpowers/`。
- 测试：`bun test <file>`；全量 `bun test`；构建 `bun run build`（涉及发布时）。
- 钉死默认值：`awaiting_name` 超时 **300s**；turn 正常结束后 **自动轻量 `gsd_refresh`**（只读重绘，若无卡则跳过）；GSD 卡 `messageId` **session 内存**字段 `gsdPanelMessageId`（进程内），不强制 XDG 持久化（重启后 `gsd` 裸词重发新卡）。

---

## File map

| 文件 | 职责 |
|------|------|
| `src/gsd-bridge.ts` | 跨平台 `.planning` 链接：switch/health/clear |
| `src/gsd-bridge.test.ts` | bridge 单测（tmp dir + real fs） |
| `src/gsd-store.ts` | TRACKER/TASK 读写、状态机、slug、`.gsd` commit 触发 |
| `src/gsd-store.test.ts` | store 单测 |
| `src/gsd-prompt.ts` | 注入 prompt 模板纯函数 |
| `src/gsd-prompt.test.ts` | prompt 内容断言 |
| `src/cards/gsd.ts` | GSD 状态卡 schema |
| `src/cards/gsd.test.ts` | 卡渲染断言 |
| `src/cards/elements.ts` | 增加 `gsdPanel` element id |
| `src/cards.ts` | re-export gsd 卡 |
| `src/session-gsd.ts` | show panel、按钮处理、awaiting_name、注入 |
| `src/session.ts` | 委托方法 + 字段 + turn 结束刷新钩子 |
| `src/session-commands.ts` | 裸词 `gsd` |
| `daemon.ts` | `gsd_*` card actions |
| `.agents/skills/yiui-gsd/scripts/switch-active-task.ps1` | 跨平台对齐 bridge |
| `.agents/skills/yiui-gsd/extra-junction-bridge.md` | 文档改 symlink+junction |
| `.agents/skills/yiui-gsd/SKILL.md` | Feishu/daemon 边界说明 |
| `CLAUDE.md` 或 `.claude/CLAUDE.md` | 项目硬规则 |
| `.claude/skills/yiui-gsd` | 指向 `.agents/skills/yiui-gsd` 的发现入口 |
| `docs/开发与调试指南.md` | 短节：飞书 GSD 用法 |
| 本机 `~/.claude/settings.json` / `CLAUDE.md` | 全局关 OMC/superpowers（**不进 git**；步骤写在 Task 7） |

---

### Task 1: PlanningBridge（跨平台 `.planning` 链接）

**Files:**
- Create: `src/gsd-bridge.ts`
- Create: `src/gsd-bridge.test.ts`

**Interfaces:**
- Produces:
  - `export type BridgeHealth = { ok: boolean; kind: 'symlink' | 'junction' | 'missing' | 'not-link' | 'broken'; target?: string }`
  - `export function planningCanonical(projectRoot: string, taskSlug: string): string`
  - `export function ensureTaskPlanningDir(projectRoot: string, taskSlug: string): string`
  - `export function switchActivePlanning(projectRoot: string, taskSlug: string): BridgeHealth`
  - `export function planningHealth(projectRoot: string): BridgeHealth`
  - `export function clearPlanningBridge(projectRoot: string): void`

- [ ] **Step 1: Write failing tests**

```ts
// src/gsd-bridge.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, lstatSync, readlinkSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ensureTaskPlanningDir,
  switchActivePlanning,
  planningHealth,
  clearPlanningBridge,
} from './gsd-bridge'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gsd-bridge-'))
  mkdirSync(join(root, '.gsd', 'demo-task'), { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('gsd-bridge', () => {
  test('switchActivePlanning creates symlink to task .planning', () => {
    const health = switchActivePlanning(root, 'demo-task')
    expect(health.ok).toBe(true)
    expect(existsSync(join(root, '.planning'))).toBe(true)
    const st = lstatSync(join(root, '.planning'))
    expect(st.isSymbolicLink() || st.isDirectory()).toBe(true)
    // canonical dir exists
    expect(existsSync(join(root, '.gsd', 'demo-task', '.planning'))).toBe(true)
    writeFileSync(join(root, '.gsd', 'demo-task', '.planning', 'STATE.md'), '# ok\n')
    expect(existsSync(join(root, '.planning', 'STATE.md'))).toBe(true)
  })

  test('switchActivePlanning replaces previous link', () => {
    switchActivePlanning(root, 'demo-task')
    mkdirSync(join(root, '.gsd', 'other'), { recursive: true })
    switchActivePlanning(root, 'other')
    writeFileSync(join(root, '.gsd', 'other', '.planning', 'STATE.md'), 'b\n')
    expect(existsSync(join(root, '.planning', 'STATE.md'))).toBe(true)
    // old canonical untouched
    expect(existsSync(join(root, '.gsd', 'demo-task', '.planning'))).toBe(true)
  })

  test('refuses to replace real non-link .planning directory', () => {
    mkdirSync(join(root, '.planning'))
    writeFileSync(join(root, '.planning', 'keep.md'), 'x')
    expect(() => switchActivePlanning(root, 'demo-task')).toThrow(/not a (symlink|junction|link)/i)
    expect(existsSync(join(root, '.planning', 'keep.md'))).toBe(true)
  })

  test('planningHealth reports missing', () => {
    expect(planningHealth(root).kind).toBe('missing')
  })

  test('clearPlanningBridge removes link only', () => {
    switchActivePlanning(root, 'demo-task')
    writeFileSync(join(root, '.gsd', 'demo-task', '.planning', 'STATE.md'), 's\n')
    clearPlanningBridge(root)
    expect(existsSync(join(root, '.planning'))).toBe(false)
    expect(existsSync(join(root, '.gsd', 'demo-task', '.planning', 'STATE.md'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
bun test src/gsd-bridge.test.ts
```

Expected: fail resolving `./gsd-bridge` or missing exports.

- [ ] **Step 3: Implement `src/gsd-bridge.ts`**

```ts
import {
  existsSync, lstatSync, mkdirSync, readlinkSync, renameSync,
  rmSync, symlinkSync, unlinkSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { platform } from 'node:os'

export type BridgeHealth = {
  ok: boolean
  kind: 'symlink' | 'junction' | 'missing' | 'not-link' | 'broken'
  target?: string
}

export function planningCanonical(projectRoot: string, taskSlug: string): string {
  return join(projectRoot, '.gsd', taskSlug, '.planning')
}

export function ensureTaskPlanningDir(projectRoot: string, taskSlug: string): string {
  const dir = planningCanonical(projectRoot, taskSlug)
  mkdirSync(dir, { recursive: true })
  return dir
}

function linkPath(projectRoot: string): string {
  return join(projectRoot, '.planning')
}

function removeLinkOnly(link: string): void {
  if (!existsSync(link) && !existsSync(link)) {
    // broken symlink: existsSync false but lstat may work
  }
  try {
    const st = lstatSync(link)
    if (st.isSymbolicLink()) {
      unlinkSync(link)
      return
    }
    if (st.isDirectory()) {
      // Windows junction often appears as directory + reparse; try unlink first
      try { unlinkSync(link); return } catch { /* fallthrough */ }
      // last resort: rm without recursive content delete of target — only if reparse
      rmSync(link, { recursive: false, force: true })
      return
    }
    throw new Error('.planning exists and is not a symlink/junction/link')
  } catch (e: any) {
    if (e?.code === 'ENOENT') return
    throw e
  }
}

export function switchActivePlanning(projectRoot: string, taskSlug: string): BridgeHealth {
  const canonical = ensureTaskPlanningDir(projectRoot, taskSlug)
  const link = linkPath(projectRoot)
  if (existsSync(link) || safeLstat(link)) {
    const st = lstatSync(link)
    if (!st.isSymbolicLink()) {
      // allow directory only if we can unlink as junction; else refuse real trees with children handled by removeLinkOnly throw
      try { removeLinkOnly(link) } catch {
        throw new Error('.planning exists and is not a symlink/junction/link')
      }
    } else {
      unlinkSync(link)
    }
  }
  // prefer relative target for portability
  let target = relative(projectRoot, canonical)
  if (!target || target === '') target = canonical
  try {
    symlinkSync(target, link, platform() === 'win32' ? 'junction' : 'dir')
  } catch {
    symlinkSync(canonical, link, platform() === 'win32' ? 'junction' : 'dir')
  }
  return planningHealth(projectRoot)
}

function safeLstat(p: string) {
  try { return lstatSync(p); } catch { return null }
}

export function planningHealth(projectRoot: string): BridgeHealth {
  const link = linkPath(projectRoot)
  const st = safeLstat(link)
  if (!st) return { ok: false, kind: 'missing' }
  if (st.isSymbolicLink()) {
    let target: string | undefined
    try { target = readlinkSync(link) } catch { /* */ }
    const resolvedOk = existsSync(link) // follows link
    if (!resolvedOk) return { ok: false, kind: 'broken', target }
    return { ok: true, kind: 'symlink', target }
  }
  if (st.isDirectory()) {
    // could be junction on win or accidental real dir
    if (platform() === 'win32') return { ok: true, kind: 'junction' }
    return { ok: false, kind: 'not-link' }
  }
  return { ok: false, kind: 'not-link' }
}

export function clearPlanningBridge(projectRoot: string): void {
  const link = linkPath(projectRoot)
  if (!safeLstat(link)) return
  removeLinkOnly(link)
}
```

Refine until tests pass on macOS (symlink path). Adjust “refuses real directory” to match implementation (throw message stable).

- [ ] **Step 4: Run tests — expect PASS**

```bash
bun test src/gsd-bridge.test.ts
```

- [ ] **Step 5: Align yiui-gsd script + docs**

Update `.agents/skills/yiui-gsd/scripts/switch-active-task.ps1` to:
- On non-Windows: create symlink (`New-Item -ItemType SymbolicLink` or `/bin/ln -sfn`)
- On Windows: keep junction
- Never recurse-delete canonical

Update `extra-junction-bridge.md` title/body to “Planning bridge (symlink / junction)” with Darwin/Linux section.

Update `SKILL.md` one bullet: Feishu/Lodestar daemon owns TRACKER mutations when panel is used; scripts must match `src/gsd-bridge.ts` semantics.

- [ ] **Step 6: Commit**

```bash
git add src/gsd-bridge.ts src/gsd-bridge.test.ts \
  .agents/skills/yiui-gsd/scripts/switch-active-task.ps1 \
  .agents/skills/yiui-gsd/extra-junction-bridge.md \
  .agents/skills/yiui-gsd/SKILL.md
git commit -m "$(cat <<'EOF'
feat(gsd): cross-platform .planning bridge

Symlink on macOS/Linux, junction on Windows; refuse clobbering a real
.planning directory; align yiui-gsd switch script and docs.
EOF
)"
```

---

### Task 2: GsdStore（TRACKER / TASK 状态机）

**Files:**
- Create: `src/gsd-store.ts`
- Create: `src/gsd-store.test.ts`

**Interfaces:**
- Consumes: `switchActivePlanning`, `planningHealth`, `ensureTaskPlanningDir` from `./gsd-bridge`
- Produces:
  - `export type GsdTaskStatus = '无任务' | '运行中' | '已暂停' | '已完成'`
  - `export type GsdSnapshot = { status: GsdTaskStatus; taskSlug: string; taskName: string; phase: string; updatedAt: string; planningPath: string; note: string; bridge: BridgeHealth; phaseHint?: string }`
  - `export function readGsdSnapshot(projectRoot: string): GsdSnapshot`
  - `export function createAndActivateTask(projectRoot: string, taskName: string, opts?: { slug?: string }): GsdSnapshot`
  - `export function pauseActiveTask(projectRoot: string): GsdSnapshot`
  - `export function completeActiveTask(projectRoot: string): GsdSnapshot`
  - `export function slugifyTaskName(name: string): string`

- [ ] **Step 1: Write failing tests**

```ts
// src/gsd-store.test.ts — key cases
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import {
  createAndActivateTask,
  pauseActiveTask,
  completeActiveTask,
  readGsdSnapshot,
  slugifyTaskName,
} from './gsd-store'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gsd-store-'))
  mkdirSync(join(root, '.gsd'), { recursive: true })
  writeFileSync(join(root, '.gsd', 'TRACKER.md'), `# GSD 任务跟踪

## 当前活跃任务

- 状态：无任务
- task_slug：
- 任务名称：
- 当前阶段：unknown
- 最后更新：
- planning_path：
- 备注：

## 任务索引

| task_slug | 名称 | 状态 | 创建时间 | 最后更新 |
|-----------|------|------|----------|----------|
`)
  execSync('git init', { cwd: join(root, '.gsd') })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('slugifyTaskName kebab', () => {
  expect(slugifyTaskName('Watchdog 恢复 边界')).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
})

test('createAndActivateTask sets running and bridge', () => {
  const snap = createAndActivateTask(root, 'Demo Task')
  expect(snap.status).toBe('运行中')
  expect(snap.taskSlug.length).toBeGreaterThan(0)
  expect(snap.bridge.ok).toBe(true)
  const tracker = readFileSync(join(root, '.gsd', 'TRACKER.md'), 'utf8')
  expect(tracker).toContain('状态：运行中')
  expect(readFileSync(join(root, '.gsd', snap.taskSlug, 'TASK.md'), 'utf8')).toContain('Demo Task')
})

test('second create pauses previous', () => {
  const a = createAndActivateTask(root, 'Alpha')
  const b = createAndActivateTask(root, 'Beta')
  expect(b.status).toBe('运行中')
  expect(b.taskSlug).not.toBe(a.taskSlug)
  const alphaTask = readFileSync(join(root, '.gsd', a.taskSlug, 'TASK.md'), 'utf8')
  expect(alphaTask).toMatch(/已暂停|暂停/)
})

test('pause and complete', () => {
  createAndActivateTask(root, 'X')
  expect(pauseActiveTask(root).status).toBe('已暂停')
  expect(completeActiveTask(root).status).toBe('已完成')
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test src/gsd-store.test.ts
```

- [ ] **Step 3: Implement store**

Implementation notes (must follow):
- Parse TRACKER with simple line-based field updates for the「当前活跃任务」block; rewrite index table row for slug.
- `TASK.md` minimal front body: name + status + updated.
- On create: pause any existing 运行中 (TASK + tracker index), write new TASK, `switchActivePlanning`, update tracker active block, `git -C .gsd add -A && git commit` (ignore empty commit errors).
- `phaseHint`: if `.planning/STATE.md` or canonical STATE exists, read first `phase`/`current_phase`/`Progress` line heuristically; else `unknown`.
- `slugifyTaskName`: NFKD, remove non-alnum, kebab, fallback `task`; if dir exists append `-2`, `-3`.

- [ ] **Step 4: Run — expect PASS**

```bash
bun test src/gsd-store.test.ts src/gsd-bridge.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/gsd-store.ts src/gsd-store.test.ts
git commit -m "$(cat <<'EOF'
feat(gsd): TRACKER/TASK store with single running task

Create/pause/complete update .gsd disk state and planning bridge;
commit into the local .gsd git repo when possible.
EOF
)"
```

---

### Task 3: GSD 状态卡 + prompt 模板

**Files:**
- Create: `src/gsd-prompt.ts`
- Create: `src/gsd-prompt.test.ts`
- Create: `src/cards/gsd.ts`
- Create: `src/cards/gsd.test.ts`
- Modify: `src/cards/elements.ts` — add `gsdPanel: 'gsd_panel'`
- Modify: `src/cards.ts` — export gsd card types/fn

**Interfaces:**
- Produces:
  - `export function buildGsdInjectPrompt(input: { action: 'continue' | 'new-task-discuss'; taskSlug: string; taskName: string; provider: string }): string`
  - `export function gsdPanelCard(opts: GsdPanelOpts): object`
  - `export type GsdPanelOpts = { snapshot: GsdSnapshot; providerLabel: string; panelGen: string; notice?: { type: 'success'|'error'|'info'; content: string }; awaitingName?: boolean }`

- [ ] **Step 1: Failing tests for prompt**

```ts
// src/gsd-prompt.test.ts
import { describe, expect, test } from 'bun:test'
import { buildGsdInjectPrompt } from './gsd-prompt'

test('prompt forces yiui-gsd and bans old planners', () => {
  const p = buildGsdInjectPrompt({
    action: 'continue',
    taskSlug: 'demo',
    taskName: 'Demo',
    provider: 'claude',
  })
  expect(p).toContain('[Lodestar GSD]')
  expect(p).toContain('yiui-gsd')
  expect(p).toContain('demo')
  expect(p).toMatch(/superpowers|OMC|ralplan/i)
  expect(p).toContain('TRACKER')
})
```

- [ ] **Step 2: Implement prompt**

```ts
// src/gsd-prompt.ts
export function buildGsdInjectPrompt(input: {
  action: 'continue' | 'new-task-discuss'
  taskSlug: string
  taskName: string
  provider: string
}): string {
  const actionLine = input.action === 'continue'
    ? '当前动作: continue — 从 STATE 单调游标推进唯一下一步（$gsd-progress --next 语义）'
    : '当前动作: new-task-discuss — 按 yiui-gsd 为新任务建立/刷新 planning 基线并进入 discuss/onboard'
  return [
    '[Lodestar GSD]',
    '- 只用 yiui-gsd；禁止 superpowers / OMC / oh-my-claudecode / ralplan / ralph / ultrawork / “plan this” 旧规划入口',
    '- 先读 .gsd/TRACKER.md 与活跃任务 STATE.md（经项目根 .planning）',
    actionLine,
    `- task_slug: ${input.taskSlug}`,
    `- 任务名: ${input.taskName}`,
    `- provider: ${input.provider}`,
    '- 完成后用中文简报：状态、phase、下一步；不得重做已 GREEN/已验证项',
    '- 状态以磁盘为准；不要把聊天计划当作 TRACKER',
  ].join('\n')
}
```

- [ ] **Step 3: Card tests + implement `cards/gsd.ts`**

Follow `src/cards/task.ts` patterns: schema 2.0, markdown body, button column with short labels `进度` `继续` `暂停` `完成` `新任务`.

Callback values:

```ts
{ kind: 'gsd_refresh', task_slug, panel_gen: panelGen }
{ kind: 'gsd_continue', task_slug, panel_gen: panelGen }
{ kind: 'gsd_pause', task_slug, panel_gen: panelGen }
{ kind: 'gsd_complete', task_slug, panel_gen: panelGen }
{ kind: 'gsd_new_prompt', task_slug: task_slug || '', panel_gen: panelGen }
```

Disable logic in rendering (still show buttons but notice if needed): prefer enable all and let handlers toast errors (simpler, matches task panel style).

Assert card JSON contains kinds and task name.

- [ ] **Step 4: Export via `cards.ts` + ELEMENTS**

- [ ] **Step 5: Run**

```bash
bun test src/gsd-prompt.test.ts src/cards/gsd.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/gsd-prompt.ts src/gsd-prompt.test.ts src/cards/gsd.ts src/cards/gsd.test.ts src/cards/elements.ts src/cards.ts
git commit -m "$(cat <<'EOF'
feat(cards): GSD status panel and inject prompt template

Feishu card buttons use gsd_* kinds; prompts pin yiui-gsd-only planning.
EOF
)"
```

---

### Task 4: Session GSD 面板逻辑 + 裸词 + card actions

**Files:**
- Create: `src/session-gsd.ts`
- Create: `src/session-gsd.test.ts` (pure helpers if any; handler tests with mocks where cheap)
- Modify: `src/session.ts` — fields + thin delegates
- Modify: `src/session-commands.ts` — `gsd` bareword
- Modify: `daemon.ts` — `gsd_*` cases
- Modify: `src/card-action.test.ts` or add `src/session-gsd` coverage for panel_gen mismatch if pattern exists

**Interfaces:**
- Consumes: `readGsdSnapshot`, store mutators, `gsdPanelCard`, `buildGsdInjectPrompt`
- Produces on Session:
  - `gsdPanelMessageId: string | null`
  - `gsdPanelGen: string`
  - `gsdAwaitingNameUntil: number` (0 = off)
  - `showGsdPanel()`, `onGsdRefresh/Continue/Pause/Complete/NewPrompt(...)`, `maybeConsumeGsdTaskName(text): Promise<boolean>`, `refreshGsdPanelIfPresent()`

**Pinned behavior:**
- `panelGen`: `String(Date.now())` on each successful render; store on session; actions must match or toast「面板已过期，请发 gsd 刷新」.
- `awaiting_name`: 300_000 ms; `maybeConsumeGsdTaskName` called from message path **before** normal agent forward when `Date.now() < gsdAwaitingNameUntil`.
- `gsd_continue`: if `s.isRunning()` **and** there is an active turn in flight — use the same busy signal session already uses for mid-turn policy. Practical rule for this plan: if `s.isRunning()` and session has an open turn card / non-idle turn state, reject continue with toast `会话忙碌，稍后再继续 GSD`. If implementer finds a sharper `isTurnActive` helper, use it; do not `stop()` implicitly.
- Inject via existing user text path (`onUserMessage` / internal send that goes through ACK pipeline). Prefer a dedicated method that calls the same path as a normal user message so cards/reactions stay consistent. Prefix inject text with the template (visible).
- After turn completes successfully, call `refreshGsdPanelIfPresent()` (ignore errors).

- [ ] **Step 1: Implement `session-gsd.ts` structure**

Mirror `session-tasklist.ts`:

```ts
// outline
export async function showGsdPanel(s: Session): Promise<void>
export async function onGsdRefresh(s: Session, taskSlug: string, panelGen: string): Promise<GsdActionResult>
export async function onGsdContinue(...)
export async function onGsdPause(...)
export async function onGsdComplete(...)
export async function onGsdNewPrompt(...)
export async function maybeConsumeGsdTaskName(s: Session, text: string): Promise<boolean>
export async function refreshGsdPanelIfPresent(s: Session): Promise<void>

export type GsdActionResult = {
  ok: boolean
  message: string
  card?: object
}
```

Render helper:

```ts
function render(s: Session, notice?: ..., awaitingName = false) {
  const snapshot = readGsdSnapshot(s.workDir)
  s.gsdPanelGen = String(Date.now())
  return cards.gsdPanelCard({
    snapshot,
    providerLabel: s.currentProvider(),
    panelGen: s.gsdPanelGen,
    notice,
    awaitingName,
  })
}
```

Send vs update:
- If `s.gsdPanelMessageId` set → `feishu.updateCard(id, card)` when possible; on failure send new card and replace id.
- Else `feishu.sendCard` and store id.

Continue path:
1. validate panelGen
2. snapshot must have 运行中 or 已暂停 (if paused, store.activate/resume to 运行中 — if store lacks resume, `create` not needed: set status 运行中 on active slug via small `resumeActiveTask` export added in this task if missing)
3. bridge health ok or try `switchActivePlanning` once
4. busy check → toast
5. `buildGsdInjectPrompt` + deliver as user message
6. return card refresh + toast 已注入

New prompt path: set `gsdAwaitingNameUntil = Date.now() + 300_000`, refresh card with awaiting banner.

Name consume: `createAndActivateTask(s.workDir, name)` → inject `new-task-discuss` → clear awaiting.

- [ ] **Step 2: Wire Session**

Add fields defaults in constructor area next to other panel state.  
Add delegates like tasklist.  
In inbound user message handling (find where `runCommand` is false and message goes to agent), **first**:

```ts
if (await sessionGsd.maybeConsumeGsdTaskName(this, text)) return
```

Find turn-complete/close path → `void sessionGsd.refreshGsdPanelIfPresent(this)`.

- [ ] **Step 3: Bareword**

In `session-commands.ts` before generic control map:

```ts
if (raw.trim().match(/^gsd(?:\s+status)?$/i)) {
  await s.showGsdPanel()
  return true
}
```

- [ ] **Step 4: daemon actions**

```ts
case 'gsd_refresh': {
  const result = await session.onGsdRefresh(String(value.task_slug ?? ''), String(value.panel_gen ?? ''))
  return result.card ? actionCardResponse(result.card) : { toast: { type: result.ok ? 'success' : 'error', content: result.message } }
}
// same pattern for continue/pause/complete/new_prompt
```

- [ ] **Step 5: Tests**

- Unit-test panelGen mismatch returns ok:false without throwing (extract validatePanelGen).
- Command recognition: if there is existing session-commands test harness, add `gsd` → consumed; else minimal test of a pure `isGsdBareword(raw)` moved to session-gsd or session-commands export for test.

- [ ] **Step 6: Run**

```bash
bun test src/gsd-bridge.test.ts src/gsd-store.test.ts src/gsd-prompt.test.ts src/cards/gsd.test.ts src/session-gsd.test.ts src/card-action.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/session-gsd.ts src/session-gsd.test.ts src/session.ts src/session-commands.ts daemon.ts
git commit -m "$(cat <<'EOF'
feat(gsd): Feishu GSD panel actions and session injection

Bareword gsd opens the status card; buttons mutate TRACKER via store
or inject yiui-gsd prompts on continue/new-task.
EOF
)"
```

---

### Task 5: Claude 项目入口（双后端可发现 yiui-gsd）

**Files:**
- Create: `CLAUDE.md` (project root) **or** `.claude/CLAUDE.md` if repo prefers hidden — use **root `CLAUDE.md`** only if it won’t fight AGENTS.md; otherwise `.claude/CLAUDE.md`. Prefer `.claude/CLAUDE.md` + ensure settingSources include project (default already does when `.claude` exists).
- Create: `.claude/skills/yiui-gsd` as symlink to `../../.agents/skills/yiui-gsd` (relative).  
  If git symlink problematic on Windows contributors, use a tiny `SKILL.md` that says “canonical at `.agents/skills/yiui-gsd` — read that path” **and** still keep full skill under `.agents` (Claude may need real files: if symlink fails in CI, copy is worse; prefer symlink + document).

Also add short pointer in root `AGENTS.md` MANUAL section? Spec says project CLAUDE entry; optional one paragraph in `AGENTS.md` under MANUAL: “GSD/长任务 → yiui-gsd；飞书用 gsd 卡”. Include it for Codex sessions that read AGENTS.md.

- [ ] **Step 1: Write `.claude/CLAUDE.md`**

```markdown
# Lodestar project rules (Claude)

## GSD / 长任务规划
- 多阶段、长任务、需要 TRACKER/阶段推进时，**必须**使用项目 skill `yiui-gsd`（路径 `.agents/skills/yiui-gsd`，Claude 入口 `.claude/skills/yiui-gsd`）。
- 任何 GSD 操作前先读 `.gsd/TRACKER.md`；活跃任务 STATE 经项目根 `.planning/`。
- **禁止**使用 superpowers / oh-my-claudecode(OMC) / ralplan / ralph / ultrawork / “plan this” 作为规划入口。
- 飞书 Lodestar 场景：daemon 可能已更新 TRACKER/bridge；不要重复创建冲突任务；继续时以磁盘为准。
- 元数据（暂停/完成/切换活跃）若由用户在飞书 GSD 卡完成，agent 只推进 phase 内容。
```

- [ ] **Step 2: Symlink skill**

```bash
mkdir -p .claude/skills
ln -sfn ../../.agents/skills/yiui-gsd .claude/skills/yiui-gsd
ls -la .claude/skills/yiui-gsd/SKILL.md
```

- [ ] **Step 3: AGENTS.md MANUAL 补 5–10 行 GSD/飞书指针**（若 MANUAL 区存在则追加）

- [ ] **Step 4: Commit**

```bash
git add .claude/CLAUDE.md .claude/skills/yiui-gsd AGENTS.md
git commit -m "$(cat <<'EOF'
feat(gsd): expose yiui-gsd to Claude project settings

Add .claude rules and skill link so Feishu Claude sessions load the
same GSD entry as Codex.
EOF
)"
```

---

### Task 6: 用户文档 + 开发指南

**Files:**
- Modify: `docs/开发与调试指南.md` — short section「飞书 GSD 状态卡」
- Optional: README 一行入口（仅当 README 已有命令表时）

Content must include:
- 群内发 `gsd` 开卡
- 按钮含义
- 跟随当前 model
- 规划只走 yiui-gsd
- 需重启 daemon 后生效（代码变更后）
- Claude 全局清理见运维步骤（Task 7，本机）

- [ ] **Step 1: Edit docs**
- [ ] **Step 2: Commit**

```bash
git add docs/开发与调试指南.md
git commit -m "docs: Feishu GSD panel usage"
```

---

### Task 7: Claude 全局清理（本机，不进仓库）

**Files (user home, NOT git):**
- `~/.claude/settings.json`
- `~/.claude/CLAUDE.md`
- backup dir `~/.claude/backups/yiui-gsd-<timestamp>/`

- [ ] **Step 1: Backup**

```bash
stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p "$HOME/.claude/backups/yiui-gsd-$stamp"
cp -a "$HOME/.claude/settings.json" "$HOME/.claude/backups/yiui-gsd-$stamp/"
cp -a "$HOME/.claude/CLAUDE.md" "$HOME/.claude/backups/yiui-gsd-$stamp/" 2>/dev/null || true
echo "backup=$HOME/.claude/backups/yiui-gsd-$stamp"
```

- [ ] **Step 2: Disable plugins + OMC statusLine**

Edit `settings.json`:
- `enabledPlugins["oh-my-claudecode@omc"] = false`
- `enabledPlugins["superpowers@superpowers-marketplace"] = false`
- Remove or neutralize `statusLine` if it points at `omc-hud.mjs`
- Keep `typescript-lsp@claude-plugins-official`

Validate JSON parses.

- [ ] **Step 3: Replace OMC CLAUDE.md block**

Remove `<!-- OMC:START -->…<!-- OMC:END -->`.  
Write short global note: long-running planning uses yiui-gsd when available; do not use OMC/superpowers planning entrypoints.

- [ ] **Step 4: Remove omc-reference skill link if present**

```bash
rm -f "$HOME/.claude/skills/omc-reference"
```

- [ ] **Step 5: Verify**

```bash
python3 - <<'PY'
import json
from pathlib import Path
s=json.loads(Path.home().joinpath('.claude/settings.json').read_text())
print(s.get('enabledPlugins'))
assert s.get('enabledPlugins',{}).get('oh-my-claudecode@omc') in (False, None)
assert s.get('enabledPlugins',{}).get('superpowers@superpowers-marketplace') in (False, None)
text=Path.home().joinpath('CLAUDE.md').read_text() if False else Path.home().joinpath('.claude/CLAUDE.md').read_text()
assert 'OMC:START' not in text
print('claude global ok')
PY
```

- [ ] **Step 6: Document rollback in chat/report** (no commit required). Do **not** commit home files.

---

### Task 8: 集成验收与回归

- [ ] **Step 1: Automated**

```bash
bun test src/gsd-bridge.test.ts src/gsd-store.test.ts src/gsd-prompt.test.ts src/cards/gsd.test.ts src/session-gsd.test.ts
bun test
bun run build
```

Expected: all pass (or pre-existing known failures documented — do not add new failures).

- [ ] **Step 2: Local disk smoke (no live daemon restart unless user authorizes)**

```bash
# in repo root
pwsh -NoProfile -File .agents/skills/yiui-gsd/scripts/switch-active-task.ps1 -TaskSlug demo-smoke || true
# or node/bun snippet calling switchActivePlanning on a temp clone of .gsd layout
```

Verify symlink health with `planningHealth` via a one-off `bun -e` if needed.

- [ ] **Step 3: Feishu smoke checklist (needs user + possibly authorized restart)**

1. Restart daemon only if user says so in **current** message.  
2. Codex model: `gsd` → card → 新任务 → 给名 → TRACKER 运行中 → bridge OK → 继续注入。  
3. Claude model: same.  
4. 暂停/完成/过期按钮/忙碌拒绝。  
5. 刷新与磁盘一致。

- [ ] **Step 4: Final commit only if docs/tests fixed**

```bash
git status --short
# commit any leftover fixes
```

- [ ] **Step 5: Report**

List commits, files, verification evidence, remaining risks (global Claude cleanup done or not, live Feishu pending auth).

---

## Self-review vs spec

| Spec section | Task |
|--------------|------|
| §5 PlanningBridge | Task 1 |
| §6 GsdStore | Task 2 |
| §7 GSD 卡 + actions | Task 3–4 |
| §8 注入契约 | Task 3–4 |
| §9 双后端发现 | Task 5 |
| §10 Claude 全局清理 | Task 7 |
| §11 yiui-gsd skill 改动 | Task 1 (+ phrase notes if needed in Task 5) |
| §12 测试验收 | Task 8 |
| §13 顺序 | Task 1→8 |
| 钉死：300s awaiting、session messageId、turn 后 refresh | Task 4 Global Constraints |

Placeholder scan: no TBD/TODO left in steps.  
Type names consistent: `GsdSnapshot`, `BridgeHealth`, `GsdActionResult`, `panel_gen` / `gsdPanelGen`.

---

## Execution handoff

Plan complete and saved to `docs/archive/plans/2026-07-20-yiui-gsd-feishu-stable.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — this session with executing-plans checkpoints  

Which approach?
