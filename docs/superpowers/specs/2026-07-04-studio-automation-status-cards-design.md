# 设计:任务清单自动化「工作室成员」实时状态卡

- 日期:2026-07-04
- 状态:已批准设计,待写实现计划
- 相关模块:`src/tasklist-worker.ts`、`src/tasklist.ts`、`src/cards/background.ts`(参考模板)、`src/cards/agy.ts`、`src/session-agy.ts`(参考生命周期)

## 1. 问题(缺口)

etmmo 等项目用「任务清单自动化」把飞书清单里的任务在分组间自动推进。推进由一批 AI「工作室成员」执行——**Codex**(`gpt-5.5`)和 **agy**(`gemini-3.1-pro`)——每个阶段是一个成员的一次子进程运行:

| 阶段 | 成员运行(`kind`) | 现在飞书能看到什么 |
|------|------------------|------------------|
| 设计中 | `codex-plan` + `agy-plan` | 跑完各写**一条任务评论** |
| [AI]待执行 | `agy-pick`(选下一个任务) | 无 |
| [AI]执行中 | `codex-execute`(最长 **180 分钟**) | 跑完才有一条评论 |
| [AI]待审核 | `agy-review` | 跑完一条评论 |
| 已完成 | `codex-merge`(人工勾选后触发) | 一条评论 |

这些成员是 `tasklist-worker.ts` 里的**守护进程级后台子进程**(全局 worker,每 30s 扫一次,`runAgentProcess` 是唯一 spawn 咽喉点)。运行期间飞书群里**没有任何卡片**——只有跑完之后 `feishu.addTaskComment` 冒出来的一条评论。一个 `codex-execute` 可能跑 3 小时,这 3 小时群里静悄悄,用户不知道哪个成员在干哪个任务、干到哪了。

状态其实都存在 `binding.processes[runId]`(`AutomationProcessRecord`:`status: running|exited|failed`、pid、`stdoutTail`)和 per-task 的 `TaskAutomationRunRef` 里,只是从没推到飞书群。

`tasklist-worker.ts` 目前 **不 import** `cardkit`/`cards`;整个 `grep -n "card"` 为零命中。

## 2. 目标 / 非目标

**目标**
- 自动化成员运行时,在**项目主群**推一张实时「自动化状态卡」,让用户一眼看到哪个成员在跑哪个任务、状态、已运行时长,并能展开看最近输出。
- 参考 `src/cards/background.ts` 的形态与生命周期:每运行一个折叠 panel、标题写「状态+时长」、活卡流式刷新、全空闲后沉降历史卡。
- 卡片失败绝不阻塞自动化本身。

**非目标(YAGNI)**
- 不改造手动 `agy <prompt>` 命令卡(它已有活卡,且不属自动化成员)。
- panel 里不放 git diff 摘要/转发按钮(第 3 决策选了「尽力 tail」而非「全量自包含」)。
- 不做跨 daemon 重启的卡恢复(降为 P2,见 §8)。
- 不改动任务评论回写逻辑——评论保留,卡片是**新增**的实时视图,不替代评论。

## 3. 已定设计决策(来自需求澄清)

1. **卡片形态**:单张「自动化状态卡」/项目,每个成员运行 = 一个折叠 panel(不是每运行一张独立卡,也不是只改任务本身)。
2. **生命周期**:按活跃波次——有成员在跑时建/刷新一张活卡;项目全空闲(无 running)后固化沉降历史卡,留原地;下一波活动开新卡。等价 `background.ts` 的 live→history 模型。
3. **panel 内容**:标题常驻「成员 · 任务 — 状态 · 时长」(实时);展开显示 stdout tail(尽力,print 缓冲导致无输出时显 `(暂无输出)`)。秒级的 `agy-pick` 不单独建 panel。

## 4. 关键约束与事实(定型依据)

- **全局串行**:`runTasklistWorkerOnce` 有 `running` 守卫防止扫描重入,扫描内 `await processTasklist` 逐项目串行,`processTasklist` 又 `await` 每个 `runAgentProcess`→`waitForProcess`。**任一时刻全系统最多一个成员子进程在跑。** 因此每项目活卡里最多一个 🟡 运行中 panel,其余是本波次墓碑——并发/竞态几乎不存在,大幅简化设计。
- **binding 无 chatId**:`TasklistBinding`(`src/tasklist.ts:90-101`)只有 `ownerOpenId`,没有 `chatId`。`enableTasklist(projectName, chatId)`(:128)收到 chatId 但只拿去查群主 openId 就丢了。
- **可反查 chatId**:daemon 有持久化会话↔群映射 `feishu.chatIdForSession(sessionName)`(`src/feishu.ts:273`,boot 时 `loadSessionChatMap()` 载入)。binding 的 `projectName` = sanitized 群名 = 会话名,故全局 worker 可用 `feishu.chatIdForSession(binding.projectName)` 拿到项目主群 chatId。**故旧 binding(etmmo)无需重新启用、无需 schema 迁移即可生效。**
- **print 模式可能缓冲**:`codex exec` / `agy -p` 未必增量吐 stdout,可能跑完才输出。故 panel 的 body(tail)在跑中可能一直空;**标题行的状态+时长必须独立于 tail 实时走**,不依赖 stdout。
- **飞书卡约束**:streaming 有 TTL、元素有数量上限(`cardkit.getElementCount`/`isElementLimitCode` 可探测)。按波次生命周期使单卡元素数天然有界。
- **元素 id 约定**:`background.ts` 在模块内本地定义 `BG_ELEMENTS`(不写进 `elements.ts`)。新模块照此本地定义 `AUTO_ELEMENTS`。

## 5. 架构

新增两个文件;**不改**现有 6 个 `runXxx` 的业务逻辑,只在 `runAgentProcess` 咽喉点接线。

| 文件 | 职责 | 对标 |
|------|------|------|
| `src/cards/automation.ts` | 纯渲染 + 累积视图类型:`automationRunPanel`、`automationLiveCard`、`automationHistoryCard`、`summarizeAutomation`、`memberLabel(kind)`、本地 `AUTO_ELEMENTS` | `src/cards/background.ts` |
| `src/tasklist-cards.ts` | 卡片生命周期:内存态 per-project 卡注册表、开卡/节流刷新/沉降、chatId 解析、失败降级。唯一 import cardkit/cards/feishu 的地方 | `src/session-agy.ts` 的 spawn→tick→settle |

`tasklist-worker.ts` 只新增对 `./tasklist-cards` 的调用,worker 主体不直接碰 cardkit。

### 5.1 渲染层 `src/cards/automation.ts`

纯函数,对标 `background.ts`。核心类型与导出:

```ts
export type AutomationRunKind =
  | 'codex-plan' | 'agy-plan' | 'codex-execute' | 'agy-review' | 'codex-merge'
  // agy-pick 不入卡(见 §7.4)

export type AutomationRunStatus = 'running' | 'completed' | 'failed'

/** 卡里一个成员运行的累积视图(tasklist-cards 以 runId 为 key 维护)。 */
export interface AutomationRunView {
  runId: string
  kind: AutomationRunKind
  taskGuid?: string
  taskSummary: string        // 任务标题,空则 '(无任务标题)'
  status: AutomationRunStatus
  startedAt: number          // ms
  endTime?: number           // ms,终态
  stdoutTail: string         // 最近输出(尽力),trim 到预算
  error?: string
}

export const AUTO_ELEMENTS = {
  panel: (runId: string) => `auto_run_${runId}`,
  body:  (runId: string) => `auto_run_body_${runId}`,
} as const
```

导出函数(签名对标 background):
- `memberLabel(kind)`:`codex-plan`→`Codex规划`、`agy-plan`→`agy规划`、`codex-execute`→`Codex执行`、`agy-review`→`agy审核`、`codex-merge`→`Codex合并`。图标沿用绿/黄/✅/❌ 语义(对标 `background.ts` 的 `TYPE_ICON`/`statusLabel`)。
- `statusLabel(run, now)`:`running`→`🟡 运行中 <fmtElapsed(now-startedAt)>`;`completed`→`✅ 用时 <fmtElapsed(endTime-startedAt)>`;`failed`→`❌ 失败 <...>`。复用 background 同款 `fmtElapsed`。
- `automationRunPanel(run, now)`:`collapsible_panel`,`element_id=AUTO_ELEMENTS.panel(runId)`,header title = `${icon} ${memberLabel(kind)} · ${taskSummary} — ${statusLabel(run,now)}`,body = `markdown`(`element_id=AUTO_ELEMENTS.body(runId)`,内容 = `stdoutTail` 或 `_(暂无输出)_`,error 存在时首行 `⚠ error`)。
- `summarizeAutomation(runs)`:`N 进行中 · M 已结束`(对标 `summarizeBackground`)。
- `automationLiveCard(projectName, runs, now)`:`schema 2.0`,`config.streaming_mode=true`,`summary.content = 🧭 <project> 自动化 · <summarize>`,`body.elements = runs.map(automationRunPanel)`。
- `automationHistoryCard(projectName, runs, now)`:`streaming_mode=false`,summary 前缀 `🧭 <project> 自动化(历史)`,只渲染终态 runs。

**stdout tail 预算**:body 单条 tail 截到 ~1500 字(尾部保留),对标 `agy.ts` 的截断策略;避免单卡元素体积失控。

### 5.2 生命周期层 `src/tasklist-cards.ts`

内存态,不进 `tasklist-map.json`(P2 硬化再议)。

```ts
interface AutomationCardState {
  projectName: string
  chatId: string
  messageId: string          // feishu.updateCard 整卡沉降用
  cardId: string             // cardkit.replaceElement panel 级刷新用
  runs: AutomationRunView[]   // 本波次:running + 墓碑,建卡顺序
  refreshTimer: ReturnType<typeof setInterval> | null
  cardWriteFailed: boolean
  sawActivityThisScan: boolean // 本轮扫描是否有本卡的 run 开始/结束(空闲判定信号)
  idleScans: number           // 连续空闲扫描计数(防抖沉降)
}

const cardsByProject = new Map<string, AutomationCardState>()
let opening = new Set<string>()   // 开卡中的 projectName,防并发重复开卡
```

**核心不变式:内存 run 视图(`cardsByProject[project].runs`)是唯一真源;所有卡写(`sendCard`/`replaceElement`/`updateCard`)都是对它的尽力 reconcile。** 三个 `onXxx` 必须**先改视图、再尝试写卡**;开卡未就绪(句柄为 null)时写卡静默跳过、不丢状态——开卡完成后有一次全量重建兜底(§7.1)。这是消除"异步开卡窗口内 run 结算→墓碑打在不存在的卡上被丢弃"竞态的关键(对标 `background.ts` 以 store 为真源、卡增量 reconcile)。

导出的接线点(供 `tasklist-worker.ts` 调用):
- `onRunStart(record: AutomationProcessRecord): void` — 若 kind 入卡:**先**把 run 追加进 `runs`(status=running;`taskSummary` 由 `tasklist.getTasklistBinding(projectName)?.tasks[taskGuid]?.summary` 取,`rememberScan` 每轮已写入,缺则 `(无任务标题)`),置 `sawActivityThisScan=true`;**再**在该 project 无活卡且不在开卡中时触发异步开卡。次序保证开卡渲染时 `runs` 已含本 run。
- `onRunStdout(runId, projectName, tail): void` — 更新对应 run 的 `stdoutTail`(便宜赋值,不发请求;由 timer 统一重渲染)。
- `onRunSettle(record): void` — **先**把 run 视图置终态(`exited`→completed,其余→failed)、记 `endTime`、置 `sawActivityThisScan=true`;**再**尽力 `replaceElement` 该 panel 成墓碑 + 更新 summary。开卡窗口内结算时此 `replaceElement` 无卡可打、静默跳过,终态靠 §7.1 开卡后重建落地。
- `settleIdleProjects(): void` — **每轮扫描末尾调一次**(无参)。逐活卡:`sawActivityThisScan` 为真 → 复位为 false、`idleScans=0`;否则 `idleScans++`,达阈值 → `settleCard`。
- (内部)`openCard`、`refreshCard`(30s tick)、`settleCard`(→`feishu.updateCard(messageId, automationHistoryCard(...))` + 清 timer + 从 map 删除)。

**空闲判定为何不能用「当前无 running」**:worker 全局串行、每个子进程都被 `await`,故 `settleIdleProjects` 只在**扫描之间**执行——那一刻按构造全系统必然无 running。所以「当前无 running」恒真,不能当信号。正确信号是「**刚结束的这轮扫描里,本卡有没有 run 开始/结束过**」,即 `sawActivityThisScan`。一个波次的相邻阶段倾向落在相邻扫描(如 `codex-plan`+`agy-plan` 在同一 `processDesignTask` 同轮触发;`codex-execute`+`agy-review` 在同一 `processExecutingTask` 同轮触发),故这些扫描都对该 project 记到活动,`idleScans` 保持 0;直到流水线进入静息态(等人工审核、或全完成)才连续空闲、沉降。阈值默认 1(约 30-60s 后沉降),可配。

## 6. 数据流

1. **spawn**:`runAgentProcess`(`src/tasklist-worker.ts:651`)存完 `AutomationProcessRecord`(status=running)后,调 `tasklistCards.onRunStart(record)`。
2. **stdout**:`proc.stdout.on('data')` 现有 handler 里,除了累积 tail,再调 `tasklistCards.onRunStdout(runId, projectName, currentTail)`(节流,复用现有 tail 字符串)。
3. **tick**:开卡后启一个 30s `setInterval`(对标 `session-agy.ts:294` 的 `AGY_STATUS_TICK_MS`),`replaceElement` 当前 running panel(刷时长 + tail)+ `patchSummaryThrottled`。
4. **settle**:`runAgentProcess` 拿到 `finalRecord` 后调 `tasklistCards.onRunSettle(finalRecord)`。
5. **沉降**:`runTasklistWorkerOnce` 循环末尾,统计本轮有活动的 project 集合,调 `tasklistCards.settleIdleProjects(active)`。

**chatId 解析(持久化优先 + 一次性回填 + 失败可见)**——`binding.chatId` 是唯一运行时来源:
1. **新绑定**:`enableTasklist(projectName, chatId)` 起就把 chatId 落进 `binding.chatId`(chatId 本在手,现被丢弃),天然自带,不依赖任何模糊匹配。
2. **旧绑定回填**(如 etmmo,无 `chatId`):worker 每轮 `processTasklist` 开头若 `binding.chatId` 缺失,用 `feishu.chatIdForSession(projectName)` 解析**一次并 `updateTasklistBinding` 持久化回 binding**——把模糊路径收敛为一次性操作,之后开卡只读 `binding.chatId`。
3. **回填也失败**(0/多群名命中、群改名、`preferredChatForSession` 被清):记日志;且下次用户在项目群发 `task` 时(**此刻 chatId 在手**),`task` 面板检测 `binding.chatId` 缺失 → 用当前群自愈写入并提示「状态卡已绑定本群」。把"静默无卡、不可调试"变成用户可见、可自愈。

开卡时直接读已回填的 `binding.chatId`;仍为空 → 本波次不开卡(自动化照常跑)。

**panel 归属**:element_id = `auto_run_<runId>`,run 视图以 `runId` 为 key。天然无跨 run 混淆(runId 全局唯一)。

## 7. 卡片生命周期(按波次 · per-project)

- **7.1 开卡** `onRunStart`:该 project 无活卡且非开卡中 → 加入 `opening` 集合 → 读 `binding.chatId`(§6) → `feishu.sendCard(chatId, automationLiveCard(project, 当下 runs 快照))`(初始 body 用**当下** `runs`,已含开卡触发的那个 run)→ `cardkit.convertMessageToCard(messageId)` → 存 `AutomationCardState`,`recordCardCreated(cardId, 5, onFail)` 挂失败降级 → **开卡后立即按当前 `runs` 全量重建一次(reconcile)**,吸收异步开卡窗口内 `onRunSettle`/`onRunStdout` 对视图的改动(对标 `openBackgroundCard` 初始 body 读 live store)→ 启 30s tick → 从 `opening` 移除。`opening` 集合防并发事件重复开卡(对标 `openingBackground`)。
- **7.2 刷新** tick + stdout:`replaceElement(cardId, AUTO_ELEMENTS.panel(runId), automationRunPanel(run, now))` 刷 running panel;`patchSummaryThrottled`。
- **7.3 加墓碑** `onRunSettle`:**先**视图终态化(`endTime` 定格时长),**再**尽力 `replaceElement` 该 panel 成 ✅/❌ 墓碑;句柄未就绪则跳过写、由 §7.1 开卡后重建补上。墓碑留在活卡里。
- **7.4 沉降** `settleIdleProjects`:该 project 本轮无 running 成员且未推进任何阶段 → `idleScans++`;`idleScans >= 1`(即连续 1 个空闲扫描周期的宽限,防多阶段任务在 plan→execute→review 阶段间被误沉降)→ `feishu.updateCard(messageId, automationHistoryCard(...))`(streaming 关,留原地)+ 清 timer + `cardsByProject.delete(projectName)`。下一波 `onRunStart` → 开新卡。任一 run 重新 running 时 `idleScans` 归零。
- **7.5 `agy-pick`**:秒级选任务,不入卡(`onRunStart` 对该 kind 直接 return)。其存在感靠它选出的任务随后 `codex-execute` 建 panel 体现。

## 8. 错误处理 & 边界

- **卡失败绝不阻塞自动化**:`tasklist-cards.ts` 所有 feishu/cardkit 调用 try/catch;`recordCardCreated(cardId, 5, ...)` 首次写失败回调里设 `cardWriteFailed=true`,之后本波次停止刷卡(对标 `session-agy.ts:260`)。worker 主体不感知卡失败。
- **元素上限**:tick 里若 `replaceElement` 触发 `isElementLimitCode`,停止追加、降级停刷(按波次已使元素有界,极端才触发)。
- **超长执行**(`codex-execute` 180min):关键——刷新 tick 是每卡独立的 `setInterval`,**不依赖扫描循环**。这轮 `codex-execute` 被 `await` 期间,扫描循环阻塞(30s 定时器起的新扫描被 `running` 守卫跳过),但 tick 的 `setInterval` 照常每 30s 触发,持续刷新时长 + tail。若飞书 streaming TTL 到期致写失败 → `cardWriteFailed` 降级停刷,标题定格最后一次「运行中 Nm」。可选缓解:tick 里检测写失败先 `patchSettings` 关 streaming——留待计划阶段权衡。
- **daemon 重启**(P2,本次不做):内存注册表丢失,旧活卡停在 streaming 中不再更新。P2 硬化方案——把 `{messageId}` 落一份到 binding,boot 时 `feishu.updateCard` 成历史卡收尾。本次接受该已知限制,spec 显式记录。

## 9. 状态字段改动(最小)

- `TasklistBinding` 加可选 `chatId?: string`(`src/tasklist.ts:90-101`);`enableTasklist`(:128)落它(chatId 本就在手,现被丢弃)。`normalizeBinding`/`cloneBinding` 带上该字段。**纯增字段,旧 JSON 兼容。**
- 旧 binding 回填(§6):worker 首轮 `feishu.chatIdForSession` 解析后 `updateTasklistBinding` 持久化;`task` 面板在 `chatId` 缺失时用当前群自愈写入。**无需一次性迁移脚本。**
- 卡注册表纯内存(`Map<projectName, AutomationCardState>`),不进 `tasklist-map.json`。

## 10. 范围

**In**:5 类有意义成员运行(`codex-plan` / `agy-plan` / `codex-execute` / `agy-review` / `codex-merge`)的活卡 panel + 墓碑;按波次 live→history;标题实时状态+时长 + 尽力 stdout tail。

**Out**:手动 `agy <prompt>` 命令卡改造;panel 内 diff/转发按钮;`agy-pick` 独立 panel;跨重启卡恢复(P2)。评论回写逻辑不动。

## 11. 测试

- `src/cards/automation.test.ts`(对标 `background.test.ts`):`automationRunPanel` 结构、`statusLabel` 三态、`summarizeAutomation` 统计、`automationLiveCard`/`automationHistoryCard`(history 只含终态)、`memberLabel` 映射、tail 截断与 `(暂无输出)` 兜底。
- `src/tasklist-cards.test.ts`:开卡(mock `feishu.sendCard`/`convertMessageToCard`)、stdout 更新、墓碑、`settleIdleProjects` 空闲阈值与阶段间不误沉降、chatId 回退与解析失败优雅跳过、`cardWriteFailed` 降级后不再写。mock feishu + cardkit。
- 真实飞书群 smoke:etmmo 群跑一轮自动化,确认活卡出现、时长走、墓碑固化、全空闲后沉降历史。

## 12. 逐文件改动清单

- **新增** `src/cards/automation.ts`:§5.1 全部渲染 + 类型 + `AUTO_ELEMENTS`。
- **新增** `src/cards/automation.test.ts`。
- **新增** `src/tasklist-cards.ts`:§5.2 生命周期(import `feishu`/`cardkit`/`cards`/`tasklist`/`log`)。
- **新增** `src/tasklist-cards.test.ts`。
- **改** `src/cards.ts`:re-export `./cards/automation`。
- **改** `src/tasklist.ts`:`TasklistBinding` 加 `chatId?`;`enableTasklist` 落 chatId;`normalizeBinding`/`cloneBinding` 带上。
- **改** `src/tasklist-worker.ts`:`runAgentProcess` 接 `onRunStart`/`onRunStdout`/`onRunSettle`;`runTasklistWorkerOnce` 末尾接 `settleIdleProjects()`;`processTasklist` 开头缺 `chatId` 时 `chatIdForSession` 解析 + 持久化(§6 回填)。import `./tasklist-cards`。
- **改**(自愈) `src/session-tasklist.ts` / `src/cards/task.ts`:`task` 面板在 `binding.chatId` 缺失时用当前群写入并提示(§6 步骤 3)。
- **改**(可能) `src/cards/AGENTS.md`:补 `automation.ts` 条目。

## 13. 待计划阶段确认的假设

1. `feishu.chatIdForSession(binding.projectName)` 对 etmmo 主群解析到目标群——已确认解析优先读持久化 `preferredChatForSession`(键 = `sanitizeSessionName(群名)`,主群发消息时经 `bindSessionToChat` 绑定),回退 `chatNameCache` 名字匹配(0/多命中返 null)。§6 的"落库+回填+自愈"已兜住失败(不再全功能静默无卡),但计划阶段仍核实 `enableTasklist` 用的 `worktreeProjectName()` 与该 map 键一致(worktree 子群走主项目名)。
2. 已确认:5 个入卡 kind 的 `runAgentProcess` 调用都带 `taskGuid`(`agy-pick` 无、不入卡);`taskSummary` 由 `onRunStart` 从 `binding.tasks[taskGuid]?.summary` 取(`rememberScan` 每轮写入),缺则 `(无任务标题)` —— `tasklist-cards.ts` 因此 import `tasklist`。
3. 30s tick 与飞书 streaming TTL 的具体阈值——smoke 校准。
