# 设计:Codex turn watchdog 与一次性自动恢复

- 日期:2026-07-13
- 状态:已批准,待写实现计划
- 适用范围:所有 Codex 项目默认启用;Claude 首版不启用自动恢复
- 相关:`src/session.ts`、`src/session-types.ts`、`src/session-commands.ts`、
  `src/session-tools.ts`、`src/codex-process.ts`、`src/config.ts`、`src/cards/turn.ts`

## 1. 背景与现场证据

Lodestar 当前把普通 Codex turn 的生命周期交给 `codex app-server`:

- `turn/started` 建立运行态;
- assistant / tool / plan / goal / compaction 事件更新卡片;
- 只有 `turn/completed` 才产生 `result` 并关闭 turn;
- `Thinking...(Ns)` 是 Lodestar 自己的 footer 定时器,只表示当前没有可见工具或正文。

2026-07-13 的 `pokemon` 现场暴露出一个未覆盖的失败模式:

1. 最后一条真实 Bash 在 16:42:40 完成。
2. 主 agent 随后意图派发规格审查,实际只执行了无副作用的
   `text("dispatch ...")`。
3. 之后连续一个多小时重复 `text("ready")`,没有真实工具、子 agent 结果、正文或
   `turn/completed`。
4. app-server 进程、网络连接、reasoning 事件和 rollout 写入均存活,所以进程级
   watchdog 无法发现问题。
5. footer 持续计时,给用户造成“仍在工作”的假象。

这不是 daemon 崩溃,而是“协议层活跃、业务层无有效进展”的语义性活循环。

## 2. 决策摘要

采用 **Session 内事件型 watchdog + 一次性有界恢复**:

- 不读取或 tail `~/.codex/sessions/**/*.jsonl`;只消费 Lodestar 已有的结构化事件。
- 只对高置信度、可证明无副作用的重复空调用执行自动恢复。
- `15 分钟无有效进展 + 同一空调用指纹至少 10 次 + 全部安全守卫通过` 时触发。
- 每条真人任务链最多自动续跑 1 次;恢复后的 turn 再次命中时只中断和告警。
- 纯静默长推理在 30 分钟时只告警,不自动中断。
- 先软中断当前 turn;10 秒内未确认结束才重启该项目的 agent 子进程并 resume 同一
  thread。永远不自动停止或重启 Lodestar daemon。
- 所有 Codex 项目默认 `recover_once`;项目配置可覆盖为 `warn` 或 `off`。
- Claude 首版保持 `off`,避免用 Codex 事件假设误伤另一套 SDK 生命周期。

## 3. 目标与非目标

### 目标

- 自动识别本次 `text("ready")` 型空循环。
- 在不丢 thread 上下文、不丢真人排队消息的前提下自动中断并继续一次。
- 恢复失败时明确停止和告警,不形成“watchdog 自己无限重试”的第二层循环。
- 检测逻辑可用纯状态机和假时钟稳定测试。
- 正常 turn、真实长工具、后台子 agent、权限等待和普通长推理不受影响。

### 非目标

- 不判断任意 Bash / MCP 调用在业务语义上是否“有价值”。
- 不读取模型 reasoning 内容,也不把 token 增长当作进展。
- 不实现 daemon / Feishu WS / 网络健康 watchdog;它们已有独立生命周期。
- 不为 Claude Agent SDK 复用本设计;后续需按 Claude 事件单独评估。
- 不新增 chat 命令或卡片开关;首版通过配置控制。
- 不自动提交、回滚或清理工作区。

## 4. 方案取舍

### A. 只按 `Thinking` 时长中断

优点是实现最小。缺点是 footer 只表示“当前无可见输出”,无法区分正常 `ultra` 长推理
和卡死,误杀风险不可接受。排除。

### B. Session 结构化事件 watchdog(采纳)

直接利用 `assistant_text`、`tool_use`、`tool_result`、plan、goal、compaction、背景任务等
现有事件。能建立“有效进展”定义,并对已映射的 `dynamicToolCall` 输入做窄匹配。无需新
依赖,同时保持 Session 为 turn 生命周期所有者。

### C. tail Codex rollout JSONL

能看到完整 `custom_tool_call` 记录,诊断方便。但 rollout 是 Codex 私有持久化格式,
存在版本漂移、文件定位、增量读取和多 thread 过滤成本,也无法覆盖 Claude。只保留为
人工诊断手段,不进入生产判定链。

## 5. 组件边界

### 5.1 新增 `src/turn-watchdog.ts`

提供不依赖 Feishu、进程或定时器的纯状态机:

```ts
type WatchdogMode = 'off' | 'warn' | 'recover_once'
type WatchdogVerdict =
  | { type: 'none' }
  | { type: 'silent_warn'; idleMs: number }
  | { type: 'loop_warn'; idleMs: number; repeatCount: number; fingerprintHash: string }
  | { type: 'recover'; idleMs: number; repeatCount: number; fingerprintHash: string }
  | { type: 'stop_exhausted'; idleMs: number; repeatCount: number; fingerprintHash: string }
```

状态机只负责:

- 记录最后一次有效进展时间及摘要;
- 识别并累计同一空调用指纹;
- 记录本任务链是否已经自动恢复过;
- 根据当前时间和 Session 安全快照返回 verdict。

它不直接发卡、interrupt、restart 或发送续跑 prompt。副作用全部由 `Session` 编排。

### 5.2 Session 集成

每个 Codex `Session` 在 turn 打开时创建/切换 watchdog turn 状态,并用一个 15 秒 tick
调用 `evaluate(now, safetySnapshot)`。真人 `user_message` 开始新任务链并把恢复额度置 0;
内部 `watchdog_resume` 必须继承同一任务链和 `attempt=1`,不能因开了新 turn 把额度误重置。
`bg_task_resume` 首版只允许告警,不自动恢复。turn 正常完成、用户 stop/kill/restart、
进程 exit 或 Session dispose 时必须清理 tick。

事件处理仍留在现有 `wireProc()` 路径,只在对应分支附加一次 watchdog observe 调用。
不新增第二套 app-server listener。

### 5.3 共享中断原语

把 `session-commands.ts` 中 `stop` 的 turn 中断部分抽成 Session 级共享原语。真人 `st`
继续使用原行为;watchdog 使用同一原语但带不同 source、footer 和等待策略,避免两套清理
逻辑漂移。

watchdog 需要一个 `result` / process exit 可解析的一次性 waiter,用于确认软中断是否在
10 秒内真正结算。收到 JSON-RPC interrupt response 本身不等于 turn 已结束,不能作为成功
条件。

## 6. “有效进展”定义

以下事件更新 `lastMeaningfulAt`,清空当前重复空调用计数:

| 信号 | 条件 |
| --- | --- |
| assistant 正文 | 非空白 delta |
| 普通主线程 tool_use | 不属于已确认的无副作用空调用 |
| 普通主线程 tool_result | 有对应真实 tool_use;失败也算有效进展 |
| plan / goal | 内容或状态发生更新 |
| context compaction | start / completed 状态变化 |
| 子 agent / 后台任务 | started、progress、settled 等状态变化 |
| 真人新消息 | 开始新的任务链并重置恢复额度 |

以下信号不算有效进展:

- footer tick;
- token usage / rate limit / moderation 元数据;
- reasoning item start/completed;
- transport reconnect / warning / error 日志;
- 相同状态的重复卡片刷新;
- 已确认的无副作用空调用及其结果。

“进程存在”“CPU 有增长”“rollout 在变大”都不是 watchdog 的进展信号。

## 7. 首版空调用识别

首版故意采用窄匹配,只覆盖本次已验证事故,不尝试通用语义分析。

候选必须同时满足:

1. app-server item 映射为 `dynamicToolCall`。
2. 工具名规范化后是 `exec` 或 `functions.exec`。
3. 输入代码去掉首尾空白和单行注释后,只包含一个
   `text(<JSON double-quoted string>);` 调用。
4. 代码中不存在 `tools.`、`await`、`notify(`、`store(`、定时器或其他表达式。
5. tool_result 成功,结果只回显同一小段文本,没有图片、文件或其他内容。

不使用 `eval`。字符串用窄正则捕获后交给 `JSON.parse` 解码。指纹为
`sha256("exec:text\0" + decodedLiteral)`,日志只记录哈希和计数,不记录原文。

每次候选完成后:

- 与上一个候选指纹相同:`repeatCount += 1`;
- 指纹不同:`repeatCount = 1`;
- 任意有效进展:`repeatCount = 0`。

普通 Bash、MCP、文件修改、浏览器操作、Task/Agent 工具和包含任何嵌套 tool 调用的
`exec` 一律不归类为空调用,即使输入重复。

## 8. 触发条件与安全守卫

### 8.1 高置信度空循环

自动恢复必须同时满足:

```text
provider == codex
turn.trigger in [user_message, watchdog_resume]
now - lastMeaningfulAt >= 900s
sameNoopFingerprint.repeatCount >= 10
allSafetyGuardsPass == true
recoveryActionInFlight == false
```

满足上述条件后按 mode 分流:

- `off`:不产生 verdict;
- `warn`:每个无进展区间只产生一次 `loop_warn`;
- `recover_once`:未使用额度时产生 `recover`,已使用额度时产生 `stop_exhausted`。

### 8.2 安全守卫

触发前和真正调用 interrupt 前各检查一次:

- 当前仍是同一个 Session / thread / turn;
- 没有未完成的主线程真实工具;
- 没有 active 或 pending 子 agent / 后台任务;
- 没有 pending permission、AskUserQuestion 或 host ask;
- 没有 context compaction 或 card rotation 正在进行;
- 没有 agy 任务;
- 没有真人排队消息或正在开卡的用户 turn;
- provider / model 没有待切换。

“没有真人排队消息”必须通过新 helper 判断“当前 turn 之外的待处理输入”,不能直接要求
`pendingUserMessageCount === 0`,因为该字段也可能包含当前正在执行的输入。

任何守卫不满足时都不 interrupt。watchdog 保留观测状态,等下一个 tick 重新评估。

### 8.3 纯静默

若 1800 秒没有有效进展但未达到重复空调用条件:

- `warn` / `recover_once` 模式只发一次 `silent_warn`;
- 不 interrupt,不消费恢复额度;
- 后续有效进展会清除 warning latch;
- 同一静默期不重复刷卡或发消息。

## 9. 恢复状态机

### 9.1 第一次确认空循环

1. 原子设置 `recoveryActionInFlight`,再次检查安全守卫。
2. 停止 Thinking ticker,把原卡 footer 更新为
   `🛟 检测到无效循环 · 自动恢复 1/1`。
3. 保存 thread、turn、原发起人 open_id、最后有效动作摘要和 watchdog verdict。
4. 发送 soft interrupt,等待该 turn 的 `result` 或 process exit,最长 10 秒。
5. 正常结算时把原卡封口为
   `🛟 已自动中断 · 无进展 15m · 重复空调用 xN`。
6. 若等待期间没有真人新消息,在同一 thread 打开 `watchdog_resume` turn 并发送内部续跑
   prompt。
7. 若等待期间有真人消息,不发送内部 prompt;让现有消息队列成为下一 turn,真人输入优先。

### 9.2 soft interrupt 超时

若 10 秒内未收到 turn 结算:

1. 快照等待期间新到的真人消息及附件引用。
2. 调用现有 `restart(true)` 路径,只杀当前项目的 agent 子进程并 resume
   `lastSessionId`。
3. resume 成功后,优先重放真人消息;没有真人消息才启动内部恢复 turn。
4. resume 失败时保持 stopped,红色告警;不得静默 fresh-start。

快照与重放必须保留原消息顺序、文件提示和 reaction 生命周期。任何失败都不能让真人
消息消失。

### 9.3 内部恢复 turn

`TurnState.trigger` 新增 `watchdog_resume`。该卡显示恢复 banner,不渲染成真人
`📥 收到` 输入。发送给 Codex 的内部 prompt 固定表达:

```text
[Lodestar 自动恢复 1/1]
上一轮在最后一次有效进展后持续产生相同的无副作用空调用,已被中断。
请基于当前 thread 和工作区继续未完成任务。先核对现状和上次有效动作,
不要用空的 text(...) 调用代替实际派发、等待或结果汇报。
完成任务或遇到真实阻塞时直接给出明确结果。
```

prompt 不复制整段原始用户输入,避免扩大上下文;同一 thread 已保留原任务和工具历史。

### 9.4 恢复额度耗尽

内部恢复 turn 再次满足高置信度空循环条件时:

- 自动 soft interrupt;必要时仅为完成停止而 teardown 当前 agent 子进程;
- 不再发送内部续跑 prompt;
- 卡片封口 `⛔ 自动恢复后仍无进展 · 已停止`;
- 向原发起人发送一次通知,提示人工检查后继续;
- 保持工作区和 thread 可恢复状态。

下一条真人消息开始新任务链,恢复额度重新变为 1。

## 10. 配置

新增全局配置:

```toml
[watchdog]
codex_mode = "recover_once"       # off | warn | recover_once
stall_seconds = "900"             # 高置信度空循环最短无进展时间
repeat_noop_limit = "10"          # 同指纹空调用阈值
silent_warn_seconds = "1800"      # 纯静默只告警阈值
interrupt_grace_seconds = "10"    # soft interrupt 等待 turn 结算
```

缺省值即上例。所有 Codex 项目默认启用一次性恢复。项目级覆盖:

```toml
[projects.some-project]
watchdog_mode = "off"              # off | warn | recover_once
```

约束:

- `stall_seconds`:60..86400;
- `repeat_noop_limit`:3..100;
- `silent_warn_seconds`:必须 >= `stall_seconds`,且 <= 172800;
- `interrupt_grace_seconds`:1..60;
- enum 或数值非法时配置加载失败并指出字段,不静默回落到更激进模式。

Claude provider 无论全局 Codex 默认值如何都保持 `off`;首版不提供
`claude_mode` 伪配置。

## 11. 卡片与日志

### 卡片状态

| 场景 | 显示 |
| --- | --- |
| warn 模式命中空循环 | `⚠️ 检测到重复空调用 · 未自动中断` |
| 纯静默 30m | `⚠️ 长时间无可见进展 · 仍在等待` |
| 首次空循环 | `🛟 检测到无效循环 · 自动恢复 1/1` |
| 原 turn 已中断 | `🛟 已自动中断 · 无进展 Nm · 重复空调用 xN` |
| 恢复 turn | banner `🛟 自动恢复 1/1 · 从上次有效进展继续` |
| 恢复后再卡 | `⛔ 自动恢复后仍无进展 · 已停止` |
| resume 失败 | `❌ 自动恢复失败 · thread 恢复失败` |

纯静默 warning 只修改当前 footer,不另发一张卡。恢复触发和失败可急推原发起人一次。

### 结构化日志

事件名:

- `turn_watchdog_silent_warn`
- `turn_watchdog_loop_warn`
- `turn_watchdog_recover_start`
- `turn_watchdog_interrupt_settled`
- `turn_watchdog_resume_fallback`
- `turn_watchdog_recover_started`
- `turn_watchdog_exhausted`
- `turn_watchdog_recover_failed`

字段限制为 session、provider、thread/turn 截断 id、idle 秒数、repeatCount、fingerprint
哈希、attempt 和结果。禁止记录原始 prompt、工具输入全文、API key 或 config env。

## 12. 并发与失败处理

- `recoveryActionInFlight` 是每 Session 单写 latch,防止 15 秒 tick 重复触发。
- verdict 必须绑定 thread + turn id;异步恢复每个 await 后都验证身份,旧 turn 的延迟事件
  不得影响新 turn。
- 正常 `result`、真人 stop/kill/restart、process exit 优先,都会取消尚未执行的 watchdog
  动作并清理 timer/waiter。
- watchdog 触发后到 interrupt 前出现真人消息,立即取消自动动作。
- interrupt 后出现真人消息,保留消息并在结算后优先启动真人 turn。
- 卡片 patch 失败不阻塞 interrupt;使用现有 raw text 失败兜底记录告警。
- soft interrupt timeout 才允许 restart agent;不得把一次 Card Kit 失败、Feishu WS
  失败或纯静默当成 agent restart 理由。
- daemon shutdown 不持久化 watchdog attempt。daemon 重启本身已经 teardown 当前 turn 并
  resume session,不会从内存 latch 形成自动恢复循环。

## 13. 代码改动边界

### 新文件

- `src/turn-watchdog.ts`:纯状态机、空调用窄识别、配置类型和 verdict。
- `src/turn-watchdog.test.ts`:假时钟与纯函数测试。

### 修改文件

- `src/config.ts` / `src/config.test.ts`:解析 `[watchdog]` 和项目覆盖,校验默认值与范围。
- `src/session-types.ts`:新增 `watchdog_resume` trigger 和 turn watchdog 所需最小状态。
- `src/session.ts`:事件观察、15 秒 tick、恢复编排、result waiter、内部恢复 turn、清理。
- `src/session-commands.ts`:把真人 `stop` 与 watchdog 共用的中断清理抽到 Session 原语。
- `src/session-tools.ts`:在主线程 tool start/result 边界向 watchdog 提交结构化事件。
- `src/cards/turn.ts` / `src/cards/turn.test.ts`:恢复 banner 和终态 footer。
- `src/session.test.ts`:中断、排队消息、fallback resume 和额度集成测试。
- `README.md`:配置项、默认行为和项目关闭方式。
- `docs/开发与调试指南.md`:事件判定、debug 注入和禁止用 live daemon 做测试。

不修改 `codex-process.ts` 的 rollout 扫描逻辑。若 `dynamicToolCall` 当前映射缺少判断所需
字段,只允许补充结构化 event 字段,不得引入 JSONL tailer。

## 14. 测试设计

### 14.1 纯状态机

1. 15 分钟内即使有 10 次同指纹空调用也不恢复。
2. 15 分钟 + 第 10 次同指纹空调用返回 `recover`。
3. 9 次不触发;不同指纹重置连续计数。
4. assistant、真实工具、plan/goal/compaction、背景任务变化重置 idle 和计数。
5. reasoning/token/footer/error/reconnect 不重置。
6. `text("ready")` 与 `text("dispatch A6 spec reviewer")` 可识别且指纹不同。
7. 含 `tools.*`、`await`、多语句、单引号/模板字符串、普通 Bash 的输入不识别。
8. 30 分钟纯静默只返回 `silent_warn`,后续 tick 不重复告警。
9. `warn` 模式命中空循环只返回一次 `loop_warn`;`off` 模式永不返回 warning/recover。
10. 已恢复一次的任务链再次命中返回 `stop_exhausted`。

### 14.2 Session 集成

11. active tool、background/pending agent、ask、permission、compaction、rotation、agy 均抑制。
12. tick 判定后、interrupt 前到达真人消息会取消恢复且不丢消息。
13. interrupt 等待期间到达真人消息,结算后优先启动真人 turn,不发送内部 prompt。
14. soft interrupt 正常 result:不 respawn,同 thread 启动 `watchdog_resume`。
15. soft interrupt 10 秒超时:调用 `restart(true)`,resume 同 thread 后续跑。
16. fallback 前后的真人消息、文件提示、顺序和 reaction 完整保留。
17. resume 失败:Session stopped、红色告警、无 fresh session。
18. 恢复 turn 再次命中:stop only,不产生第三个 turn。
19. 新真人消息重置恢复额度。
20. 正常 result / stop / kill / restart / exit / dispose 全部清 timer、latch 和 waiter。
21. Claude Session 不创建自动恢复 watchdog,现有行为完全不变。

### 14.3 配置与卡片

22. 缺配置得到批准的 Codex 默认值。
23. 项目 `off` / `warn` / `recover_once` 正确覆盖。
24. 非法 enum、越界数值、silent < stall 明确报错。
25. `watchdog_resume` 卡不显示真人输入面板,展示一次性恢复 banner。
26. silent warning、恢复、耗尽和失败 footer 文案稳定。

### 14.4 回归验证

```bash
bun test src/turn-watchdog.test.ts src/config.test.ts src/session.test.ts src/cards/turn.test.ts
bun test
bun run build
```

不通过停止/重启 live daemon 做验证。需要人工 smoke 时使用 fake AgentProcess 或 debug 注入
构造结构化 no-op 事件;只有用户在当前消息明确授权时才可重启 live service。

## 15. 验收标准

- 注入本次事故序列后,第 10 个相同 `text("ready")` 到达且 idle >=15 分钟时只触发一次
  自动恢复。
- 正常长 reasoning 30 分钟只出现一次 warning,不会 interrupt。
- 有真实工具、子 agent、权限等待或真人排队消息时不会自动 interrupt。
- soft interrupt 成功时不 respawn;超时才 resume 当前项目的同一 thread。
- 恢复后再次空循环会停止并告警,不会无限续跑。
- 任何竞态下真人消息和附件都不丢失、不乱序。
- 所有 Codex 项目默认生效,项目配置可关闭;Claude 无行为变化。
- watchdog 不读取 rollout JSONL,不操作 Lodestar daemon。
- 定向测试、全量 `bun test` 和 `bun run build` 全部通过。

## 16. 发布与回滚

- 这是默认行为变更,README 和 release notes 必须明确说明“仅高置信度空调用会自动恢复一次”。
- 实现发布后只有 daemon 下次正常重启才生效;开发和提交阶段不主动重启 live service。
- 出现误判时可在项目配置设 `watchdog_mode = "warn"` 或 `"off"`,无需回滚代码。
- 全局紧急关闭可设 `[watchdog] codex_mode = "off"` 后在获得明确授权的维护窗口重启。

## 17. 已确认决策

- 恢复策略:保守模式,15 分钟、同指纹至少 10 次、自动续跑最多 1 次。
- 启用范围:所有 Codex 项目默认 `recover_once`。
- 纯静默策略:30 分钟只告警,不自动中断。
- fallback:soft interrupt 10 秒未结算才重启项目 agent 并 resume。
- 数据源:结构化 app-server / Session 事件;不 tail rollout。
- Claude:首版不启用。
