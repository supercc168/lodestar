# 夜航星 (Lodestar) 项目说明书

> **版本**:v0.11.19 · **许可**:MIT · **仓库**:https://github.com/supercc168/lodestar
>
> 本说明书面向**第一次接触本项目的人**:读完你能明白它是什么、能帮你做什么、怎么装、**怎么配飞书**、以及怎么在飞书里用起来。

---

## 一、这是什么?

**夜航星(Lodestar)** 是一个跑在你自己电脑上的**后台程序(daemon)**,它把 **飞书群聊** 和 **AI 编程助手(Claude Code / Codex)** 连了起来。

一句话:**你在飞书群里发一句话,AI 就在你电脑上对应的项目里帮你干活,并把整个过程用飞书卡片实时显示给你看。**

它把原本只能在电脑终端里用的 AI 编程助手,变成了一个**随时随地(手机飞书就行)、可以同时管多个项目、能 7×24 小时在后台长跑**的远程助手。

### 能帮你做什么?
- 🧑‍💻 **远程写代码 / 改项目**:出门在外,用手机飞书发指令,AI 在家里的电脑上改代码、跑命令。
- ⏳ **长任务后台推进**:交代一个大任务,合上电脑走人,AI 继续做,做完通知你。
- 🗂️ **多项目并行**:每个飞书群对应一个项目,互不干扰。
- 🔔 **脚本告警推送**:本机任何脚本一行命令就能往飞书群推消息(带图片、带审批按钮)。

### 一个直观的例子
1. 你有个项目文件夹叫 `myapp`。
2. 你建一个飞书群也叫 `myapp`,把机器人拉进去。
3. 你在群里发:`帮我把登录页的按钮改成蓝色`。
4. 机器人(AI)在 `myapp` 目录里找到代码、改好、可能还跑了测试,整个过程一张飞书卡片实时滚动显示。
5. 改完它回复你结果。你说 `很好,提交一下`,它就帮你 commit。

---

## 二、它是怎么工作的?(一张图看懂)

```
   你(飞书 App)                你的电脑
 ┌──────────────┐          ┌─────────────────────────────────────┐
 │  在群里发消息  │  飞书云   │      夜航星 daemon(后台程序)         │
 │  "改个按钮"    │ ───────▶ │   ① 收到消息,认出这是哪个群          │
 │              │  长连接   │   ② 群名 → 找到对应的项目文件夹        │
 │  看卡片实时   │ ◀─────── │   ③ 把指令交给 AI(Claude / Codex)   │
 │  显示 AI 过程 │  卡片     │   ④ AI 在项目文件夹里读写代码、跑命令  │
 └──────────────┘          │   ⑤ 过程实时画成飞书卡片发回群里       │
                           └─────────────────────────────────────┘
```

**三条要记住的规则:**
1. **一个飞书群 = 一个项目文件夹**(群名必须等于文件夹名)。
2. **群里发的话 = 给这个项目的 AI 下指令**。
3. **每轮对话 = 一张飞书卡片**,AI 的思考、执行命令、改代码、结果都在这张卡片上实时更新。

---

## 三、开始之前:需要准备什么

| 准备项 | 说明 |
| --- | --- |
| **一台常开的电脑** | Windows / macOS / Linux 都行。daemon 跑在这台机器上,AI 也在这台机器上操作你的项目。 |
| **Node.js ≥ 18** | 运行环境。 |
| **Bun** | 从源码构建时需要(装一次即可,[bun.sh](https://bun.sh))。 |
| **一个 AI 后端** | **二选一**:①【推荐】**GLM Coding Plan**(智谱,性价比高、中文友好、1M 上下文);② 自备 **Anthropic API key**。 |
| **一个飞书账号** | 用来创建"自建应用"(就是那个机器人)。个人开发者即可。 |

> ⚠️ **重要限制**:Claude 的 **Pro / Max 订阅(网页登录那种)不支持本项目**。必须走 **API 方式** —— 要么用 GLM Coding Plan,要么用 Anthropic API key。这是 Claude 官方的限制,不是本项目的问题。

---

## 四、安装

在你的电脑终端里执行:

```bash
git clone https://github.com/supercc168/lodestar.git
cd lodestar
bun install && bun run build
npm i -g .
```

装完你会得到 **5 个命令**:

| 命令 | 作用 |
| --- | --- |
| `lodestar-setup` | **首次配置向导**(手把手带你配好一切) |
| `lodestar-daemon` | 启动后台程序 |
| `lodestar-stop` | 停止后台程序 |
| `lodestar-update` | 升级到最新版 |
| `lodestar-version` | 查看版本 |

> 大多数人只需要跑 `lodestar-setup`,它会自动带你走完下面第五、六章的所有步骤。本说明书把每一步展开讲清楚,方便你理解和排查。

---

## 五、【重点】配置飞书机器人(手把手)

这是**最容易卡住新手**的一步,请一步一步来。整个过程在飞书开放平台 **https://open.feishu.cn/app** 完成。

### 5.1 创建应用
打开 https://open.feishu.cn/app → 点 **"创建企业自建应用"** → 填个名字(比如 `Lodestar`),logo 随意。

![图 5.1 创建企业自建应用](images/feishu/5.1-create-app.png)
> 📷 **待补图 5.1** ｜ 截图内容:飞书开放平台首页,点「创建企业自建应用」按钮、以及填写应用名称/图标的弹窗页面。

### 5.2 添加机器人能力
左侧菜单 **"添加应用能力"** → 找到 **"机器人"** → 点 **"添加"** 按钮。
> 没这一步,应用不是机器人,进不了群。

![图 5.2 添加机器人能力](images/feishu/5.2-add-bot.png)
> 📷 **待补图 5.2** ｜ 截图内容:「添加应用能力」页面,展示"机器人"这一项和它的"添加"按钮(添加后显示已启用的状态最好)。

### 5.3 开通权限(左侧"权限管理" → "开通权限")
> ⚠️ **缺一个权限,daemon 启动后就会默默丢消息**,所以下面这些**要全开**。

**消息类权限:**

| 权限 scope | 用途 |
| --- | --- |
| `im:message:send_as_bot` | 以机器人身份发消息 |
| `im:message` | 接收/操作消息(**核心**) |
| `im:chat` | 读/写群信息(用来把群名匹配到项目目录) |
| `im:chat:create` | `wt` 功能:自动创建 worktree 群 |
| `im:chat:delete` | `wt` 功能:解散 worktree 群 |
| `im:chat.members:read` | `wt` 功能:判断发起人是否已在群内 |
| `im:chat.members:write_only` | `wt` 功能:把发起人拉进已有 worktree 群 |
| `im:resource` | 上传/下载附件(图片、文件双向) |
| `im:message.urgent` | 加急推送(锁屏通知 / AI 提问时) |
| `im:message.group_msg` | **敏感,最关键**:接收群里的所有消息 |
| `im:message.group_at_msg:readonly` | 读 @ 机器人的消息(兜底) |

> 🔑 **`im:message.group_msg` 是最关键的一个**:没有它,机器人**只能收到 @ 它的消息**,拿不到群里的普通对话,你发消息它就"没反应"。这是敏感权限,申请时要**填用途走审批**,个人开发者通常秒过。

**卡片类权限(Card Kit):**

| 权限 scope | 用途 |
| --- | --- |
| `cardkit:card:read` | 读卡片状态 |
| `cardkit:card:write` | 创建/更新卡片(**流式渲染的核心**) |

![图 5.3 开通权限](images/feishu/5.3-permissions.png)
> 📷 **待补图 5.3** ｜ 截图内容:「权限管理 → 开通权限」页面,展示搜索/勾选权限 scope 的界面(最好能看到已勾选的 `im:message`、`im:message.group_msg`、`cardkit:card:write` 等几个关键权限)。如果 `im:message.group_msg` 敏感权限有单独的申请/审批弹窗,也来一张。

### 5.4 订阅事件(左侧"事件与回调")
这里分**两个子页**,每个都要把"订阅方式"设成 **长连接**:

**a) "事件配置" 页:**
- **"订阅方式" → 选 "长连接" → 点保存**
- 添加事件:`im.message.receive_v1`(收群消息)

![图 5.4a 事件配置](images/feishu/5.4a-event-subscribe.png)
> 📷 **待补图 5.4a** ｜ 截图内容:「事件与回调 → 事件配置」页面,展示"订阅方式"已选**长连接**,以及已添加事件 `im.message.receive_v1`。

**b) "回调配置" 页:**
- **"订阅方式" → 选 "长连接" → 点保存**
- 添加事件:`card.action.trigger`(卡片按钮点击回调)

![图 5.4b 回调配置](images/feishu/5.4b-callback-subscribe.png)
> 📷 **待补图 5.4b** ｜ 截图内容:「事件与回调 → 回调配置」页面,展示"订阅方式"已选**长连接**,以及已添加事件 `card.action.trigger`。

> ⚠️ "订阅方式"如果没选"长连接",机器人一样收不到消息。

### 5.5 发布版本 —— 别忘了这一步!
页面顶部 **"创建版本"** → 滚到底点 **"保存"** → 弹框点 **"发布"**。

![图 5.5 创建并发布版本](images/feishu/5.5-publish.png)
> 📷 **待补图 5.5** ｜ 截图内容:顶部「创建版本」的入口,以及版本信息页底部「保存 → 发布」的按钮(能体现"发布/申请上线"这一步即可)。

> 🚨 **没发布版本的应用,收不到任何事件!这一步九成新手会忘。** 如果你配完发消息机器人毫无反应,先回来检查是不是没发版。

### 5.6 拿凭据
左侧 **"凭证与基础信息"** → 记下顶部的 **App ID**(以 `cli_` 开头)和 **App Secret**,下一章要填。

![图 5.6 凭证与基础信息](images/feishu/5.6-credentials.png)
> 📷 **待补图 5.6** ｜ 截图内容:「凭证与基础信息」页面,展示 **App ID** 和 **App Secret** 的位置(**截图前请把真实密钥打码**,只体现在哪儿找即可)。

### 5.7 把机器人拉进群
进入你想用的飞书群 → **群设置 → 群机器人 → 添加机器人 → 选你刚建的应用**。

![图 5.7 把机器人拉进群](images/feishu/5.7-add-to-group.png)
> 📷 **待补图 5.7** ｜ 截图内容:飞书群「群设置 → 群机器人 → 添加机器人」的界面,展示选中你的应用把它加进群的过程。

> ⚠️ **群名必须等于项目目录名**。默认项目根目录是你的用户主目录,比如群叫 `myapp`,对应的就是 `~/myapp`(不存在会自动创建)。**未命名的群拿不到群名,无法映射项目,机器人会提示你先给群设置名称。**

---

## 六、跑起来

### 方式一:配置向导(推荐)
```bash
lodestar-setup
```
向导会依次做 4 件事:
1. **确保 Claude Code CLI 装好**(没装会自动 `npm i -g @anthropic-ai/claude-code`);
2. **填 GLM API key**(推荐,可选;拿 key:https://open.bigmodel.cn → 控制台 → API Keys)+ 可选配置 Codex;
3. **填飞书 App ID / App Secret**(会自动联网验证凭据是否正确,错了让你重填);
4. **设项目根目录**(默认你的主目录)→ 自动在后台启动 daemon。

跑完向导,daemon 就在后台跑起来了。**最后一步:在飞书群里发任意一条消息**,默认由 Claude 接管,你就能看到卡片了。

![图 6.1 配置向导运行界面](images/feishu/6.1-setup-wizard.png)
> 📷 **待补图 6.1** ｜ 截图内容:终端里运行 `lodestar-setup` 的界面(能看到 4 个步骤的引导、飞书凭据测试通过 ✓、daemon 启动成功那几屏最好)。

### 方式二:手写配置文件
配置文件位置(macOS/Linux):`~/.config/lodestar/config.toml`。最小配置只需要飞书凭据:
```toml
[feishu]
app_id = "cli_xxxxxxxx"
app_secret = "xxxxxxxx"

[runtime]
projects_root = "~/"     # 项目根目录,可选,默认主目录
```
写好后运行 `lodestar-daemon` 启动。(GLM / 其它配置见第八章。)

---

## 七、【重点】在飞书里怎么用

### 7.1 基本用法
- **发消息 = 下指令**:在群里直接说你要做什么,比如"帮我加个搜索功能""这个 bug 怎么回事""跑一下测试"。
- **看卡片 = 看过程**:AI 每轮回复是一张卡片,实时显示它的思考、执行的命令(带说明)、代码改动(diff)、以及底部状态。
- **多轮对话**:AI 做完一轮空闲后,你可以接着说"再改一下 X",它会继续。

![图 7.1 对话卡片实时显示](images/feishu/7.1-turn-card.png)
> 📷 **待补图 7.1** ｜ 截图内容:飞书群里一张典型的对话卡片 —— 你发了个任务,AI 正在执行,卡片上有正文、工具调用/命令、代码 diff、底部状态那种。这是最能体现产品观感的一张,建议挑个漂亮的例子。

> 💡 提示:一个群就是一个项目的"专属工作台",群里说的每句话默认都是对这个项目的 AI 说的,不需要 @ 机器人。

### 7.2 群控命令(直接发这些"裸词",不带斜杠,大小写不敏感)

| 指令 | 作用 |
| --- | --- |
| `hi` | 唤起控制台(显示项目状态、模型、用量等) |
| `stop` / `st` | 打断当前这轮(AI 停下,但进程保活) |
| `kill` / `kl` | 关闭 AI 进程 |
| `restart` / `rs` | 重启并**保留上下文**(接着之前的聊) |
| `clear` / `cl` | 清空上下文、开一段全新对话 |
| `compact` / `cm` | 压缩当前上下文(长对话省 token) |
| `model` / `md` | **切换 AI 模型**(见 7.3) |
| `task` | 打开任务清单面板(见 7.5) |
| `wt` / `worktree` | 多分支并行开发(见 7.4) |

![图 7.2 hi 控制台](images/feishu/7.2-hi-console.png)
> 📷 **待补图 7.2** ｜ 截图内容:群里发 `hi` 弹出的控制台卡片(展示项目状态、当前模型、用量、主机信息等)。

### 7.3 切换 AI 模型(`model`)
群里发 `model`,弹出固定档位,点一下即切换,**按群记住**:

| 档位 | 说明 |
| --- | --- |
| **Claude · Fable 5** | 走你的 Anthropic 登录态 |
| **Claude · Opus 4.8** | 走你的 Anthropic 登录态,能力最强 |
| **Claude · GLM** | GLM-5.2,**1M 超长上下文、中文友好**(需配 GLM key) |
| **Claude · Grok** | Grok 第三方 Anthropic 兼容路由(需配置对应 token) |
| **Codex · GPT-5.6 Sol** | OpenAI Codex(需登录 ChatGPT),`max` 推理强度 |

![图 7.3 model 模型切换面板](images/feishu/7.3-model-panel.png)
> 📷 **待补图 7.3** ｜ 截图内容:群里发 `model` 弹出的模型选择卡片,展示 Fable 5 / Opus 4.8 / GLM / Grok / GPT-5.6 Sol 档位和"选"按钮。

> 订阅了 GLM Coding Plan 的话强烈推荐 **Claude·GLM** 档位:长会话不易丢前文,在 GLM 档位上 `hi` 控制台还会显示套餐额度和用量。

### 7.4 多分支并行开发(`wt`)
在项目主群发:
- `wt` —— 列出本项目所有 `work/*` 分支的状态。
- `wt feature-x` —— **自动创建**一个同级目录 `myapp[feature-x]` + 分支 `work/feature-x` + **同名飞书群**,你就能在新群里独立开发这个分支,和主群互不干扰。
- 卡片上的 `删` 按钮会安全解散 worktree 群并删目录(先确认没在跑任务、没未提交改动;**分支保留**)。

![图 7.4 wt 分支列表卡片](images/feishu/7.4-worktree.png)
> 📷 **待补图 7.4** ｜ 截图内容:群里发 `wt` 弹出的分支列表卡片(展示 `work/*` 各分支状态 clean/dirty/merged 和"删"按钮)。

### 7.5 任务清单自动化(`task`,预览版)
群里发 `task` → 点 `启用`,会创建一个绑定的飞书任务清单,分成 `设计中` / `[AI]待执行` / `[AI]执行中` / `[AI]待审核` / `已完成` 几个分组。后台 worker 会自动挑任务、规划、在本地分支上执行、生成审查请求,你人工确认后触发合并。适合把一批任务丢给 AI 排队处理。

![图 7.5 task 任务清单面板](images/feishu/7.5-task-panel.png)
> 📷 **待补图 7.5** ｜ 截图内容:群里发 `task` 弹出的任务清单面板卡片,以及(可选)绑定后的飞书任务清单里几个分组的样子。

### 7.6 发图片、文件、@
- **发图片/文件**:直接在群里发**真图片/文件附件**(不是发路径文字),机器人会自动下载到本地并交给 AI 处理。
- **一次性外部任务**:`agy <prompt>` 会用独立卡片跑一个外部 agy 任务。

---

## 八、配置详解(`config.toml`)

位置:`~/.config/lodestar/config.toml`(macOS/Linux)。

| 配置节 | 作用 |
| --- | --- |
| `[feishu]` | `app_id`、`app_secret`(**必填**) |
| `[runtime]` | `projects_root` 项目根目录(默认主目录) |
| `[notify]` | HTTP 通知端点:`bind`(默认 `127.0.0.1`)、`port`(默认 `9876`) |
| `[claude]` | `default_model` 新群默认档位、`bin` 自定义 claude 可执行文件等 |
| `[claude.models.<名>]` | 第三方模型路由(如 GLM) |
| `[projects.<群名>]` | 单个项目的隔离配置(高级) |

### 配置 GLM(推荐)
> ⚠️ **凭据只写这里,别写进 `~/.claude/settings.json`** —— 否则会污染 Fable 5 / Opus 登录档位,让它们也偷偷走 GLM。

```toml
[claude]
default_model = "glm"          # 新群默认走 GLM(不写则默认 Fable 5)

[claude.models.glm]
base_url   = "https://open.bigmodel.cn/api/anthropic"
auth_token = "<你的 GLM API key>"
model      = "GLM-5.2[1m]"      # [1m] 开满 1M 上下文
effort     = "xhigh"           # GLM-5.2 最高思维强度
```

### 接入 reclaude(可选,自定义 Claude 可执行文件)
[reclaude](https://docs.reclaude.ai) 用本地代理换官方分配账号。配好后:
```toml
[claude]
bin = "~/.local/bin/reclaude"
```
重启 daemon,日志出现 `executable=config-reclaude-sdk-native:…/reclaude` 即生效。

### 外部项目隔离接入(高级)
让一个不在项目根目录下的外部项目,以受限工具集和自己的 MCP 干净运行:
```toml
[projects.calculator2]
cwd                        = "/abs/path/to/calculator2"
setting_sources            = "project"
strict_mcp                 = "true"
tools                      = "Read,Write,Edit,Bash,Glob,Grep"
load_project_mcp           = "true"
```
> ⚠️ 这组字段是**联动的,配一半会把对话卡死**。若遇到卡片底部一直 `Thinking...` 且 model 显示 `<synthetic>`,先把 `[projects.*]` 整节注释掉重启排查。

---

## 九、扩展:HTTP 通知端点(本机脚本推消息到群)

daemon 启动后会在本机监听 `http://127.0.0.1:9876/notify`,任何脚本一行 `curl` 就能往群里推卡片:

```bash
# 推一条带图告警(info / warn / error 三档染色)
curl -sS -X POST http://127.0.0.1:9876/notify \
  -H 'Content-Type: application/json' \
  -d '{"project":"ops","level":"error","text":"任务卡住了,截图如下","images":["/abs/shot.png"]}'
```

还能发**带按钮的审批卡**,用户点击后 daemon 把选择 POST 回你本机的回调地址 —— 适合"部署前群里点一下批准"这种流程。对应的 `feishu-notify` 技能会在 daemon 启动时自动装好,AI 也能直接调用它给你发通知。

---

## 十、集成部署(7×24 长跑)

想让 daemon 长期在后台跑、开机自启、崩溃自动重启:

- **Linux / macOS**:用 `systemd --user` 拉起 `lodestar-daemon`。
- **macOS**:也可用 `launchd`(LaunchAgent)托管。
- **Windows**:用任务计划程序拉起。

> ♻️ **崩溃自愈 + 断线重连**:配好托管后,进程被杀会自动拉起;**重启后上次活跃的群会并发自动 `--resume` 接回上下文**,对话不丢。

---

## 十一、常见问题排查(FAQ)

| 症状 | 原因 / 解决 |
| --- | --- |
| 发消息机器人**毫无反应** | ① 应用**没发布版本**(第 5.5 步);② 缺 `im:message.group_msg` 权限(只收 @ 消息);③ 事件"订阅方式"没选**长连接**。 |
| 凭据测试**失败** | App ID / App Secret 抄错,或应用没发布上线。 |
| 机器人提示**"无法识别群名"** | 群没设名称,或群名和 `projects_root` 下的目录名对不上。 |
| 报 `401 Invalid bearer token` | 配了 reclaude 但没在 `config.toml` 写 `[claude] bin`,或 GLM/Anthropic 凭据不对。 |
| 用了 Claude **订阅登录**却跑不起来 | 订阅(Pro/Max OAuth)不支持,必须换 **API 方式**(GLM 或 Anthropic API key)。 |
| 卡片一直 `Thinking...` 且 model 显示 `<synthetic>` | `[projects.*]` 配置没配齐(如 `.mcp.json` 不存在或 MCP 起不来);先注释掉该节重启。 |
| 发图片 AI **收不到** | 要发**真图片附件**(点 + 号 / 粘贴图片),不要发图片的路径文字。 |
| 日志在哪看 | macOS/Linux:`~/.local/share/lodestar/daemon-YYYY-MM-DD.log`(按日滚动,保留近 7 天)。 |

---

## 十二、给想深入的人:项目结构与技术栈

**技术栈**:Bun(构建/测试)+ Node.js ≥ 18(运行)+ TypeScript;飞书 `@larksuiteoapi/node-sdk`;Claude `@anthropic-ai/claude-agent-sdk`;Codex `codex` CLI;`@modelcontextprotocol/sdk`;`zod`。

**核心代码结构**:

| 位置 | 职责 |
| --- | --- |
| `cli.ts` | 入口,缺配置时触发向导,否则加载 daemon |
| `daemon.ts` | 主入口:飞书长连接、事件分发、裸词命令、附件下载 |
| `src/session.ts` | 一个群一个 `Session` 状态机(核心,约 3000 行) |
| `src/agent-process.ts` | 统一的 AI 后端接口 |
| `src/claude-agent-process.ts` / `src/codex-process.ts` | Claude / Codex 两个后端实现 |
| `src/feishu.ts` | 飞书 API:消息、群管理、附件、reaction |
| `src/cardkit.ts` + `src/cards/` | 飞书卡片流式渲染 |
| `src/tasklist-worker.ts` | 任务清单自动化后台 worker |
| `src/notify.ts` | 本机 HTTP 通知服务 |
| `src/config.ts` / `src/paths.ts` | 配置读取 / 运行时路径 |
| `src/setup.ts` | 首次配置向导 |

**开发校验**:`bun test`(单元测试)+ `bun run build`(构建);涉及真实飞书交互用 `bun scripts/smoke.ts "<群名>"` 做人工 smoke。

---

## 十三、许可

[MIT](../LICENSE) · 原作者 leviyuan · 当前维护仓库 supercc168/lodestar

---

> 本说明书依据项目 `README.md`、`setup.ts`(飞书配置引导)、`config.ts`、`AGENTS.md` 及源码整理(v0.11.19)。具体行为以最新代码为准。
>
> **图片资源**:所有 `images/feishu/*.png` 为待补占位图,请按各图注说明提供截图,放入 `docs/images/feishu/` 目录即可自动显示。
