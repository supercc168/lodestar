# Changelog

面向使用者的简版更新记录。这里只保留你能直接感受到的变化，以及必要的兼容提示；实现细节请看每个版本末尾的 compare 链接。

## v0.8.1 · 2026-06-06

- `hi` 面板里的 worktree 群提示更直接，会显示当前工作群的指令加载状态。
- 进入 `wt <name>` 工作群后，会更可靠地加载对应 slug 的本地 `AGENTS` 指令。
- 已合并但未挂载的 worktree 分支状态显示更准确，避免在主群列表里误判为 active。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.8.0...v0.8.1

## v0.8.0 · 2026-06-05

- 群里可以直接用 `model` 选择 Codex 模型和 reasoning effort，且会记住当前 session 的选择。
- 追问卡支持按钮、自定义输入和直接发文本回复，问答往返更顺。
- `wt` 工作群协作更完整：已合并分支可归档和重开，运行中的 worktree 群会阻止误删。
- 卡片统计、交互刷新和 `[[send: ...]]` 文件发送更稳定，token 与 summary 展示也更准确。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.7.0...v0.8.0

## v0.7.0 · 2026-06-02

- 主群现在可以直接创建或加入 `wt <name>` 工作群，并绑定同名 `work/<name>` 分支。
- worktree 列表会显示 `clean`、`dirty`、`merged`、`stale` 状态，干净 worktree 可直接删除。
- 已失效的飞书群绑定不会再被继续复用，长命令输出也不会把卡片撑爆。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.6.1...v0.7.0

## v0.6.1 · 2026-06-01

- plan 和 goal 的卡片进度更准确，减少重复刷屏，长轮次更容易看懂现在做到哪一步。
- 上下文窗口占用显示改为按真实窗口和最新 token 计算，比例终于可信。
- WS 断线恢复更快，daemon 自身重启说明也更清楚。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.6.0...v0.6.1

## v0.6.0 · 2026-05-31

- Codex 启动、默认模型选择和历史 session 恢复更稳，`hi` 启动后的状态也更一致。
- 轮次卡、console 卡和状态卡的收尾、计时器与恢复提示更顺，整轮体验更稳定。
- 流式输出结束后不再容易被后续刷新污染。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.5.0...v0.6.0

## v0.5.0 · 2026-05-27

- 内置定时任务系统已移除，自动化入口只保留本地 `/notify` 推送。
- 如果你此前依赖 scheduler、`/mcp` 或 `hi` 面板里的定时任务区，需要改用外部脚本配合 `/notify`。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.4.3...v0.5.0

## v0.4.3 · 2026-05-26

- 定时任务会拒绝明显错误的延时参数，避免写入坏任务。
- 每次定时执行都会留下本地巡检日志，方便回看跑过什么。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.4.2...v0.4.3

## v0.4.2 · 2026-05-26

- 工具卡片更像给人看的结果：文件改动、Web 搜索、MCP、图片和 agent 输出都更清楚。
- 助手文本收尾后不再被后续刷新改写，Bash 首行 `# desc:` 也会正确显示成操作摘要。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.4.1...v0.4.2

## v0.4.1 · 2026-05-26

- 只有真正可恢复的对话才会被持久化，重启后不再乱接回错误 session。
- 会话面板里的上下文占比与命令摘要展示更准确。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.4.0...v0.4.1

## v0.4.0 · 2026-05-25

- 底层从 Claude Code 切到 Codex CLI，安装、登录检查、更新流程和说明文档都同步切换。
- Codex 工具卡、上下文占比、daemon 恢复状态和流式续写体验一起做了适配和优化。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.3.13...v0.4.0

## v0.3.13 · 2026-05-25

- 换卡时的 `[[send: /abs/path]]` 文件发送更可靠，不容易漏发。
- 继续收紧卡片写入、提问握手、WS 健康检查和 token 统计的稳定性问题。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.3.12...v0.3.13

## v0.3.12 · 2026-05-21

- 回复开头较长时，后面即使紧跟工具调用或新段落，也不会再停在半句。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.3.11...v0.3.12

## v0.3.11 · 2026-05-21

- 某些情况下收不到消息、或回复开头被工具面板截断的问题已修复。
- Claude 偶发中断时会自动续接当前轮次，减少手动重发。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.3.10...v0.3.11

## v0.3.10 · 2026-05-20

- 慢网络下的流式打字不再回退或卡顿。
- 换卡或插入工具面板时，正文末尾不再被截掉半截。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.3.9...v0.3.10

## v0.3.9 · 2026-05-20

- 新增 `lodestar-version` 命令，可直接查看当前版本和运行环境。
- Windows 绝对路径形式的 `[[send: ...]]` 文件发送恢复可用。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.3.8...v0.3.9

## v0.3.8 · 2026-05-20

- 再次修复 Windows 下 Claude 子进程启动失败，近期 Node 安全更新带来的影响被补上。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.3.7...v0.3.8

## v0.3.7 · 2026-05-20

- 修复 Windows 下 Claude 子进程无法启动的问题。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.3.6...v0.3.7

## v0.3.6 · 2026-05-20

- DeepSeek 等第三方后端配置会写入全局，终端里直接跑 `claude` 也能沿用同一后端。
- 使用第三方后端时，不再误报“未登录”。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.3.5...v0.3.6

## v0.3.5 · 2026-05-20

- 安装向导现在能更可靠地装好 Claude CLI。
- 第三方后端不会再误报 Claude 未登录，新群第一条消息也能被正确识别。
- `stop` 后不再误弹“自动续跑”，定时任务过程卡的展示也与普通轮次对齐。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.3.4...v0.3.5

## v0.3.4 · 2026-05-19

- 新增 `lodestar-stop` 和 `lodestar-update`，常用维护命令补齐。
- 安装后默认提供 `lodestar-setup`、`lodestar-daemon`、`lodestar-stop`、`lodestar-update` 四个命令。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.3.3...v0.3.4

## v0.3.3 · 2026-05-19

- 仅补文档，无功能变化，重点把定时任务的用法和 `hi` 面板说明补齐了。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.3.2...v0.3.3

## v0.3.2 · 2026-05-19

- 新增持久化定时任务系统：支持跨项目查看、重启不丢、每次都用干净进程执行。
- 提供创建、单次、列表、删除 4 个定时任务工具，并支持“只推结果”或“推完整过程”两种通知方式。
- `hi` 面板加入定时任务看板，本地 `/notify` 也会随服务启动自动可用。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.3.1...v0.3.2

## v0.3.1 · 2026-05-18

- `hi` 面板的订阅剩余时间显示更精确，非 Claude 订阅用户看到的提示也更明确。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.3.0...v0.3.1

## v0.3.0 · 2026-05-18

- 支持 npm 全局安装和 Windows，`npm i -g @leviyuan/lodestar` 后即可进入配置向导。
- 长回答接近飞书卡片上限时会自动续到新卡，不再整张失败。
- 飞书富文本消息可以直接入站，回答异常结束也会自动续跑。
- 安装向导补齐关键飞书权限，机器人不再只能收到 `@自己` 的消息。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.2.9...v0.3.0

## v0.2.9 · 2026-05-17

- `hi` 面板新增主机、磁盘和后台服务状态，项目运行健康度更容易看。
- 新增本机通知接口 `127.0.0.1:9876`，本地脚本可以主动往群里推送消息。
- 出站文件不再受路径白名单限制。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.2.8...v0.2.9

## v0.2.8 · 2026-05-17

- 超过 10 分钟的长回答结束后，底栏不再卡在 `working...`。
- 快速连发多条消息时，后续批次不会再被误判成定时任务触发。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.2.7...v0.2.8

## v0.2.7 · 2026-05-17

- 进程崩溃或服务退出后，残留的 `⏳` 提示会被正确清掉。
- 只有卡片开成功才会发送内容，避免空跑；某些整段内容不显示的问题也已修复。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.2.6...v0.2.7

## v0.2.6 · 2026-05-16

- Bash 面板标题改用命令描述，连续读文件会自动合并到一个面板里，更容易扫读。
- `stop` 后会主动收卡，流式输出中断时也会尝试补上丢掉的内容。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.2.5...v0.2.6

## v0.2.5 · 2026-05-16

- `restart` 现在总会接回原对话；`clear` 在没有运行中会话时也不会误启空会话。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.2.4...v0.2.5

## v0.2.4 · 2026-05-16

- 上一轮尾部输出不会再串到新卡片，进程刚启动时连发的消息也能被正确接上。
- 排队计数卡死和 `⏳` 提示删不掉的问题已修复。
- 发送卡片或消息失败时会自动重试，且不会重复发送。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.2.3...v0.2.4

## v0.2.3 · 2026-05-16

- `hi` 面板在临时拉不到订阅数据时，会继续展示最近一次成功值并标明缓存时间。
- 遇到限流会自动退避重试，恢复后自动回到正常节奏。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.2.2...v0.2.3

## v0.2.2 · 2026-05-16

- `hi` 面板里离谱的上下文占比数字已修复。
- 回答中途不再因为切新卡而打断阅读。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.2.1...v0.2.2

## v0.2.1 · 2026-05-16

- 同一轮里合并的多条消息会明确分隔，连发 `1`、`45`、`12` 不会再被读成 `14512`。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.2.0...v0.2.1

## v0.2.0 · 2026-05-16

- 回答进行中继续发消息不会打断当前轮次，消息会排队，等本轮结束后合并处理。
- 排队状态对用户可见：收到会贴 `⏳`，处理完清除，被 `stop` 取消则显示 `❌`。
- 新增 `stop` 软打断，保留会话但停下当前回答并清空排队。
- 卡片底栏开始实时显示时长、上下文占用和本轮花费。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.1.12...v0.2.0

## v0.1.12 · 2026-05-16

- 合并消息开始带 `[#N]` 编号，底栏指标也换成了真实时长、上下文占比和本轮花费。
- 切卡时机调整到工具调用之间，正文或思考中途不再被拦腰截断。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.1.11...v0.1.12

## v0.1.11 · 2026-05-16

- 回答进行中可以继续发消息，不再用“新消息直接打断”的方式处理。
- 新增 `stop` 软打断、排队状态提示和 `📨 转交新卡` 收尾。
- Claude 自发定时唤醒会用 `⏰` 卡片承接，不再误触发加急通知。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.1.10...v0.1.11

## v0.1.10 · 2026-05-15

- 订阅用量改为调用 Anthropic 官方接口，显示更接近真实使用情况，失败时也会明确报错。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.1.9...v0.1.10

## v0.1.9 · 2026-05-15

- 加急通知的锁屏摘要更清楚，不点开也能知道是在等 Claude 提问还是工具审批。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.1.8...v0.1.9

## v0.1.8 · 2026-05-15

- `hi` 面板重做为实时看板：订阅用量、活跃项目列表会更早、更清楚地展示出来。
- 聊天列表预览会随输出实时滚动，完成和中断也有不同收尾文案。
- 新增加急通知：回答完成、Claude 提问、工具审批时可直接推手机提醒。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.1.7...v0.1.8

## v0.1.7 · 2026-05-15

- 一次抛多个问题时会改成逐题翻页，顶部可见进度，答过的问题会自动折叠。
- `restart` 或服务重启后，仍在运行的会话会自动带着上下文接回。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.1.6...v0.1.7

## v0.1.6 · 2026-05-17

- 卡片选项之外的自定义回答恢复可用，改为直接在群里发消息回传。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.1.5...v0.1.6

## v0.1.5 · 2026-05-17

- 提问卡作答后会自动折叠，标题直接显示你选了什么。
- 选项之外新增自定义答案入口。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.1.4...v0.1.5

## v0.1.4 · 2026-05-17

- 提问卡片更好点：整行可点，作答后会高亮已选项并弱化其余选项。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.1.3...v0.1.4

## v0.1.3 · 2026-05-17

- 修复提问卡点了选项却偶尔回传失败的问题。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.1.2...v0.1.3

## v0.1.2 · 2026-05-15

- Claude 向你提问时会直接渲染成可点按钮，点一下就能作答。
- 卡片底部会实时镜像当前任务清单，方便跟踪这轮在做什么。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.1.1...v0.1.2

## v0.1.1 · 2026-05-15

- 权限审批改为就地内嵌在原工具面板里，审批和后续输出留在同一条时间线上。
- 重启后可以自动接回原会话，任务类工具结果和 `hi` 面板也更像给人看的界面。

**Full Changelog**: https://github.com/leviyuan/lodestar/compare/v0.1.0...v0.1.1

## v0.1.0 · 2026-05-15

- 这是 2.0 基线：飞书群、无头 Claude Code 和流式卡片之间改成一条更干净的链路。
- 回答、思考和工具调用都能实时长在同一张卡片上，权限审批、裸词命令、文件互传也一并打通。
- 一群一进程、同名群正确路由、图片和文件双向互传从这里开始可用。
- 包名改为 `@leviyuan/lodestar`，1.x 历史版本在这次重写后退场。

**Source Snapshot**: https://github.com/leviyuan/lodestar/tree/v0.1.0
