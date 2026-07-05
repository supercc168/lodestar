<p align="center">
  <img src="https://raw.githubusercontent.com/leviyuan/lodestar/main/promo.jpg" alt="夜航星 Lodestar" width="100%">
</p>

# 夜航星 (Lodestar)

AI 不是帮手,是倍率。它放大的不是体力,是你 —— 你的直觉、判断和品味,每一样都被乘以一个你以前不敢想的系数。

夜航星让这件事真正发生:在你思考的地方接住想法,在你转身之后继续推向终点。

---

## 🚀 用起来

跨平台 (Windows / macOS / Linux),npm 全局安装后由 Node.js 运行,需要 Node.js ≥ 18；Bun 只用于源码开发和发布构建。

### 🧠 双后端:Claude Code + Codex

夜航星同时接入 Claude Code 和 Codex 两个 agent 后端,**默认 Claude Code**。群里发 `model` 可在 Claude·GLM-5.2 与 Codex·GPT-5.5 之间一键切换,选择按群持久化。

强烈推荐 Claude Code 搭配 **GLM-5.2** —— 开放 1M token 上下文窗口,长会话不易丢前文。订阅了 GLM Coding Plan,`hi` 控制台会直接展示套餐档位、5 小时滚动窗口与月度用量;每条回复的 footer 也会带上当前 5h 窗口的已用百分比(`5h·N%`),额度消耗随时可见。

**1. 装包**

```bash
npm i -g @leviyuan/lodestar
```

装完得到 5 个命令:

| 命令 | 作用 |
| --- | --- |
| `lodestar-setup` | 首次配置向导 |
| `lodestar-daemon` | 启动 daemon |
| `lodestar-stop` | 停止 daemon |
| `lodestar-update` | 升级到最新版(含 Codex CLI、Claude Code 和 Claude SDK)|
| `lodestar-version` | 查看 Lodestar 和 Codex CLI 版本 |

**2. 跑向导**

```bash
lodestar-setup
```

手把手带你装 Claude Code、可选配 GLM Coding Plan(1M 上下文)、建飞书应用、启动 lodestar。Codex 是可选第二后端。

> Claude 订阅(Pro/Max OAuth 登录)不支持本项目,需走 API 方式(GLM Coding Plan 或自备 Anthropic API key)。

**3. 拉机器人进群**

群名 = `projects_root` 下的目录名(没建会自动建)。发条消息,默认由 Claude·GLM-5.2 接管(群里发 `model` 可切到 Codex·GPT-5.5)。

群里发这些**裸词**(不要斜杠,大小写不敏感)可以控 daemon:

| 指令 | 行为 |
| --- | --- |
| `hi` | 未运行时同一张卡动态启动并收束为控制台;运行中弹控制台 |
| `stop` / `st` | 软打断当前 turn,子进程保活,排队消息打 ❌ |
| `kill` / `kl` | 用状态卡展示关闭 Codex 进程,`threadId` 落盘 |
| `restart` / `rs` | 用状态卡展示按上次 `threadId` 重启(保留上下文)|
| `clear` / `cl` | 用状态卡展示杀进程并开新 thread(等价 `/clear`)|
| `compact` / `cm` | 主动触发当前 thread 的上下文压缩,完成后状态卡收束 |
| `model` / `md` | 展示固定两项面板(Codex·GPT-5.5 / Claude·GLM-5.2),一键生效,按群持久化 |
| `task` | 打开项目任务清单面板,启用飞书任务清单自动化（预览版） |

**并发 worktree 群**

在项目主群发:

| 指令 | 行为 |
| --- | --- |
| `wt` / `worktree` | 列出本项目 `work/*` 分支状态(clean/dirty/merged/stale),已合并且未挂载的归档分支会折叠隐藏,卡片上可点 `删`。 |
| `wt feature-x` / `worktree feature-x` | 创建或加入同级目录/群 `<project>[feature-x]`,分支为 `work/feature-x`;重新激活已合并归档分支时会先更新到主线。 |

`删` 会先确认对应 worktree 群没有正在运行的 Codex session,再检查 worktree 没有未提交变更,然后解散群并删除 worktree 目录;分支保留,合并和分支清理由 agent 处理。

---

## 🎁 附加能力

### 📋 飞书任务清单自动化（预览版）

在项目群发 `task`,卡片点 `启用`,夜航星会创建并绑定一个 `<project>[lodestar]` 飞书任务清单。清单分组固定为:

| 分组 | 用途 |
| --- | --- |
| `设计中` | 默认分组;放需求、想法或待讨论任务,Codex 和 agy 会各写一条规划评论。 |
| `[AI]待执行` | 放已经准备交给 AI 实现的任务;worker 会挑一个进入执行。 |
| `[AI]执行中` | 当前自动执行中的任务;Codex 在本地 worktree 修改代码并生成本地审查请求。 |
| `[AI]待审核` | agy 审核后的任务;人工确认后勾选完成,触发 Codex 本地合并。 |
| `已完成` | 合并确认后的任务。 |

这个能力目前是预览版。worker 启动后会定时扫描绑定清单,一次只推进一个任务。所有规划、执行、审核、合并结果都会写回任务评论区;失败不会静默吞掉,会在评论或日志里暴露原因。

`task` 面板里的 `删` 会二次确认,确认后删除整个清单和清单内任务。这个能力需要飞书应用开通任务清单/任务/评论相关权限;缺权限时面板会显示 Open API 返回的失败原因和缺失 scope。

### 🔀 自定义 Claude Code 可执行文件(reclaude 等)

默认自动查找 `claude`(`~/.local/npm-global/bin` → `~/.local/bin` → PATH,都没有则用 SDK 自带二进制)。要换成 [reclaude](https://docs.reclaude.ai) 这类"参数原样透传给 claude"的包装器,在 `config.toml` 显式指定:

```toml
[claude]
bin = "~/.local/bin/reclaude"
```

配置后跳过自动查找;路径不存在会在会话启动时直接报错,不会静默回退。日志里 `executable=config:<路径>` 可确认生效。

迁移到 reclaude 时注意:`[claude.env]` 或 `~/.claude/settings.json` 里遗留的 GLM `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 必须清掉 —— base URL 指向 GLM 时流量不经官方域名,reclaude 的拦截不会生效,烧的还是 GLM 额度。`[claude.models.*]` 里的 GLM profile 也需换回官方模型档位。

### 🔔 HTTP 通知端点

本机任何脚本一行 curl 就能往群里推一张 markdown 卡片(info / warn / error 三档染色):

```bash
curl -sS -X POST http://127.0.0.1:9876/notify \
  -H 'Content-Type: application/json' \
  -d '{"project":"xxx","text":"build done","level":"info"}'
```

`/notify` 还支持可选的 `images` 字段,传本地图片绝对路径,夜航星上传到飞书后渲染在正文之前(上传失败会在卡片里显式标红,不会静默丢):

```bash
curl -sS -X POST http://127.0.0.1:9876/notify \
  -H 'Content-Type: application/json' \
  -d '{"project":"xxx","level":"warn","text":"卡点截图如下","images":["/abs/shot.png"]}'
```

`/notify` 还支持**交互按钮**:带上 `buttons`(最多 5 个)和一个本机 `callback` URL,群里点按钮后夜航星会把选择 POST 回这个 URL,整条回路都在本机 loopback 上。

```bash
curl -sS -X POST http://127.0.0.1:9876/notify \
  -H 'Content-Type: application/json' \
  -d '{"project":"ops","text":"deploy ready — approve?",
       "buttons":[
         {"id":"approve","text":"✅ 通过","type":"primary"},
         {"id":"reject","text":"❌ 拒绝","type":"danger"}
       ],
       "callback":"http://127.0.0.1:9999/hook"}'
# → 200 {"ok":true,"chat_id":"oc_…","message_id":"om_…","notify_id":"nf_…"}
```

有人在飞书点了按钮,daemon 就向 `callback` POST 这样一个 JSON,你的本机服务 2xx 应答即可。卡片是**两段式**反馈:点击瞬间立刻冻结成「⏳ 已选择:X · 推送中…」,推送送达后再刷成「✅ … · 反馈已送达」(失败则「⚠️ … · 回调失败:原因」,可再点重试)。调用方还可以在 2xx **响应体**里回一段文本(JSON `{"text":"…"}` 或纯文本,≤500 字,支持飞书 markdown),daemon 会把它显示在最终卡片「反馈已送达」下面那一行 —— 比如回 `{"text":"已发布 v1.2.3,提交 abc123"}`:

```json
{"notify_id":"nf_…","message_id":"om_…","chat_id":"oc_…","project":"ops",
 "button":{"id":"approve","text":"✅ 通过","type":"primary"},
 "operator":{"open_id":"ou_…"},"timestamp":1700000000}
```

约束:`button.id` 需匹配 `^[A-Za-z0-9_-]{1,64}$` 且不重复;`button.text` ≤ 64 字(每个按钮独占一整行,放短句也行);`type` 为 `default`/`primary`/`danger`;按钮数量不限,有几个就往下排几行;`callback` 可选 —— 给了就是 push(必须是 `http://` 且 host 为 `127.0.0.1`/`localhost`/`::1`,否则 400;回调需在 ~2.5s 内 2xx,否则点选显示"回调失败"并保持可重试)。**不给 `callback` 就走 pull**:daemon 照样把卡片冻结在已选项上并记下结果,调用方拿 `notify_id` 去轮询:

```bash
curl -sS http://127.0.0.1:9876/notify/result/<notify_id>
# 未点 → {"notify_id":"nf_…","project":"ops","message_id":"om_…","resolved":false}
# 点后 → {"notify_id":"nf_…",...,"resolved":true,
#         "button":{"id":"approve","text":"✅ 通过","type":"primary"},
#         "resolved_at":1783242381786,"resolved_by":"ou_…"}
```

绑定持久化在 `~/.local/share/lodestar/notify-callbacks.json`,daemon 重启不丢,7 天后自动清理。

### 🧩 项目级隔离配置（外部项目接入）

默认每个飞书群对应 `projects_root` 下同名目录,跑 Claude Code 默认工具集。当一个外部项目(不在 `projects_root` 下、且需要干净隔离的 agent)想接入时,在 `~/.config/lodestar/config.toml` 加一个 `[projects.<群名>]` 节即可 —— **未配置的项目行为完全不变**:

```toml
[projects.calculator2]
cwd                       = "/abs/path/to/evolving_data/calculator2"
setting_sources           = "project"
strict_mcp                = "true"
tools                     = "Read,Write,Edit,Bash,Glob,Grep"
load_project_mcp          = "true"
keep_lodestar_instructions = "true"
```

| 字段 | 作用 | 默认 |
| --- | --- | --- |
| `cwd` | agent 工作目录(绝对路径) | `projects_root/<群名>` |
| `setting_sources` | 显式列表如 `"project"`(只项目级,会丢全局)或 `"user,project"`;不配则**对齐裸 `claude` CLI**,读项目 `CLAUDE.md`/skills/agents/`settings.json` | `user,project,local` |
| `strict_mcp` | 只挂下方项目 MCP,忽略全局 MCP | 关 |
| `tools` | 允许的内置工具(逗号分隔);MCP 工具由 `load_project_mcp` 自动可用,不用列在这里 | claude_code 全套 |
| `load_project_mcp` | 读取 `<cwd>/.mcp.json` 并挂载其 MCP 服务(对齐裸 `claude` 自动发现;无则无效果) | 开 |
| `keep_lodestar_instructions` | 保留夜航星卡片/输出约定系统提示 | 开 |

`strict_mcp = "true"` 时,项目 `.mcp.json` 是 agent 能挂上 MCP 的唯一通路 —— 全局插件/技能被全部挡掉,agent 干净专注。典型用法:外部自动化引擎在自己的目录里维护规则文件,夜航星负责飞书通道和卡片渲染,两者通过群消息驱动协作。

> ⚠️ **这组配置必须完整,配一半会把对话卡死。** `[projects.*]` 的字段是联动的,任一项开启后,它依赖的链路都要一起配齐:
>
> - **`setting_sources = "project"`** 会排除用户级 `~/.claude/settings.json`。如果你的 GLM 路由 / `ANTHROPIC_BASE_URL` 是写在 `~/.claude/settings.json`(而不是 lodestar 的 `[claude.env]`),会被丢掉、请求发不出去 → 卡死。**走 `project` 模式时,GLM 路由必须落在 `config.toml` 的 `[claude.env]`**(`env` 不受 `setting_sources` 影响)。
> - 项目 `<cwd>/.mcp.json` 现在**默认读取**(对齐裸 `claude`)。若它存在,其声明的 MCP server 必须能秒级启动并完成 stdio 握手 —— server 卡住(路径错、二进制不存在、stdio 不响应)会让对话卡在真正调用模型之前,表现是卡片底部一直 `Thinking...` 且 model 显示成 `<synthetic>`。要跳过:显式 `load_project_mcp = "false"`。
> - **排查卡死**:看到 `model=<synthetic>` + 长时间 `Thinking`,先把 `[projects.*]` 整节注释掉重启 daemon;不卡了就是 profile 没配齐,按上面两条逐项检查。

---

> [!TIP]
> 想 7×24 长跑,用 `systemd --user`(Linux/macOS)或 Windows 任务计划程序拉起 `lodestar-daemon`。重启后上次活跃的 sessions 会并发自动 `--resume` 接回。

---

## 📄 许可

[MIT](LICENSE)
