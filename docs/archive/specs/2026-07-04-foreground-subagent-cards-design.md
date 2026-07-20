# 设计:前台具名子agent 进后台状态卡

- 日期:2026-07-04
- 状态:已批准设计,待写实现计划
- 分支:`feat/foreground-subagent-cards`(off main,独立于 parked 的 `feat/automation-status-cards`)
- 相关:`src/cards/background.ts`(f7e4ef1 引入的「后台游标卡」)

## 1. 问题

etmmo 等交互会话通过 Task 工具派**具名专家子agent**(economy-designer / qa-tester / automation-engineer 等)干实活,每个跑数分钟。但它们的工作状态在飞书**没有单独状态卡**——只在对话卡里当一条 Agent 工具面板(摘要级)露脸,没有实时状态 + 时长 + 逐步执行过程。

**根因**:后台卡(`background.ts`,f7e4ef1)按设计**只给显式后台化(`is_backgrounded:true`)的任务建卡**。前台子agent 的 `task_started` 落 pending 观察池、不渲染、结算即丢。f7e4ef1 这么设计是为挡"随便跑个 bash 就冒一项"的噪音(见其 doc:"前台 task 不该进「后台任务」卡")。

**证据**:daemon 日志今日 etmmo 派了 `economy-designer`×3 / `qa-tester`×2 / `automation-engineer`×1(全 `type=local_agent` 前台),**全程没开过一张后台卡**;它们的 `task_started` 事件本就在流(日志有 `bg_task_started type=local_agent subagent=economy-designer`),steps 也本就在 pending 池累积(`applyBgToolUse` 对 active/pending 双池都处理)——只差**建卡门槛**。

## 2. 目标 / 非目标

**目标**:前台**具名子agent**(任何 `subagent_type`)也能进后台状态卡,享受既有的每-panel 实时状态 + 时长 + 逐步执行过程(steps)+ 沉降历史。

**非目标(YAGNI)**:
- 前台裸 bash(`local_bash` / `shell`)继续藏(保留 f7e4ef1 噪音防线)。
- 不加配置开关(固定规则)。
- 不抑制对话卡里的 Agent 工具面板(接受两处并存)。
- 不动 `feat/automation-status-cards` 分支。

## 3. 已定决策(来自澄清)

1. **Surface**:扩展现有后台卡(`background.ts`),不另造平行卡——复用全部机制。
2. **放行范围**:所有 subagent(`type=subagent`,任何 `subagent_type`)直入 active;`shell`/`unknown` 前台仍进 pending。
3. **标题**:summary 由「🧭 后台任务」改中性「🧭 子agent」(卡现混含前台子agent + 真后台任务)。

## 4. 核心改动(`src/cards/background.ts`)

### 4.1 promotion 规则

`isInherentlyBackground(type)` 现为:
```ts
function isInherentlyBackground(type: BgTaskType): boolean {
  return type === 'workflow' || type === 'monitor'
}
```
改为再含 `'subagent'`:
```ts
/** 天生入卡的 task_type:workflow / monitor 是 fire-and-forget 后台执行;
 *  subagent(Task 工具派的具名子agent)是实质工作,即便前台执行也值得单独
 *  建卡显示进度。三者 task_started 即入 active。shell(前台裸 bash)/ unknown
 *  仍是噪音源,先落 pending 观察池,等 is_backgrounded:true(Ctrl+B)才提升。 */
function isInherentlyBackground(type: BgTaskType): boolean {
  return type === 'workflow' || type === 'monitor' || type === 'subagent'
}
```
**效果**:`applyBgTaskStarted` 里新 subagent 走 `isInherentlyBackground` 分支 → 直入 active、带 `isBackgrounded:true`。`shell`/`unknown` 仍进 pending;`is_backgrounded` 提升路径不变(Ctrl+B 的 bash 仍能提升)。这是唯一的**逻辑**改动。

### 4.2 模块头 doc 注释同步

模块头(第 27-32 行附近)现有:
> 前台/后台区分(SDK sdk.d.ts:2750):Bash 命令和子 agent 默认全是前台 task…前台 task 不该进「后台任务」卡 —— 故 task_started 先落 pending 观察池…

改为准确反映新规则:**子agent(具名,实质工作)`task_started` 即入 active 建卡;只有前台裸 Bash / unknown 落 pending 观察池,等 `is_backgrounded:true` 才提升**。避免注释与代码矛盾。

### 4.3 标题 / summary 文案(纯文案,不动结构)

- `backgroundLiveCard`:`🧭 后台任务 · ${summarizeBackground(tasks)}` → `🧭 子agent · ${summarizeBackground(tasks)}`
- `backgroundHistoryCard`:`🧭 后台任务(历史) · ${terminal.length} 已结束` → `🧭 子agent(历史) · ${terminal.length} 已结束`
- `backgroundMigratedMarker`:summary `↪ 后台任务进行中` → `↪ 子agent进行中`;body `↪ 本轮后台任务仍在进行，进度已迁至最新卡片` → `↪ 本轮子agent仍在进行，进度已迁至最新卡片`

## 5. 复用不变的部分

- **渲染**:`backgroundTaskPanel`(图标/状态/时长/steps body)不变。subagent 图标 `🟢`(`TYPE_ICON.subagent`),`ownerOf` 用 `subagentType`——economy-designer 等直接显示为责任人。
- **steps**:`applyBgToolUse` / `applyBgToolResult` 双池累积不变;subagent 现从一开始就在 active,steps 直接落 active。
- **session 层**:`ensureBackgroundCard` / `refreshBackgroundCard` / `settleBackgroundCard` 由 active 池 / `hasActiveBgTask` 驱动,不按类型过滤——subagent 进 active 后现有 ensure 逻辑自动开卡。**零改动**(计划阶段核实,见 §8)。
- **沉降 / 迁移**:游标卡跟随对话、被新消息超越时沉降历史——不变。

## 6. 生命周期 / 取舍(记录)

- **每个用带子agent 的 turn 会开一张卡**;沉降机制保证至多一张活卡 + 历史墓碑,不活卡堆叠。
- 一次快速 Explore 也会建卡(放行范围选"所有 subagent"的固定规则),**已接受**。
- 前台子agent **两处并存**:①对话卡的 Agent 工具面板(既有,摘要级),②状态卡的 panel(实时状态+时长+steps)。粒度互补,不抑制对话卡那条(抑制更侵入,且结果转发等仍挂在那)。与"已 Ctrl+B 后台化的子agent 本就两处露"一致。

## 7. 范围 / 测试

**改**:`src/cards/background.ts`(§4.1 一处逻辑 + §4.2 注释 + §4.3 三处文案)。

**测试** `src/cards/background.test.ts`:
- **翻转**:原「前台子 agent 进 pending」用例 → 「前台子 agent(`subagent_type` 任意)`task_started` 直入 active 并标 `isBackgrounded`」。
- **归一化用例同步**:既有「`local_` 前缀归一化」用例断言 `applyBgTaskStarted(…, { task_type: 'local_agent' }).pending[0].type` —— 改后 `local_agent` 进 **active**,该断言须改成 `.active[0].type`(否则 `.pending[0]` 为 undefined、用例炸)。`local_bash` 那半仍断言 `.pending[0]`。
- **保留噪音防线**:「前台裸 bash(`local_bash`)仍进 pending、不标 `isBackgrounded`」+「pending bash 结算即丢(不进卡)」。
- **文案**:`backgroundLiveCard` / `backgroundHistoryCard` summary 现为「🧭 子agent…」。
- **steps(若既有 active-steps 用例已覆盖则够,否则补)**:前台 subagent 的 `tool_use` 按 `parent_tool_use_id` 归属并渲染进 body。

**校验**:`bun test src/cards/background.test.ts` + 全量 `bun test` + `bun run build`。

**真机 smoke**:etmmo 群发个会派子agent 的活 → 确认「🧭 子agent」卡冒出、economy-designer 等 panel 实时状态+时长走、跑完变墓碑、下条消息沉降历史;确认**前台裸 bash 不冒卡**。

## 8. 待计划阶段确认

1. `session.ts` 的 `ensureBackgroundCard` 确实对所有 active 类型无差别开卡(不按 type 过滤)——读该函数核实(高置信:它读 `hasActiveBgTask`/active 池)。
2. 是否有别处硬编码「后台任务」文案需同步(`grep -rn "后台任务" src/`),避免漏改导致 UI 文案不一致。
3. 既有 `background.test.ts` 里断言「前台子 agent 进 pending」的用例位置,翻转时别误删对 bash 的 pending 断言。
