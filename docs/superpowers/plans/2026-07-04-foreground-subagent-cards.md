# 前台具名子agent 进后台状态卡 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让交互会话派的前台具名子agent(economy-designer 等)也进「后台游标卡」建单独状态卡,裸前台 bash 仍藏。

**Architecture:** 唯一逻辑改动是 `src/cards/background.ts` 的 `isInherentlyBackground()` 白名单加 `'subagent'`——前台子agent `task_started` 即入 active、复用既有渲染/steps/沉降机制;`shell`/`unknown`(裸 bash)仍落 pending 观察池。外加同步模块注释、三处 summary 文案(后台任务→子agent)、翻转对应测试。session 层零改动(active 池驱动开卡,不按类型过滤)。

**Tech Stack:** TypeScript,Bun runtime + `bun test`,Feishu Card Kit schema 2.0。

## Global Constraints

- 放行范围:所有 `subagent`(`type=subagent`,任何 `subagent_type`)直入 active;`shell`(裸前台 bash)/ `unknown` 仍进 pending(保留 f7e4ef1 的"bash 噪音"防线)。
- `is_backgrounded:true` 提升路径**不变**(Ctrl+B 的 bash 仍能从 pending 提升)。
- summary 文案:`🧭 后台任务` → `🧭 子agent`(live / history / migrated marker 三处)。
- session 层零改动;渲染 / steps / 沉降机制全部复用不动。
- 校验只用 `bun test <file>` 与 `bun run build`。
- 分支 `feat/foreground-subagent-cards`(off main,已 checkout;不新建分支)。

---

## File Structure

- **改** `src/cards/background.ts` — `isInherentlyBackground` 加 `'subagent'` + 同步模块头注释 + 该函数注释 + 三处 summary 文案。
- **改** `src/cards/background.test.ts` — 翻转 3 个编码旧行为的用例、relabel 2 个 pending-steps 用例、补 1 个 summary 文案用例。裸 bash 的噪音防线用例(§不动)保持不变。

---

## Task 1: 放行前台子agent 进卡(逻辑 + 文案 + 测试)

**Files:**
- Modify: `src/cards/background.ts`(`isInherentlyBackground` ~117-120、模块头 ~27-32、三处 summary)
- Modify: `src/cards/background.test.ts`(翻转/relabel/新增用例)

**Interfaces:**
- Consumes: 既有 `applyBgTaskStarted` / `applyBgToolUse` / `applyBgTaskUpdated` / `backgroundLiveCard` / `backgroundHistoryCard` / `backgroundMigratedMarker` / `emptyBgStore` / `hasActiveBgTask`(全不改签名)。
- Produces: 无新导出——纯行为变更(subagent 路由 pending→active)。

TDD 次序:先把测试改成**新**预期(对旧代码会红),跑红,再改 `background.ts` 转绿。

- [ ] **Step 1: 把编码旧行为的测试改成新预期(3 处翻转)**

在 `src/cards/background.test.ts`:

(a) 用例 `'前台子 agent 进 pending'`(现约 55-59 行)整体替换为——前台子agent 现直入 active:

```ts
  test('前台子 agent 直入 active 并标 isBackgrounded', () => {
    const s = applyBgTaskStarted(emptyBgStore(), { task_id: 'a1', description: '搜索', subagent_type: 'Explore' })
    expect(s.pending).toHaveLength(0)
    expect(s.active[0]).toMatchObject({ id: 'a1', type: 'subagent', subagentType: 'Explore', isBackgrounded: true })
  })
```

(b) 用例 `'local_ 前缀归一化…'`(现约 61-65 行)里 `local_agent` 那行的 `.pending[0]` 改成 `.active[0]`(其余两行不动):

```ts
  test('local_ 前缀归一化:local_bash→shell / local_agent→subagent / local_workflow→workflow', () => {
    expect(applyBgTaskStarted(emptyBgStore(), { task_id: 'b', task_type: 'local_bash', description: 'x' }).pending[0].type).toBe('shell')
    expect(applyBgTaskStarted(emptyBgStore(), { task_id: 'a', task_type: 'local_agent', description: 'x' }).active[0].type).toBe('subagent')
    expect(applyBgTaskStarted(emptyBgStore(), { task_id: 'w', task_type: 'local_workflow', description: 'x' }).active[0].type).toBe('workflow')
  })
```

(c) 端到端用例 `'端到端:前台子 agent 攒 steps → 后台化提升 → steps 随 entry 到 active'`(现约 225-238 行)整体替换为——subagent 现从头就在 active、steps 直接落 active:

```ts
  test('端到端:前台子 agent started 直入 active,steps 直接落 active', () => {
    let s = emptyBgStore()
    s = applyBgTaskStarted(s, { task_id: 'a1', task_type: 'local_agent', description: '搜索', subagent_type: 'Explore', tool_use_id: 'p' })
    expect(s.active).toHaveLength(1)
    expect(s.pending).toHaveLength(0)
    s = applyBgToolUse(s, 'p', 'tu_1', 'Grep', { pattern: 'auth', path: 'src' })
    s = applyBgToolResult(s, 'p', 'tu_1', '命中', false)
    expect(s.active[0].steps).toHaveLength(1)
    expect(s.active[0].steps[0].brief).toBe('Grep "auth" in src → 命中')
  })
```

- [ ] **Step 2: relabel 两个 pending-steps 用例(去掉已失真的"子agent"措辞)**

改后 subagent 不再经 pending,故这两个"pending 池累积 steps"的单元用例改用 `type: 'shell'` 承载、措辞改为双池对称,避免断言旧场景。

(a) `'pending 里的前台子 agent 也累积 steps(提升前攒过程)'`(现约 193-197 行)替换为:

```ts
  test('pending 池的 task 也累积 steps(双池对称)', () => {
    let s: BgStore = { active: [], pending: [mk({ id: 't1', type: 'shell', toolUseId: 'p', status: 'running' })] }
    s = applyBgToolUse(s, 'p', 'tu_1', 'Grep', { pattern: 'auth', path: 'src' })
    expect(s.pending[0].steps).toHaveLength(1)
  })
```

(b) `'tool_result 按 tool_use_id 回填结果到对应 step(双池)'`(现约 199-204 行)里把 pending 项加上 `type: 'shell'`(其余不动):

```ts
  test('tool_result 按 tool_use_id 回填结果到对应 step(双池)', () => {
    let s: BgStore = { active: [], pending: [mk({ id: 't1', type: 'shell', toolUseId: 'p', status: 'running' })] }
    s = applyBgToolUse(s, 'p', 'tu_1', 'Grep', { pattern: 'auth', path: 'src' })
    s = applyBgToolResult(s, 'p', 'tu_1', '命中 3 处', false)
    expect(s.pending[0].steps[0].brief).toBe('Grep "auth" in src → 命中 3 处')
  })
```

- [ ] **Step 3: 补一个 summary 文案用例**

在 `describe('isBgTerminal / hasActiveBgTask', …)` 之前(文件末尾附近)追加一个 describe,断言新文案:

```ts
describe('summary 文案:🧭 子agent', () => {
  test('live 卡 summary 用「🧭 子agent」', () => {
    const card = backgroundLiveCard([mk({ id: 't1', type: 'subagent', subagentType: 'Explore', status: 'running' })]) as any
    expect(card.config.summary.content).toContain('🧭 子agent')
    expect(card.config.summary.content).not.toContain('后台任务')
  })

  test('history 卡 summary 用「🧭 子agent(历史)」', () => {
    const card = backgroundHistoryCard([mk({ id: 't1', type: 'subagent', status: 'completed', endTime: 5000 })]) as any
    expect(card.config.summary.content).toContain('🧭 子agent(历史)')
  })
})
```

- [ ] **Step 4: 跑测试确认失败(红)**

Run: `bun test src/cards/background.test.ts`
Expected: FAIL —— 翻转的用例(a/b/c)与 summary 用例对旧代码为红(subagent 仍进 pending、summary 仍是「后台任务」)。

- [ ] **Step 5: 改 `background.ts` 逻辑(白名单加 subagent)**

在 `src/cards/background.ts`,把 `isInherentlyBackground`(现约 115-120 行)连注释替换为:

```ts
/** 天生入卡的 task_type:workflow / monitor 是 fire-and-forget 后台执行模型;
 *  subagent(Task 工具派的具名子agent)是实质工作,即便前台执行也值得单独建卡
 *  显示进度。三者 task_started 即入 active。shell(前台裸 bash)/ unknown 仍是
 *  噪音源,先落 pending 观察池,等 is_backgrounded:true(Ctrl+B)才提升。 */
function isInherentlyBackground(type: BgTaskType): boolean {
  return type === 'workflow' || type === 'monitor' || type === 'subagent'
}
```

- [ ] **Step 6: 同步模块头 doc 注释**

在 `src/cards/background.ts` 模块头(现约 27-32 行),把「前台/后台区分」那段替换为(去掉"子 agent 默认全是前台、不该进卡",改成"子agent 天生入卡"):

```ts
 * 前台/后台区分(SDK sdk.d.ts:2750):Bash 命令和子 agent 默认都是前台 task,
 * 每条都发 task_started。子agent(具名,实质工作)天生入卡:task_started 即入
 * active。前台裸 Bash / unknown 是噪音源,先落 pending 观察池,只有被显式后台化
 * (Ctrl+B / background_tasks 控制请求)收到 is_backgrounded:true 才提升入 active。
 * workflow/monitor 是天生后台执行模型,同样白名单直入 active。
```

- [ ] **Step 7: 改三处 summary 文案(后台任务 → 子agent)**

在 `src/cards/background.ts`:

(a) `backgroundLiveCard`(现约 447 行):
```ts
      summary: { content: `🧭 子agent · ${summarizeBackground(tasks)}` },
```

(b) `backgroundHistoryCard`(现约 463 行):
```ts
      summary: { content: `🧭 子agent(历史) · ${terminal.length} 已结束` },
```

(c) `backgroundMigratedMarker`(现约 472-486 行)的 summary 与 body:
```ts
      summary: { content: '↪ 子agent进行中' },
```
```ts
        content: '↪ 本轮子agent仍在进行，进度已迁至最新卡片',
```

- [ ] **Step 8: 跑测试确认通过(绿)**

Run: `bun test src/cards/background.test.ts`
Expected: PASS —— 翻转用例、relabel 用例、summary 用例全绿;裸 bash 的噪音防线用例(`'前台 shell(Bash 命令)进 pending'`、`'端到端:前台命令全程不进 active'`、Ctrl+B 提升、workflow 天生后台)仍绿(未受影响)。

- [ ] **Step 9: 确认无其它硬编码「后台任务」用户可见文案漏改**

Run: `grep -rn "后台任务" src/`
Expected: 只剩**非用户可见**的命中(如日志串、注释),卡片 `config.summary` / body 文案已全部改为「子agent」。若发现别的用户可见卡片文案硬编码「后台任务」,一并改(本 plan 只预期 background.ts 三处 summary;grep 是兜底核验)。

- [ ] **Step 10: 提交**

```bash
git add src/cards/background.ts src/cards/background.test.ts
git commit -m "feat(background): 前台具名子agent 直入后台状态卡 + summary 文案改子agent"
```

---

## Task 2: 全量校验 + 构建 + 真机 smoke 交接

**Files:** 无(校验 + 人工 smoke)。

- [ ] **Step 1: 全量测试**

Run: `bun test`
Expected: 全绿(background 改动不影响其它模块;无回归)。若红,回 Task 1 修到绿再继续。

- [ ] **Step 2: 构建**

Run: `bun run build`
Expected: 五个 `dist/*.js` 产物生成,无类型/打包错误。

- [ ] **Step 3: 提交(若构建产物纳入版本控制则跳过——本仓库 dist 已提交历史,按现状:不额外提交 dist)**

无新提交(dist 非本 plan 交付物;部署时另行 build)。

- [ ] **Step 4: 真机 smoke(需部署 daemon;人工)**

在 etmmo 群发一个会派子agent 的活(如让主 Claude 派 economy-designer / qa-tester):
1. 确认冒出「🧭 子agent · N 进行中」卡,每个子agent 一个 panel,责任人显示 `economy-designer` 等,状态+时长实时走,展开看逐步执行过程(steps)。
2. 子agent 跑完 → panel 变 ✅/❌ 墓碑,定格时长。
3. 发下一条用户消息 → 旧卡沉降为「🧭 子agent(历史)」。
4. 确认**前台裸 bash 命令不冒卡**(只有子agent 冒卡)。
5. 查 daemon 日志无异常。

部署提示:`bun run build` 后 `launchctl kickstart -k gui/$(id -u)/com.supercc168.lodestar`(与全局 `lodestar-daemon` 软链指向本仓库 dist 一致)。**注意重启会打断在跑的会话/子agent——先确认无关键活跃工作。**

---

## Self-Review(计划自查)

- **Spec 覆盖**:§4.1 promotion→Task1 Step5;§4.2 模块注释→Step6;§4.3 三处文案→Step7;§7 测试(翻转/噪音防线/文案/steps)→Step1-3、Step8;§8.1 session 零改动→架构说明(不改 session.ts);§8.2 grep 兜底→Step9;§8.3 别误删 bash pending 断言→Step1 明确只改 local_agent 那行、bash 半不动。无遗漏。
- **类型一致**:未新增导出;`isInherentlyBackground` 签名不变;测试用既有 `applyBgTaskStarted`/`applyBgToolUse`/`backgroundLiveCard`/`backgroundHistoryCard`/`mk`/`emptyBgStore`,签名一致。
- **占位扫描**:无 TBD;每步含完整代码/命令/预期。
- **风险留痕**:session `ensureBackgroundCard` 不按类型过滤(§8.1)是"复用不动"的前提——若 smoke 发现子agent 进 active 却没开卡,需回查 session.ts 开卡条件(高置信不需要,但 smoke 是最终验证)。
