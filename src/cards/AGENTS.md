<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-31 | Updated: 2026-10-11 -->

# cards

## Purpose
`src/cards/` 维护所有 Feishu Card Kit schema 2.0 模板和渲染辅助函数。它把一轮 Codex 对话、工具调用、权限请求、AskUserQuestion、控制台、状态卡、`model` 选择卡、`wt` worktree 卡、`agy` 任务卡和 Claude Code Task 工具(TaskCreate/Update/List/Get)的累积任务板、SDK `task_*` 后台任务/子 agent 的「后台游标卡」、临时会话 `fk`/`bk`/`rs` 的列表与回滚卡,都格式化成 session 可以交给 `cardkit.ts` 写入的 JSON 结构。

本目录生成 Feishu Card Kit schema 2.0 JSON 和展示文本。模板保持纯函数，网络、文件、进程状态和持久化由调用方处理。

- 共享 `element_id` 从 `ELEMENTS` 取；动态 ID 稳定、同卡唯一，与替换、删除和换卡逻辑一致。
- 空 Markdown 使用占位，终态关闭 streaming；缺失值显示 `MISS`/`—`。模型行右侧窄按钮用单字（选、显、隐、删），宽按钮保留完整文案（补录模型、显示模型、返回模型列表、上一页、下一页、取消）。模型行之间加分隔线，文字和按钮垂直居中，不重复显示相同的模型名与 ID。
- 模型面板首页用独立的展开式折叠面板承载 `claude`、`codex`、`dsh` 各组：浅蓝标题背景、边框和 `Agent · Claude Code/Codex/DeepSeek Harness` 标题，Token Source 行放在组内，不能将两层名称平铺成同级粗体。再进入模型 → effort；action 携带 `panel_id`、`source_id`，拒绝过期 panel。
- 可编辑来源区分两类动作：接口项显示/隐藏（`model_add` / `model_remove`），列表外记录补录/删除（`model_custom_prompt` / `model_custom_remove`）。`origin` 决定行按钮，`custom_models` 持久化补录；补录成功后可直接选择使用；有多个 effort 档位才展示选择卡，单档位（含原生 default）直接应用，不能因目录未收录而设为空档位或仅显示 MISS。OpenRouter 默认按六个家族各取账号目录中的最新版本（家族见根 `AGENTS.md`），其他来源跟随接口目录。中转站在首页每组只有一行「中转站」虚拟入口，点开后列出站点；站点模型面板不显示显隐与补录按钮（`allowCustom` 为 false）。删除仍被会话选用的补录项时拒绝操作；过期来源版本和跨页动作同样拒绝。
- 执行中追加消息使用 `user_steering` 续卡：新卡顶部显示连续原生输入区段内全部「📥 追加」及原任务轮次，逐条消费回执不各自生成卡片，不显示容量超限说明；Session 按原生消费事件切分正文，边界之前的内容留旧卡，之后的内容写新卡；运行中的工具随卡迁移，旧卡标记已续至下一张。
- `user_input` 面板标题为 `📥 收到 (N) #轮次`；用户裸消息冷启动后端时（`directStart`）轮次换成 🚀，并在启动标识后写本次账号分配结果（`📥 收到 (1) 🚀 · 账号 Claude·默认`，订阅池未选出时为 `账号 …·选号中`）。Session 开卡时写计划中的分配，进程就绪后用实际账号原地替换同一块 `user_input` 面板（`userInputPanel`），其他 turn 的标题不带账号。
- footer 模型标识固定为 `agent · 模型名/effort`（agent 小写）。token 明细统一口径：`入` = 新增输入（Codex 的 `input_tokens` 扣除缓存命中；Claude/DSH 的 `input_tokens` 并入缓存写入）、`缓` = 缓存命中、`出` = 输出，三项相加等于本轮总量。窗口额度沿用 `4.1h·7%·[6.9d·17%]` 的紧凑倒计时格式，不改成“额度 5h 已用…”或加入月度工具明细；余额显示 `余额 $…` / `余额 ¥…`。失败显示 MISS；Codex footer 刷新失败、进程已退出或换号时可按原格式直接展示本条回复所属账号的成功缓存，不加缓存或刷新失败标注，无缓存或认证失败仍 MISS。Codex 有消费积分时在窗口后追加 `积分 62.5k`；所有消费积分统一用小写 `k` / `m` 缩写千和百万，最多一位小数、去除尾零；未知显示 `积分 MISS`、确认没有则省略；不附加套餐、累计消费或解释性括号。
- Codex `request_user_input` 和 Claude `AskUserQuestion` 共用问答卡，保留各自回包语义、历史回答和自定义输入入口。
- `tool.ts` 生成工具摘要，`shell-command.ts` 解析 Bash、PowerShell 及引号包装后的首行 `# desc:`。Claude TaskCreate/Update/List/Get 在 `task-board.ts` 中累积为完整任务板。按字符上限截断 Markdown 时闭合未结束的代码围栏（`src/markdown-code.ts` 的 `closeOpenMarkdownFence`），避免截断提示和后续分区被渲染成代码；字面量内容用 `fencedCodeBlock` 包裹，围栏长于内容中的任何反引号串。`writeLogCard` 的文件内容同样按字面量展示，超过卡片大小上限时按顺序截断并注明未显示的变更数。
- 生图工具默认收起，完整提示词放在折叠体内；不超过 30 MB 的图片以结构化 `img` 子组件展示并允许点击预览，超过的图片由交付层转云空间。不要把提示词塞进标题，也不要把已嵌入的图片再单独发送。图片上传由 Session helper 处理，模板只接收 image key。
- 群里 `hi`（`console.ts` 的 `consoleCard`）只显示本项目：标题仍为 `🌟 Lodestar · <项目名>`、颜色随状态，正文只有 `consoleProjectElement` 信息块与 `consoleUsageElement` 额度面板，不再有活跃项目、主机和全部账号额度（这些只在单聊面板）。信息块一项一行：`**状态**　🟢 空闲 · 🤖1·⏳2 · 已运行 2.1h`（圆点与文字取 `SESSION_STATUS`，与 `bl` 相同，等审批文字标橙）、`` **模型**　Claude · `claude-opus-5-5/high` ``（先写 Agent 显示名 Claude / Codex / DeepSeek Harness，模型/effort 放行内代码）、`**账号**　Claude·默认`（调用方给的 `account.label`，经 `escapeInlineMarkdown`；`account` 为 null 时 stopped 写 `未启动`、其余写 `未确定`），可选的 wt 指令提示另起一行。额度面板标题 `📊 账号额度`，展开式浅蓝，只放该账号的 `accountUsageLines`，不重复账号名；`account` 为 null 时灰字 `账号未确定` / `未启动`，缺省为 `加载中…`。状态后用 `sessionWorkloadLabel` 追加运行中的子 Agent 与后台进程数（`空闲 · 🤖2·⏳1`，子 Agent 用 🤖、后台进程用 ⏳，取 `task-kind.ts` 的 `AGENT_CARD_TASK_KIND_ICON`，顺序与任务卡预览相同），0 省略、无工作时行文不变，读不到后台集合显示 `⏳MISS`；`bl` 同此写法，单聊面板的活跃项目把同样的计数写在项目名下面单独一行。模板只渲染调用方给的计数和账号，不查询进程或额度。运行时长与服务时长用 `console.ts` 的 `fmtUptime`（不足 1 分钟按秒，其余同 `fmtCountdown`：`40m`、`2.1h`、`3.0d`），hi 与单聊面板的会话时长都写作 `已运行 X`。
- 额度明细由 `account-usage.ts` 的 `accountUsageDetail` 统一生成：群里 hi 用 `accountUsageLines`（摘要为首行，其后每个窗口一行），单聊面板用 `accountUsageBlock`（首行 `**账号名**` 后接摘要，其后每个窗口一行）。摘要是单值结果——余额 `余额 ¥12.34`、令牌额度（`quota`）`剩余 $3.00 / $10.00` / `额度 未设上限` / `额度 MISS`、失败红字只写 `MISS`（完整原因收进该区默认折叠的 `⚠️ 额度读取失败` 面板，单聊面板每账号一条、hi 只列当前账号）、不适用时灰字 `无额度查询`、无快照 `加载中…`——或账号级事实：消费积分 `积分 62.5k`（`codexCreditsSummary`，确认为空省略、未知 `积分 MISS`）、`重置卡 N`（0 省略、未知 `重置卡 MISS`）、Claude 订阅 `凭据剩余 23.2d`（见 `src/AGENTS.md` 的 `claude-credential.ts`），一个窗口都没有时先写 `额度 MISS`；失败行不显示这些事实。窗口一行一个：`名称　▰▰▱▱▱▱ 34%　4.1h`。六格进度条的格数与颜色按四舍五入后的显示值（80% 起橙、100% 红，其余绿），百分比数字 80% 起橙、100% 红；重置为灰字 `fmtCountdown`，时间已过写 `已重置`，百分比已知而重置未知写 `重置时间 MISS`，百分比未知而重置已知写 `名称　MISS　4.1h`，整窗未知只写 `名称　MISS`。窗口名为 `5h`、`周`、`月工具`（GLM 月工具只有百分比，没有次数与重置）；Claude 模型专属周额度（`modelWeekly:*`、`seven_day_opus` / `seven_day_sonnet` / `seven_day_oauth_apps`）写作 `Fable 周`、`Opus 周`、`Sonnet 周`、`OAuth 应用周`，各占一行、带自己的重置，每行自成一体，不再与总周比较后省略；中转站脚本未登记的窗口照写脚本给的名称（`日额度`、`Pro 周额度`），缺失写 `额度`。中转站脚本的日期是未解析的字符串，只认 `Date`，其余按 MISS；`kind`、`label`、币种或原因不是字符串也不能让面板出错：缺币种只写数字，不是对象的窗口项写 `额度　MISS`，重置卡次数不是非负整数写 `重置卡 MISS`，其余格式问题由 `accountUsageDetail` 兜底为红字 `MISS` 与折叠面板里的 `额度数据格式无效`，不让整张卡生成失败。金额符号紧贴数字，令牌额度写明「剩余」，与 footer 的 `unifiedUsageSummary` 一致；统一额度摘要与 footer 不附带重置卡和凭据。单账号来源只写短名（`GLM`），多账号来源写“来源·备注”；Codex 按账号备注分开，只显示主额度、消费积分及重置卡，排除 Spark/gpt-reserve。账号列表每页附完整 Codex 账号命令说明，底部「Codex 命令」面板默认折叠。
- `model-refusal.ts` 生成 Claude 安全拦截提醒卡（`modelRefusalNoticeCard`）：会话级降级与本轮终止用橙色，子 Agent 局部降级用黄色；标题同时作群列表预览，正文说明原模型、降级模型、类别和切回方法（`md` 重选原模型或 `restart`），原生说明以灰色 notation 附在下方，没有按钮。标题是 plain_text，不做 Markdown 转义；正文中的上游文字一律经 `escapeInlineMarkdown`。`modelRefusalNoticeText` 是发送失败时的同文案纯文本。`claudeModelDisplayName` 把 `claude-opus-5-5`（含日期、`[1m]` 后缀）显示为 `Opus 5.5`，认不出的 ID 原样显示，缺失为 `MISS`。
- `p2p.ts` 的 `p2pConsoleCard` 是单聊只读面板，即全局总览，有自己的模板（不再用群里 hi 的元素拼成，只复用 `console.ts` 的主机元素、状态圆点/文字与 `fmtUptime`）。标题 `🌟 Lodestar`，副标题 `N 个项目运行中`（没有项目时省略）；`text_tag_list`（飞书最多显示 3 个）只写要留意的：`等审批 N` 橙、`工作中 N` 蓝、`服务失败 N` 红（仅内部读者）；标题颜色有等审批为橙，否则有工作中为蓝，否则绿；`config.summary` 的群列表预览为 `Lodestar · N 个项目运行中 · 等审批 1 · …`。正文依次为可选提示、`🗂 活跃项目 (N)`（展开）、`📊 账号额度`（展开，仅内部）、`🖥 主机`（默认展开，仅内部），底部 notation 一行 `P2P_CONSOLE_HINT`；没有当前模型、「当前」标记和按钮。活跃项目先按所属主项目（`mainSessionName`）、再按名称排序（`zh-Hans-CN`），项目的 `名*…` 临时群与 `名[…]` WT 群总挨在一起，不会被同前缀的其他项目（`名_v2`、`名-web`）隔开；每项多行、一行一类信息：首行只有状态圆点和项目名 ``⚙️ **`feishu`**``（空闲、工作中、等审批等状态已由圆点表达，不再重复状态文字），次行灰字写仍在运行的子 Agent 与后台进程数、运行时长（`🤖2·⏳1 · 已运行 2.1h`，没有计数时只写 `已运行 2.1h`，读不到后台集合写 `⏳MISS`），末行灰字为实际账号（`Claude·备注` / `Codex·备注`，`escapeInlineMarkdown` 转义，未知省略），项目名再长也只在首行换行，不会把计数和账号挤成回绕的长句；项目之间空一行，没有项目时灰字 `暂无运行中的项目`。账号额度每个账号一块（`accountUsageBlock`），块间空一行，没有账号时灰字 `暂无已配置账号`；失败账号行内只留红字 `MISS`，完整原因收进该区末尾默认折叠的 `⚠️ 额度读取失败 (N)` 面板（每账号一条 `**账号名**　原因`），不让长错误挤坏版面；账号列表、顺序与合并由调用方（`src/account-usage.ts` 的 `readAllAccountUsage`）决定：DeepSeek、GLM 的跨 Agent 入口合为一块，中转站每站一块，Codex 按账号备注，排除 Spark/gpt-reserve。主机区标题固定只有 `🖥 主机`，数值全在正文（负载取系统原生的 1m / 5m / 15m 平均值与核数，不折算百分比，核数或数值无效时显示 MISS；服务列表读不到时保留标题，正文只留红字 `MISS`，原因收进默认折叠的 `⚠️ 主机读取失败` 面板）。服务行不再重复英文状态，运行、停止、失败由圆点与「已运行 / 已停 / 已挂」表达并排在最前，其余状态照写。项目每 20 个、账号每 10 个合成一个 markdown 元素，组件数远低于飞书 200 上限。受限（外部联系人）时模板自己去掉账号名，不放主机与额度，标签也不写服务失败。模板只渲染调用方给的行，不判断可见性。
- Codex 的 `hi`、footer 和账号额度只显示主额度；只渲染接口实际返回的短时窗口、周窗口，缺少整个窗口时不补零或满窗，已返回窗口缺字段仍显示 MISS；不展示 GPT-5.3-Codex-Spark 等模型的附加额度。
- `codex-accounts` 去掉记录数和调度汇总行，按调度顺序排序后分页；每项标题为 `#1·备注「0.111/h」 · 重置 N`，重置次数取该账号额度缓存，保留零、缺失用 MISS；临期直接优先时用「临期优先」，仅剩消费积分时用「积分」且不伪造小时分数，无排名或分数用 MISS。正文首行为“邮箱：…”，随后按接口实际返回显示周、5h 窗口，各占一行，以六格进度条、已用百分比和「5.2d」真实倒计时显示，有消费积分时另加 `积分 62.5k`，未知显示 `积分 MISS`、确认没有则省略，不附加套餐或重置卡数；暂不可用保留可展开的具体原因，完整命令区保持默认折叠。调用方只读取账号邮箱缓存；后台模型/额度查询复用原生 `account/read` 发布邮箱，被额度去重的记录也保留各自账号信息。邮箱、额度及调度失败保留 MISS 和可展开的错误，不用备注或旧登录记录代替。后台激活错误由调用方传入 `activationErrors`，在对应账号下显示可展开的「后台激活 MISS」，模板不查询激活状态。
- Claude 订阅 footer 同时保留 5 小时与周额度（账号没有 5h 窗口时省略该段，不补 MISS），周额度按该条回复的模型选择专属窗口或总窗口；已返回的专属窗口缺数据时显示 MISS。hi 仍列出全部额度窗口。MD 和 hi 只使用 `claude-sub` 表示 Claude 订阅，不另设本机配置入口。reclaude 的 footer 额度沿用同一规则。
- Claude 订阅多账号在单聊面板的账号额度各占一块并使用账号备注，群里 hi 只显示本项目进程实际运行的那个账号；单聊面板的活跃项目显示实际运行的 Claude 账号。footer 捕获本轮真实账号的缓存视图，不随下一轮选号变化，不从聚合模型目录借用其他账号额度。
- `background.ts` 累积 Claude `task_*`、Codex collab 和 DSH 子 Agent 事件；子 Agent 直接展示，普通前台命令留在 pending。任务行与委派共用 `agent-cards.ts`：默认折叠，标题用 🤖 / ⏳ 标出子 Agent 与后台进程（委派任务仍写中文）并写状态与最多 40 字说明；后台进程的 ⏳ 与「进行中」状态同为 ⏳，同一个字符串只写一次（`⏳正在执行`），详情里的具体类型照写中文，只保留任务说明短摘要，结果在卡片安全上限内完整展示，超限明确截断，具体类型、错误和最近三步动作仍保留；完成后显示实际耗时，运行中不放需要定时刷新的计时。禁止恢复独立后台卡；共享卡必须留在群尾，新主卡发送前清掉旧卡未完成项并留迁移说明，新卡落地后在末尾重建，已完成项留作历史。任务行标题使用任务自身的说明（Claude `task_started.description`、Codex 子 Agent 名、DSH `subagent/descriptor` 的 label），进度/`task_updated` 只能补空标题，不能用最后一步操作顶掉任务说明。共享卡摘要即群列表预览（约 15 字），按运行/结束显示类别计数，例如 `🤖1`、`🤖1·⏳1`、`✅ ⏳1`、`❌ 1失败·2完成`、`❓ 待回答1`（运行中只写类别计数，不再加 `⏳` 进行中前缀——计数里的 ⏳ 就是后台进程数，加前缀会被读成「后台进程没有数量」；写法与 hi / bl 的 `sessionWorkloadLabel` 一致）；三类并存时用 `3项进行中`，不得再拼“运行任务 · 已结束 0/2”长句。
- 临时会话选择卡只携带 `panel_id`、opaque `choice_id`。provider、cwd、source、owner、launch 保存在 Session 短期状态，不能信任回调传入的可执行 id、数组下标或路径。rs 历史列表可额外展示会话短标签（`…` + 末 6 位，与状态卡和结果卡一致）、首句（🚩）和最后一条用户输入（🏁，只取用户消息，缺失时省略）；结果卡的「所选历史」同样显示首/末句。这些字段仅供人眼区分，不进入回调。
- 公式段使用固定 id 的单个顶层 `column_set`，按源码顺序替换内部 markdown/image。小图可用 `crop_center` 和精确 `size`；宽图用 `fit_horizontal`，不传 `size`，由容器缩放。
- Card action 立即换卡返回 `{ card: { type: 'raw', data: card } }`。异步更新先返回 toast ACK，再调用 `feishu.updateCard()`；不用 callback-token 的 `/interactive/v1/card/update`，该端点会让 schema 2.0 卡片空白。`notify_callback` 在 Session 存在性检查前分流。
- 项目独立 Agent 调用默认静默（`AgentRunSnapshot.display = 'silent'`），此时不进入 `agent-cards.ts`，群里没有卡片、进度或失败提示；调用方显式请求 `--card` / `display: "card"` 时才使用专属卡，一次 run 一张，不复用共享群尾卡；模板显示“项目任务”；项目调用不支持交互提问，不提供调用方回答指引。取消按钮通过 `agent_project_cancel` 路由，不依赖活跃 Session。

## Key Files
| File | Description |
|------|-------------|
| `turn.ts` | 对话主卡、assistant 分段、计划/目标/上下文压缩元素和 AskUserQuestion 面板；工具相关导出从 `tool.ts` 兼容 re-export。 |
| `tool.ts` | 工具折叠面板、权限按钮、Read / Edit 批次面板，以及 Bash/FileChange/WebSearch/MCP/Image/Agent 等工具输入/输出摘要。 |
| `shell-command.ts` | 命令展示解析唯一实现：统一解析 Bash / PowerShell / 引号包装命令首行 `# desc`(desc 变体前缀提取 + sh -c/统一 exec 引号/PowerShell 包装剥离)，`tool.ts` 与 `background.ts` 共用；导出 `stripQuotes`/`shellCommandPresentation`/`shellCommandDescription`。 |
| `task-board.ts` | Claude Code Task 工具(TaskCreate/Update/List/Get)的累积任务板。codex 的 TodoWrite 一次就带完整列表,但 Claude Code 拆成 4 个单点工具,这里维护一份以 task id 为 key 的 board(`applyTaskTool` 跨调用累积),`taskBoardElement` 渲染整个板产出与 codex 一致的列表效果。board 由 `session-tools.ts` 在 Session 级持有。 |
| `task-kind.ts` | 共享任务卡类别枚举(`delegated`/`project`/`subagent`/`background`)与标签/图标映射(`agentCardTaskKindLabel`/`agentCardTaskKindIcon`)；`agent-cards.ts` 与 `background.ts`(`backgroundTaskKind`)共用。 |
| `agy.ts` | `agy <prompt>` 任务卡片，渲染 prompt、状态统计、执行结果、仓库变更和转发 Codex 按钮。 |
| `format.ts` | 共享时长格式化：终态用 `fmtElapsed`(ms → `45s`/`2m13s`/`1h5m`)；活跃卡用 `liveElapsed(ms, mode)` / `elapsedBucket` 返回标签与下一刷新延迟。`mode` 来自 config `[runtime].live_elapsed`：`bucket`(默认粗档位) 或 `second`(按秒)。 |
| `console.ts` | `hi` 控制台、状态卡、菜单卡、模型/effort 选择卡、额度/主机信息格式化和关闭 streaming 设置。 |
| `worktree.ts` | `wt` 列表卡和创建/加入提示卡，展示 `work/*` 分支状态、归档摘要并提供常驻删除按钮。 |
| `background.ts` | SDK `task_*` 消息族(子 agent / 后台 bash / MCP / workflow)的状态累积 + 「后台游标卡」渲染:active/pending 双池(workflow/monitor 白名单 task_started 直入 active,其余前台 task 进 pending,对话推进时提升),吸附对话末尾,被新消息超越时沉降为历史快照,全终态固化留在原地。 |
| `temp.ts` | 临时会话 `fk`/`bk`/`rs` 卡片:`fk`/`bk` 的用户输入(turn 锚点)列表卡、`rs` 空闲模式的项目最近会话列表卡、`bk` 回滚后的 Write 记录卡;按钮 `value.kind`(`temp_fork_select`/`temp_back_select`/`temp_resume_select`)在 `daemon.ts` `handleCardAction` 里 dispatch。 |
| `turn.test.ts` | Bun 测试，覆盖 turn card、模型选择、工具摘要、权限元素和 console/status card 的关键渲染。 |
| `shell-command.test.ts` | Bun 测试，穷举 shell-command 解析用例：desc 变体前缀/引号转义(`''` 还原)/PowerShell 旗标与正斜杠路径/非 PowerShell 不误剥/多行前置行回退取尾行(纯函数零宿主依赖)。 |
| `agy.test.ts` | Bun 测试，覆盖 agy 卡片结构、状态行、输出清理、仓库摘要和转发按钮。 |
| `worktree.test.ts` | Bun 测试，覆盖 `wt` 卡片的归档隐藏和状态排序。 |
| `task-board.test.ts` | Bun 测试，覆盖 Task 工具累积语义(Create 抓 id/Update 改 status/List 全量替换与空数组清空/Get 补全)、board 统计摘要和整个板的列表渲染。 |
| `background.test.ts` | Bun 测试，覆盖后台任务状态机(started/progress/updated/settled/tool_use/tool_result)、active/pending 双池提升、live 卡与 history 卡切换。 |
| `temp.test.ts` | Bun 测试，覆盖 `fk`/`bk` turn 锚点列表卡、`rs` 会话列表卡和回滚 Write 记录卡的渲染。 |
| `elements.test.ts` | Bun 测试，覆盖 `ELEMENTS` element_id 命名约定和 `sanitizeMarkdownForCardKit`。 |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| _None_ | 此目录没有非排除子目录。 |

## For AI Agents

### Working In This Directory
- 保持 schema 2.0 JSON 结构清晰，所有共享 `element_id` 都从 `ELEMENTS` 取值，避免手写重复 ID。
- 工具摘要和工具面板渲染集中在 `tool.ts`；新增工具类型时先更新摘要/正文渲染，再在 session 工具流程中接线。
- 模型选择卡使用单个可替换的 `model_panel`，流程是模型列表面板 → effort 面板 → 成功结果面板。
- Bash 工具摘要会解析第一行 shell 注释里的 `desc` / `说明`；解析唯一实现在 `shell-command.ts`(`tool.ts` 主卡面板与 `background.ts` 后台卡 steps/Codex 子 agent 简报共用)，修改解析逻辑去 `shell-command.ts` 而非 tool.ts 内联；变更会影响飞书卡片中 shell 命令的可读性。
- 控制台卡片中的 usage、context window、host info 都是传入快照的格式化结果，不要在卡片模板里发起网络或系统调用。
- `worktree.ts` 的列表卡要优先适配手机宽度，按钮文本保持短，避免把操作按钮藏进折叠面板；已合并且未挂载的分支只放入归档摘要。
- `agy.ts` 卡片风格要和既有卡片一致：prompt 折叠标题固定为 `📥 agy收到`，状态保持单行，结果正文不折叠，转发按钮放在结果后，按钮文案尽量短。
- Feishu 对空 markdown、元素数量和 streaming TTL 都比较敏感；模板变更要和 `cardkit.ts` 的空内容过滤、元素计数和关闭 streaming 设置配合。
- 活跃 footer / 后台任务 header 的耗时经 `liveElapsed`/`elapsedBucket` 与 config `[runtime].live_elapsed` 决定：默认 `bucket` 只在档位边界调度；`second` 可恢复按秒展示(footer 1s / 后台 2s)。终态总耗时才使用 `fmtElapsed`。不要在默认路径恢复无开关的每秒 `setInterval`。
- 含公式的 assistant 段始终由固定 id 的单个顶层 `column_set` 承载，raw 与渲染态只替换内部 markdown/image 子元素链。保持源码顺序；小图可用 `crop_center` + 精确 `size`，超过手机安全宽度的图必须用 `fit_horizontal` 且不传 `size`，由卡片容器响应式缩小。不要拆成多个顶层元素或把公式集中到段尾。

### Testing Requirements
- 修改 `turn.ts` 或 `console.ts` 后运行 `bun test src/cards/turn.test.ts`。
- 模板、问答、工具和 IDs：`bun test src/cards/turn.test.ts src/cards/elements.test.ts src/cards/shell-command.test.ts`。
- 修改 `agy.ts` 后运行 `bun test src/cards/agy.test.ts src/agy-task.test.ts`。
- 修改 `worktree.ts` 后运行 `bun test src/cards/worktree.test.ts src/worktree.test.ts`，必要时用 debug 注入在真实群里检查卡片渲染和按钮回调。
- 修改 `background.ts` 后运行 `bun test src/cards/background.test.ts`;触及 session 事件接线时再跑全量 `bun test`。
- 统一委派面板与后台任务：`bun test src/agent-cards.test.ts src/cards/agents.test.ts src/cards/task-board.test.ts src/cards/background.test.ts src/session.test.ts`。
- 修改 `temp.ts` 后运行 `bun test src/cards/temp.test.ts`;触及 `session-temp.ts` 或 `daemon.ts` `handleCardAction` 的 `temp_*_select` dispatch 时再跑全量 `bun test`。
- 如果变更影响 `contextPercent`、usage 或控制台展示，也运行 `bun test src/context-window.test.ts`。
- 公式布局：`bun test src/math-render.test.ts src/cardkit.test.ts src/session.test.ts src/cards/elements.test.ts`。
- Card action：`bun test src/card-action.test.ts src/card-action-runtime.test.ts src/notify-callbacks.test.ts`。真实交互需要明确授权的目标群。
- 影响真实 Card Kit schema、按钮 action 或 streaming 设置时，需要在飞书群里做 smoke。

### Common Patterns
- 对话卡用顶部收起的 `user_input` 面板保存本轮收到的用户输入；工具和 assistant 片段按 Codex 事件顺序追加。
- 工具面板以折叠 panel 展示 header 摘要，正文按工具类型渲染命令、diff、网页搜索、MCP、图片生成或 agent 信息。
- AskUserQuestion 面板要保留历史回答、当前问题和自定义回答入口，并通过 action value 回到 session 权限流程。
- `agy` 卡片固定包含 prompt、stats、result、forward placeholder/button 和 repo 这几类元素；完成后用 `replaceElement` 更新结果、仓库变更和转发按钮。
- `model` 面板的按钮 action value 分别使用 `model_select` 和 `model_effort_select`，并带上 `panel_id` 防止旧卡回调污染当前选择。
- 控制台和状态卡统一通过 `streamingOffSettings` 在终态关闭 streaming 并写 summary。
- `wt` 列表使用 `column_set` 保持状态和删除按钮同屏可见；创建/加入提示使用轻量 notice card。
- 「后台游标卡」维护 active/pending 双池:workflow/monitor 白名单 task_started 直入 active,其余前台 task 进 pending 观察池,待对话推进(`promotePendingOnAdvance`)再提升;全终态时固化留在原地,只有被新消息超越才沉降成历史快照(`backgroundHistoryCard`)。
- `temp` 列表卡(`fk`/`bk`/`rs`)按钮 `value.kind` 固定为 `temp_fork_select`/`temp_back_select`/`temp_resume_select`,并带锚点/会话 id 防止旧卡回调污染新选择;回滚后额外发一张 Write 记录卡供复制。

## Dependencies

### Internal
- `src/cards.ts` 统一 re-export 本目录导出，调用方通常 `import * as cards from './cards'`。
- `src/session.ts` 和 `src/session-*` helper 依赖本目录生成卡片元素。
- `console.ts` 依赖 `src/sysinfo.ts`、`src/usage.ts` 和 `src/context-window.ts` 的类型与格式输入。

### External
- Feishu Card Kit schema 2.0：模板字段、按钮 action、markdown 和 streaming config 需要符合飞书接口约束。
- Bun test：执行 `turn.test.ts`、`agy.test.ts`、`worktree.test.ts` 和 `task-board.test.ts`。

<!-- MANUAL: Add manually maintained notes below this line. -->
