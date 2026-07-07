# 设计:移植 temp session(临时会话 / 分叉 / 回滚)到主干

- 日期:2026-07-08
- 状态:待批准设计,待写实现计划
- 来源:上游 leviyuan/lodestar `eae3a15`(v0.12.0)
- 相关:`src/session.ts`、`src/session-temp.ts`(新)、`src/feishu.ts`、`daemon.ts`(根)、`src/claude-agent-process.ts`、`src/cards/temp.ts`(新)

## 1. 背景 / 问题

fork 主干缺「同目录多开 Claude + 语义化分叉 / 回滚」能力。上游 `eae3a15`(v0.12.0)实现了完整一套(基于 Claude 原生 session fork):

| 指令 | 行为 |
| --- | --- |
| `btw` | 同目录开临时群 `<project>*MMDD-HHMM`,自动启动一个干净 Claude |
| `bye` | 解散当前临时群(仅 `*` 开头群可用) |
| `fk` / `fork` | 列当前会话每条用户输入(倒序),选一条 → 从这条**之前**开临时群分叉,原会话不动 |
| `bk` / `back` | 立刻终止当前 + 列用户输入,选一条 → 当前会话回退到这条**之前**,并发一张回滚段 Write 记录卡(代码块,可复制重发) |
| `rs`(空闲) | 列项目最近 24h Claude 会话(不足 10 补更早),选一个在本群接续恢复 |

**不能直接 cherry-pick**:`eae3a15` 改的 `session.ts` / `feishu.ts` / `daemon.ts` / `claude-agent-process.ts` 都是 fork 重度定制文件。但三路并行调研证实:**所有冲突点都是 additive 或单点手工合并,无「重写」级冲突**。本设计目标:**手动把 temp session 功能实现到主干**(逐文件移植,非合并上游 commit)。

## 2. 目标 / 非目标

**目标**:fork 主干具备 `btw` / `bye` / `fk` / `bk` / `rs`(空闲)完整功能(Claude 后端)。

**非目标(YAGNI)**:
- 不 cherry-pick / merge `eae3a15`(手动移植,逐文件)。
- **不支持 Codex 后端的 fork / back**:上游硬门控 `selectedProvider === 'claude'`(Codex 无 `resumeSessionAt`)。Codex 走原 `rs` 逻辑,不受影响。
- 不引入 temp session 之外的 `eae3a15` 改动(`eae3a15` 是 release commit,但本移植只取 temp session 相关 hunk)。
- 不动 worktree(`src/worktree.ts`,不同目录多开)—— temp 与 worktree 命名空间正交(`*MMDD-HHMM` vs `[slug]`,字符集不重叠),共存无需任何适配。

## 3. 技术前提(已核实 = GO)

1. **SDK**:fork 用 `@anthropic-ai/claude-agent-sdk@0.3.181`,其 `sdk.d.ts` 声明 `QueryOptions.forkSession?`(L1412,"resumed sessions will fork to a new session ID")+ `resumeSessionAt?`(L1727,"only resume messages up to and including the message with this UUID")。`eae3a15` 传参方式符合 SDK 文档。**无需升级 SDK**。
2. **fk / bk / rs 限 Claude 后端**:上游 `session-temp.ts` 硬门控,Codex 路径无 `resumeSessionAt` → 多后端兼容无虑。
3. **rs / restart 无分叉**(消除先前担忧):`upstream-pr/session-resume-fix` 已 squash 并入 main(PR #8 = `2ca0060`,内容是「后台任务恢复轮开卡」,非 rs 列表恢复)。fork `restart()` body 已含全部 bg-resume 改进,`eae3a15` 没动 restart body,只新增 `rollbackTo` 调它。**该分支 stale,可清理**。
4. **fork 既有结构与上游假设一致**:`Session.all` registry、`proc.lastAssistantUuid`、`currentTurn.toolByUseId.{name,input}`、`LifecycleProgressOpts`、`worktreeProjectName`、feishu 的 `ensureChatForSession` / `disbandChatForSession` / `chatIdForSession` 签名 —— 全部可直接被新代码调用。

## 4. 冲突矩阵(逐文件)

| 文件 | eae3a15 | 冲突 | 处置 |
| --- | --- | --- | --- |
| `src/cards/temp.ts` + `temp.test.ts` | 新 ~294 行 | **无** | 1:1 拷贝,最先落地 + 单测 |
| `src/session-temp.ts` | 新 203 行 | **无** | 1:1 拷贝(阶段 2,依赖 session) |
| `src/paths.ts` | +4 | **无** | `SESSION_RESUME_MAP_FILE`(L69)后插 `SESSION_TURNS_MAP_FILE`,锚点逐字命中 |
| `src/cards.ts`(barrel) | +12 | **无** | worktree 导出块后插 temp 导出块;与顶部 sanitize 导出(L13)物理隔离 |
| `src/feishu-test-mock.ts` | +10 | 低 | 9 个 temp stub 插在 fork 的 `chatIdForSession`(L65)后、`}))`(L66)前(上游插在 projectProfile 后,fork 多了两个 stub,插点后移) |
| `src/feishu.ts` | +124 | 低 | turn-anchor 段(getSessionResume L167 后)纯 additive + `sanitizeSessionName`(L830)正则加 `\*` |
| `src/claude-agent-process.ts` | +19 | 低 | 3 处机械补丁:`claudeTranscriptPath`→`claudeTranscriptDir` 拆分 + `ClaudeSpawnOpts` 加 `resumeSessionAt?`/`forkSession?` + `query()` 传参(安全重构,保留旧 path 函数 backward-compat) |
| `src/session.ts` | +113 | **低-中** | 7 改动点全在、文本一致;**唯一易错点:`spawnAgent` Codex 分支手工合并**(保留 fork 的 `codexSpawnOverrides` / `configArgs` / `providerEnv`) |
| `src/session-types.ts` | +11 | 低 | `SessionOpts` 加 `onCreateTempSession` / `onDisbandTempSession`(2 hook 带注释/多行签名,diffstat +11)|
| `daemon.ts`(根) | +71 | 低-中 | `sessionFor` 扩 opts + 2 新函数(`createTempSession`/`disbandTempSession`)+ `handleCardAction` 3 case + `boot()` 加载 turns map;本体 additive |
| `src/session-commands.ts` | +35 | 低 | `btw`/`bye`/`fk`/`bk` 4 case(worktree 后、agy 前)+ `restart` 空闲走 `showResumeList` |
| `README.md` | +15 | 低 | `restart`/`rs` 命令表行更新 + 新增「临时会话/分叉/回滚」整段用户文档(非版本号);阶段 3 按 fork 既有命令措辞微调 |
| `package.json` | +1/-1 | — | 版本号 `0.11.19→0.12.0`;**fork 版本独立,bump 与否由维护者定,不随上游** |

**结论**:无重写级冲突。真正需动脑的只有 `spawnAgent` Codex 分支合并(1 处,且该分支在 btw/fk/bk 不可达,见 §5.2.2)。

## 5. 移植方案(分阶段,按依赖)

### 阶段 1 — 叶子 / additive(每步可独立编译 + 测试,不触发新依赖错误)

**1.1 `src/cards/temp.ts` + `src/cards/temp.test.ts`**(零外部依赖)
- 1:1 拷贝 `turnListCard` / `resumeListCard` / `writeLogCard` / `writeBodyFromToolInput` + 类型。
- 先落 `temp.test.ts`(上游自带 78 行)并跑通 —— 纯函数最先验证。

**1.2 `src/paths.ts` + `src/cards.ts` barrel + `src/feishu-test-mock.ts`**
- paths:L69 后加 `export const SESSION_TURNS_MAP_FILE = join(DATA_DIR, 'session-turns-map.json')`。
- cards.ts:worktree 导出块(L60-67)后、agy 块(L68)前,插 temp 的 12 行 re-export。
- feishu-test-mock.ts:9 个 temp stub 插在 `chatIdForSession`(L65)后。

**1.3 `src/feishu.ts` turn-anchor 段 + sanitize 放行 `*`**
- 在 `getSessionResume`(L167)后粘贴 ~120 行新 section:
  - 类型:`TurnWrite`、`TurnAnchor`
  - 状态:`turnsBySession` Map、`TURN_ANCHOR_MAX = 200`
  - 函数(7):`loadSessionTurnsMap` / `saveSessionTurnsMap`(私有)/ `appendTurnAnchor` / `getTurnAnchors` / `truncateTurnAnchors` / `seedTurnAnchors` / `clearTurnAnchors`
  - 临时群名工具:`TEMP_SUFFIX_RE`、`tempProjectName`、`tempChatName`
- `sanitizeSessionName`(L830):`[^\w一-鿿\-\[\]]` → `[^\w一-鿿\-\[\]\*]`(放行 `*`)。

**1.4 `src/claude-agent-process.ts` 3 补丁**(解锁 transcript / fork 前提)
- 把 `claudeTranscriptPath`(L276)拆为 `claudeTranscriptDir(workDir)` + `claudeTranscriptPath = join(claudeTranscriptDir, sid+'.jsonl')`(保留旧函数,L1252 调用 + test L1006-1007 不变)。
- `ClaudeSpawnOpts`(L86-93)加 `resumeSessionAt?: string` / `forkSession?: boolean`。
- `query()` 调用处(**fork L781**,options 块 L783-817;上游在 L700-701,勿混)条件展开:`...(opts.resumeSessionAt ? { resumeSessionAt: opts.resumeSessionAt } : {})` + `...(opts.forkSession ? { forkSession: true } : {})`。

**阶段 1 验收**:每步 `bun test` + `bun build` 通过。`temp.test.ts` 全绿。

### 阶段 2 — 耦合集(session ↔ session-temp ↔ daemon 循环依赖,一起改一起编译)

**2.1 `src/session-types.ts`**:`SessionOpts` 加
```ts
onCreateTempSession?: (opts: { chatName: string; userOpenId: string;
  resumeSessionId?: string; resumeSessionAt?: string }) => Promise<{ ok: boolean; chatId?: string; error?: string }>
onDisbandTempSession?: (chatName: string) => Promise<{ ok: boolean; error?: string }>
```

**2.2 `src/session.ts`**(核心,改动最多)
- import:`import * as sessionTemp from './session-temp'`。
- 新增字段(2):`private _forkSpawn: { resumeSessionId?: string; resumeSessionAt?: string } | null = null`、`private lastTurnUserPreview = ''`。
- 新增核心方法(5):`startForked` / `rollbackTo` / `dispose` / `recordTurnAnchor`(私有)/ `collectTurnWrites`(私有)。
- 新增委托方法(8,全部 `return sessionTemp.xxx(this, ...)`):`showForkList` / `showBackList` / `showResumeList` / `runBtwCommand` / `runByeCommand` / `onForkSelect` / `onBackSelect` / `onResumeSelect`。
- 改既有逻辑(4 处,fork 文本与上游 pre-eae3a15 一致,直接套 diff):
  - `workDir` getter(L427):`tempProjectName(this.sessionName) ?? this.sessionName` 剥临时群后缀。
  - `applyModelSelection`(L531 后)+ `resetFreshConversationState`(L675):各加 `feishu.clearTurnAnchors(this.sessionName)`。
  - `result` handler:**紧邻 `closeTurnCard`(fork L1986)之前**插 `this.recordTurnAnchor()`(勿插 L1964-1965 —— 那是 `userInterrupted` return 后的空行,前面还有 orphan flush 会改变顺序)。`recordTurnAnchor` / `collectTurnWrites` **1:1 拷贝 eae3a15 L1134-1160,含 `!proc`/`!uuid`/`!turn` 三守卫**(无卡轮 / 纯系统轮 proc 为 null 时早退,避免崩溃)。
  - `openTurnCard`(L2190 后):`this.lastTurnUserPreview = userInputs[0]?.slice(0,80) ?? this.lastTurnUserPreview`。
- **`spawnAgent`(fork L499-521)合并**(原标"唯一易错点",实际**低风险** —— 见末尾不可达说明):
  - 顶部加 `_forkSpawn` 读取:`const fs = this._forkSpawn; const sid = fs?.resumeSessionId ?? resumeSessionId`。
  - Claude 分支(L500-509):`resumeSessionId` → `resumeSessionId: sid`,加 `resumeSessionAt: fs?.resumeSessionAt` / `forkSession: fs?.forkSession`(条件传),`profile: feishu.projectProfile(tempProjectName(this.sessionName) ?? this.sessionName)`。
  - **Codex 分支(L511-520):保留 fork 既有 8 行字面不动,仅把 `resumeSessionId,` 改成 `resumeSessionId: sid,` 一个 token**(其余 `configArgs`/`providerEnv` 等 fork 定制原样):
    ```ts
    const overrides = codexSpawnOverrides(this.modelForSpawn())
    return new CodexProcess({
      workDir: this.workDir,
      model: overrides.modelId,
      effort: this.effortForSpawn(),
      resumeSessionId: sid,          // ← 唯一改动(原为 resumeSessionId,)
      appendSystemPrompt: this.spawnDeveloperInstructions(),
      configArgs: overrides.configArgs,
      providerEnv: overrides.env,
    })
    ```
  - **风险降级(中→低)**:`btw`/`fk`/`bk` 在 `session-temp.ts` 入口已硬门控 `selectedProvider === 'claude'`,Codex 分支的 `sid` 改写在 temp 路径**不可达**;仅当 temp 群存活期间切到 Codex 后再发消息才命中,且此时 `_forkSpawn` 为 null、`sid === resumeSessionId`,行为等同改动前。Codex 分支仅需 smoke 验证 provider 切换不崩。

**2.3 `src/session-temp.ts`**:1:1 拷贝 203 行(8 个导出函数 + 本地 `listClaudeSessions`)。依赖(session 的 rollbackTo/opts、feishu turn-anchor、cards temp、claudeTranscriptDir)在 2.1/2.2/1.3/1.4/1.1 已就位。

**2.4 `daemon.ts`**(根):
- `sessionFor`(L106)扩 opts:传 `onCreateTempSession: createTempSession` / `onDisbandTempSession: disbandTempSession`。
- 新增 `createTempSession` / `disbandTempSession`(用 fork 既有的 `ensureChatForSession` / `disbandChatForSession` / `sessionFor` / `Session.dispose`)。
- `handleCardAction` 加 3 case:`temp_fork_select` / `temp_back_select` / `temp_resume_select`。
- `boot()`(L675-677 后)加 `feishu.loadSessionTurnsMap()`。

**2.5 `src/session-commands.ts`**:
- worktree 命令后、agy 前加 `btw` / `bye` / `fk` / `bk` 4 case(各带 agy 守卫 `s.startingAgy || s.runningAgy`)。
- `restart` case:空闲(`!s.isRunning()`)走 `await s.showResumeList(); return true`;进行中走原 restart(true)。

**阶段 2 验收**:整批改完一起 `bun build` + `bun test`。

**增量验证(避免 424 行 batch 失败无法二分)**:
- `session-temp.ts` 对 `Session` 是 **`import type`**(类型擦除),**无运行时循环依赖**。
- 建议先写 `session-temp.ts` 的 **typed stub**(8 个导出函数签名照抄、方法体 `throw new Error('todo')`),让 §2.2 的 `import * as sessionTemp` 能单独类型检查通过;再在 §2.3 填真实实现。阶段 2 拆成「2a stub + session/daemon/commands 类型检查通过」「2b 填实现 + 运行测试」两步可验证。

### 阶段 3 — 测试对齐 + README + 全量 + review

- **README.md**:1:1 移植 eae3a15 的 temp session 段 + `restart`/`rs` 命令表行,按 fork 既有命令措辞(`@supercc168/lodestar`)微调。
- **预调会破的既有测试**:实施前先 grep `src/session.test.ts`(87 例)/ `src/worktree.test.ts`(35 例)对 `sanitizeSessionName`(放行 `*`)/ `spawnAgent`(签名)/ `workDir` getter(剥临时后缀)的断言,逐个先行调整,避免最后全量才暴露。
- 跑 `src/cards/temp.test.ts`(1:1)+ 对齐 `src/session.test.ts`(fork 49KB,helper 结构可能差异,逐个核对)。
- 全量 `bun test` + `bun build`。
- code-review 独立 pass(重点:recordTurnAnchor 插入点 + 守卫、daemon 回调注入、notify/inbox 路由)。

## 6. 风险 + 缓解

| 风险 | 级别 | 缓解 |
| --- | --- | --- |
| `session.ts` 已复杂(上次移植 sanitize 被 review 抓 3 bug) | 中 | 阶段 2 完成即全量测试 + code-review 独立 pass;改动点逐个核行号 |
| `spawnAgent` Codex 分支合并(保留 `codexSpawnOverrides`/`configArgs`/`providerEnv`) | 低 | btw/fk/bk 在 session-temp 已 Claude 门控,Codex 分支不可达;仅 smoke 验证 provider 切换不崩 |
| **notify/inbox/hooks 与临时群交互未评估** | 中 | 实施前 grep notify(POST `/notify`)/ inbox(`~/.local/share/lodestar/inbox/`)/ handleCardAction / boot 里所有基于 `sessionName` 的路由,确认 `*MMDD-HHMM` 临时群走 `Session.all` registry + `chatIdForSession` 同通路;核对 inbox 是否过滤 `*` 名、notify 的 project→chatId 映射是否认临时群名 |
| 测试对齐(`session.test.ts` 49KB 结构差异) | 中 | `temp.test.ts` 先行(纯函数);session 集成测试对齐 helper |
| `daemon.ts` Session 构造点 / 群生命周期定制 | 低-中 | 调研已确认 `ensureChatForSession` 等签名兼容;实施时核对 fork daemon 的 Session 构造序列 |
| `claudeTranscriptPath`→`Dir` 重构动 L1252 + test L1006 | 低 | 保留旧 `claudeTranscriptPath` 函数(拆分非替换),backward-compat |
| `sanitizeSessionName` 放行 `*` 后用户手动输 `*` 保留 | 低 | 仅 `tempChatName` 主动造 `*` 后缀;移植时 grep 所有 `sanitizeSessionName` 调用点确认 |

## 7. 不在范围 / 后续

- 清理 stale 的 `upstream-pr/session-resume-fix` 分支(已 squash 并入 main)。
- `seedTurnAnchors` 在 `session-temp.ts` 未被调用(`onForkSelect` 注释"不继承锚点")—— dead-code 嫌疑,照搬但留意,不影响功能。
- Codex 后端的 fork / back(未来,需 Codex SDK 支持 resume 锚点)。
- `rs` 列表的 transcript 摘要解析(`firstUserSummary`)依赖 claude code transcript 格式 —— 移植后用一个真实 transcript 抽验编码逻辑(`workDir.replace(/\//g,'-')`)与实际目录一致。

## 8. 工作量估计

- 改动 ~900 行(与 `eae3a15` 的 +898 相当),但 **>80% 是 1:1 拷贝或 additive**。
- 真正手工:`spawnAgent` Codex 合并(1 处)+ 测试对齐 + daemon 核对。
- 整体:中等工程,风险中低(技术前提 GO、大部分 additive、eae3a15 自带测试基础)。
