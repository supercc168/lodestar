<p align="center">
  <img src="https://raw.githubusercontent.com/supercc168/lodestar/main/promo.jpg" alt="夜航星 Lodestar" width="100%">
</p>

# 夜航星 (Lodestar)

AI 不是帮手,是倍率。它放大的不是体力,是你 —— 你的直觉、判断和品味,每一样都被乘以一个你以前不敢想的系数。

夜航星让这件事真正发生:在你思考的地方接住想法,在你转身之后继续推向终点。

---

## 🚀 用起来

跨平台 (Windows / macOS / Linux),从源码构建后全局安装、由 Node.js 运行,需要 Node.js ≥ 18;构建需要 Bun。

### 🧠 双后端:Claude Code + Codex

夜航星同时接入 Claude Code 和 Codex 两个 agent 后端,**默认 Claude Code**。群里发 `model` 弹出四个固定档位、一键切换、按群持久化:**Claude·Fable 5**、**Claude·Opus 4.8**、**Claude·GLM**、**Codex·GPT-5.5**。Fable 5 / Opus 走你的 Anthropic 登录态;GLM 是第三方路由,配好 token 后即插即用。默认档位是 Fable 5;配了 GLM 的话向导会把默认设成 GLM。

订阅了 GLM Coding Plan 的话强烈推荐 **Claude·GLM** 档位 —— GLM-5.2 开放 1M token 上下文窗口,长会话不易丢前文、中文友好。在 GLM 档位上,`hi` 控制台会展示套餐档位、5 小时滚动窗口与月度用量;每条回复的 footer 也会带上当前 5h 窗口的已用百分比(`5h·N%`),额度消耗随时可见。

**GLM 档位怎么配**:订阅后跑 `lodestar-setup`,第 2 步填入智谱 API key 就自动写好并设为默认;想手配或改模型,在 `~/.config/lodestar/config.toml` 加(**别写进 `~/.claude/settings.json`** —— 那会经 Claude Code 的 settingSources 污染 Fable 5 / Opus 登录档位,让它们也偷偷走 GLM):

```toml
[claude]
default_model = "glm"          # 新群默认走 GLM(可选;不写则默认 Fable 5 登录档位)

[claude.models.glm]
base_url   = "https://open.bigmodel.cn/api/anthropic"
auth_token = "<你的 GLM API key>"
model      = "glm-5.2[1m]"      # 直连智谱;[1m] 开满 1M 上下文(裸 glm-5.2 只给 ~200K)
effort     = "xhigh"           # 复刻 GLM-5.2 最高思维
```

`base_url` + `auth_token` 只注入 GLM 档位,Fable 5 / Opus 登录档位保持干净、绝不带 token。其它第三方路由照 `[claude.models.<名>]` 加即可。

**1. 装包**

```bash
git clone https://github.com/supercc168/lodestar.git
cd lodestar
bun install && bun run build
npm i -g .
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

群名 = `projects_root` 下的目录名(没建会自动建)。发条消息,默认由 Claude 接管(配了 GLM 就是 Claude·GLM,否则 Fable 5);群里发 `model` 可在四个档位间切换。

群里发这些**裸词**(不要斜杠,大小写不敏感)可以控 daemon:

| 指令 | 行为 |
| --- | --- |
| `hi` | 未运行时同一张卡动态启动并收束为控制台;运行中弹控制台 |
| `stop` / `st` | 软打断当前 turn,子进程保活,排队消息打 ❌ |
| `kill` / `kl` | 用状态卡展示关闭 Codex 进程,`threadId` 落盘 |
| `restart` / `rs` | 用状态卡展示按上次 `threadId` 重启(保留上下文)|
| `clear` / `cl` | 用状态卡展示杀进程并开新 thread(等价 `/clear`)|
| `compact` / `cm` | 主动触发当前 thread 的上下文压缩,完成后状态卡收束 |
| `model` / `md` | 展示四个固定档位(Claude·Fable 5 / Opus 4.8 / GLM · Codex·GPT-5.5),一键生效,按群持久化 |
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

### 🔀 接入 reclaude(自定义 Claude Code 可执行文件)

[reclaude](https://docs.reclaude.ai) 用本地 daemon 代理 Claude Code 流量、换成官方分配账号。它的 CLI 会把所有非管理参数**原样透传**给 `claude`、自身输出只走 stderr,且每次启动自动确保 daemon 存活 —— 正好可以作为 lodestar 的 Claude 可执行文件。

**接入步骤:**

1. 装好 reclaude 并 `reclaude login`,确认 `reclaude status` 里 daemon 和 gateway 正常
2. 跑 `lodestar-setup` 时,第 2 步的 GLM key **直接回车跳过**(额度走 reclaude,不需要 GLM)
3. 向导跑完后,在 `config.toml`(macOS/Linux 默认 `~/.config/lodestar/config.toml`)追加:

   ```toml
   [claude]
   bin = "~/.local/bin/reclaude"
   ```

4. 重启 daemon:`lodestar-stop` 后再 `lodestar-daemon`
5. 验证:群里发条消息,daemon 日志出现 `executable=config:…/reclaude` 即生效(stderr 里 reclaude 的 `同步配置…` 属正常输出)

**没配就发消息的典型症状**:群里报 `Failed to authenticate. API Error: 401 Invalid bearer token` —— 裸 `claude` 拿着 reclaude 的本地凭据直连官方 API 必然 401,补上第 3、4 步即可。

**通用说明**:`[claude].bin` 不限于 reclaude,任何"参数透传给 claude"的包装器都能配。设置后跳过自动查找(默认顺序 `~/.local/npm-global/bin` → `~/.local/bin` → PATH → SDK 自带二进制);路径不存在会在会话启动时直接报错,不会静默回退。

**从 GLM 迁移过来时**:`~/.claude/settings.json` 或 `[claude.env]` 里遗留的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 必须清掉 —— base URL 指向 GLM 时流量不经官方域名,reclaude 的拦截不会生效,烧的还是 GLM 额度。同时把 `[claude] default_model` 改回官方档位(或删掉,默认即 Fable 5);`[claude.models.glm]` 档位可保留但别设成默认。

### 🔔 HTTP 通知端点

本机任意脚本一行 curl 就能往群里推一张 markdown 卡片:`info` / `warn` / `error` 三档染色,正文支持飞书 markdown,还能附本地图片、加交互按钮、把点击结果 POST 回你自己的回调。这条能力对应的 skill,daemon 每次启动会自动装进 `~/.claude/skills/` 和 `~/.codex/skills/`(不用自己放文件),完整字段、按钮和回调协议看 [`feishu-notify` skill](src/notify-skill.ts)。

推一条带图的告警:

```bash
curl -sS -X POST http://127.0.0.1:9876/notify \
  -H 'Content-Type: application/json' \
  -d '{"project":"ops","level":"error","text":"卡点了,截图如下","images":["/abs/shot.png"]}'
```

发一张带按钮的审批卡,点了按钮 daemon 把选择 POST 回你本机的 callback:

```bash
curl -sS -X POST http://127.0.0.1:9876/notify \
  -H 'Content-Type: application/json' \
  -d '{"project":"ops","text":"deploy ready — 审批?",
       "buttons":[
         {"id":"approve","text":"✅ 通过","type":"primary"},
         {"id":"reject","text":"❌ 拒绝","type":"danger"}
       ],
       "callback":"http://127.0.0.1:9999/hook"}'
```

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
| `setting_sources` | `auto`(推荐)检测到项目 `.claude/` 或 `CLAUDE.md` 就自动 `user,project,local`、否则退回 `user`(始终含 `user`,不卡死);`project` 只读项目级设置,不加载用户级全局插件/技能;也可显式逗号列表 | `user`(可用 `[claude].default_setting_sources` 改全局默认) |
| `strict_mcp` | 只挂下方项目 MCP,忽略全局 MCP | 关 |
| `tools` | 允许的内置工具(逗号分隔);MCP 工具由 `load_project_mcp` 自动可用,不用列在这里 | claude_code 全套 |
| `load_project_mcp` | 读取 `<cwd>/.mcp.json` 并挂载其 MCP 服务 | 关 |
| `keep_lodestar_instructions` | 保留夜航星卡片/输出约定系统提示 | 开 |

`strict_mcp = "true"` 时,项目 `.mcp.json` 是 agent 能挂上 MCP 的唯一通路 —— 全局插件/技能被全部挡掉,agent 干净专注。典型用法:外部自动化引擎在自己的目录里维护规则文件,夜航星负责飞书通道和卡片渲染,两者通过群消息驱动协作。

**全局默认档**:不想每个群都写一节 `[projects.*]` 的话,可在 `[claude]` 节设 `default_setting_sources`,兜底所有未显式配置 `setting_sources` 的项目(项目级写了有效值就以项目级为准;项目级留空或全是非法 token 时同样落回全局默认),值语法与项目级一致:

```toml
[claude]
default_setting_sources = "auto"   # 新建项目自动按目录探测加载 .claude//CLAUDE.md
```

设成 `auto` 后,新建群(新项目)一旦目录里有 `.claude/` 或 `CLAUDE.md` 就自动加载项目级 agents/skills/hooks,无需再手配。下方「`auto` 档要点」的 hooks 警告对全局默认同样成立 —— 全局开 `auto` 意味着**每个**带 `.claude/` 的项目的 hooks 都会被加载,新项目落地前记得先审 hooks。

> ⚠️ **`auto` 档要点**:仅对 **Claude 引擎**有效(Codex 无论如何自动读 `AGENTS.md`)。`auto` 是**独占值**,别写成 `auto,project`。命中后会**整体加载项目 `.claude/settings.json` 的 hooks**(`SessionStart`/`UserPromptSubmit`/`PreToolUse`/`Stop`),它们每轮在 daemon 内执行且无 TTY 回显 —— `PreToolUse` 退出非零会**拦掉该次工具调用**、表现为"莫名卡住/失败的一轮";`settingSources` 全有全无,**无法只要 skills/agents 而摘掉 hooks**。接入前先审项目 hooks 是否会在自动化通道阻塞。

> ⚠️ **这组配置必须完整,配一半会把对话卡死。** `[projects.*]` 的字段是联动的,任一项开启后,它依赖的链路都要一起配齐:
>
> - **`setting_sources = "project"`** 会排除用户级 `~/.claude/settings.json`。GLM 路由走 `config.toml` 的 **`[claude.models.glm]`** 档位,由 lodestar 在 spawn 时注入 env、**不受 `setting_sources` 影响**,所以 `project` 模式下照常生效。真正会被丢掉的是残留在 `~/.claude/settings.json` 里的旧式 GLM env(`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`)—— 那种写法在 `project` 模式会被排除、请求发不出去 → 卡死;把 GLM 迁到 `[claude.models.glm]` 即可。
> - **`load_project_mcp = "true"`** 要求 `<cwd>/.mcp.json` 存在,且其声明的 MCP server 能秒级启动并完成 stdio 握手。server 卡住(路径错、二进制不存在、stdio 不响应)会让对话卡在真正调用模型之前 —— 表现是卡片底部一直 `Thinking...` 且 model 显示成 `<synthetic>`,此时模型其实根本没被调用。
> - **排查卡死**:看到 `model=<synthetic>` + 长时间 `Thinking`,先把 `[projects.*]` 整节注释掉重启 daemon;不卡了就是 profile 没配齐,按上面两条逐项检查。

---

> [!TIP]
> 想 7×24 长跑,用 `systemd --user`(Linux/macOS)或 Windows 任务计划程序拉起 `lodestar-daemon`。重启后上次活跃的 sessions 会并发自动 `--resume` 接回。

---

## 📄 许可

[MIT](LICENSE)
