<p align="center">
  <img src="https://raw.githubusercontent.com/leviyuan/lodestar/main/promo.jpg" alt="夜航星 Lodestar" width="100%">
</p>

# 夜航星 (Lodestar)

**把 Claude Code 装进你的飞书群。一个群 = 一个项目 = 一段不熄灯的对话。**

离开终端,但不离开 Claude Code。手机上、地铁里、半夜的床上,你只要拇指能点字,Claude 就在另一头跑着。

## 它为什么存在

AI 不是帮手,是倍率。它放大的不是体力,是你——你的直觉、判断和品味,每一样都被乘以一个你以前不敢想的系数。最终走多远,取决于被放大的你有多强。

夜航星让这件事真正发生:在你思考的地方接住想法,在你转身之后继续把它推向终点。**你醒着它在听,你睡了它还在跑。**

## 你会得到什么

- 🌊 **真·流式卡片**:token 级渲染同一张卡,不刷屏
- 🧠 **思考透明**:thinking 流式 + turn 后自动收起
- 🔧 **工具调用折叠**:每次工具一格面板,折起概述/展开细节
- 🔐 **审批就地完成**:工具卡上三按钮,不破坏时序
- ❓ **结构化追问**:Ask 选项行 + 自由文本回答 + 多题翻页
- ⌨️ **Type-ahead 不打断**:连珠炮全收,排队下一轮合并处理
- 🔢 **合并消息加序号**:`[#N]\n` 前缀让模型看清独立边界
- ⏳ **排队反应可见**:消息进队列加 ⏳,消化/取消自动清/换 ❌
- ⏰ **定时唤醒可见化**:Cron / ScheduleWakeup 到点自开新卡
- 📊 **footer 实时指标**:`✅ ⏱时长 · 📊上下文% · 💰本轮成本`
- 📦 **`hi` 弹控制台**:跨群项目、上下文%、订阅额度一屏看完
- 📎 **图文双向互传**:`[file:]` 进、`[[send:]]` 出,路径白名单
- 📲 **关键时刻加急**:Ask / 审批 / done 锁屏推送,定时不打扰
- 🛑 **`stop` 软打断**:取消当前 turn + 清队列,子进程保活
- 🗂 **多项目并发**:一个 daemon 持 N 群 ↔ N session
- 🔄 **自动 resume**:重启自动续接,session_id 落盘不丢
- 🛡 **守护级稳定**:WS watchdog + 单 PID + alive marker(自动 resume 上次活跃 session)
- 📡 **HTTP 通知端点**:任意本机进程 `POST /notify` 一行 curl 把 markdown 推成卡片,info / warn / error 染色

## 怎么用

每个飞书群对应一个 Claude 会话。**群名 = 用户主目录下的项目目录名**(`projects_root` 配置项可改)。这套绑定是骨架,新群第一次发消息时,daemon 会自动 `mkdir -p <projects_root>/<群名>` + `git init` 把项目骨架打起来,**开新群 = 开新项目**。

在群里发任意文字,Claude 接管这一轮。回复以流式打字机渲染在一张卡片里,工具调用、思考过程、权限审批、追问选项,全都收纳在这张卡片的不同面板里——一目了然,可转发,可回看。

下一句话开新一轮卡片。

### 文本控制指令

直接发这四个**裸词**(不需要斜杠,不区分大小写),daemon 拦截、不转发给 Claude:

| 指令 | 行为 |
| --- | --- |
| `hi` | 未运行时启动;运行中弹一张**状态卡片** |
| `stop` | 软打断当前 turn + 清空 type-ahead 排队;子进程保活,刚排队中的消息会被打 `CrossMark` 反应表示取消 |
| `kill` | 优雅关闭 Claude 进程;`sessionId` 仍记在磁盘,下次 `restart` 还能 resume |
| `restart` | 用上一次的 `sessionId` 重启会话(保留上下文);无进程时也能用,等于"恢复上一会话" |
| `clear` | 杀掉当前进程并启动一个全新 session(等价于 Claude Code 的 `/clear`);**无进程时无效** |

> 这五个词被全局保留:在群里发 "hi" 当问候也会触发控制台卡片,不会到 Claude 那边。换来的是手机上单手打字的便利。

## 安装

Windows / macOS / Linux 通吃,只要有 Node ≥ 18。

### 1. 装包

```bash
npm i -g @leviyuan/lodestar
```

`@anthropic-ai/claude-code` 是 peer dep,npm 7+ 会自动连带装,装完终端里 `lodestar-daemon`、`lodestar-setup`、`claude` 三个命令都在 PATH 上。

> **Windows**:[nodejs.org](https://nodejs.org) 下 LTS MSI 装好 Node,然后开 cmd / PowerShell 跑上面那行。
> **没装过 Bun 也行**,这个包发布出去就是纯 Node 跑的。

### 2. 飞书自建应用

去[飞书开放平台](https://open.feishu.cn/app)→ 创建企业自建应用,然后:

1. **添加机器人能力**:左侧"添加应用能力"→"机器人"→ 点 **添加** 按钮。
2. **开通权限**(权限管理 → **开通权限**):
   - 消息:`im:message:send_as_bot` `im:message` `im:chat:readonly` `im:resource` `im:message.urgent`
   - 卡片:`cardkit:card:read` `cardkit:card:write`
3. **订阅事件**(事件与回调,拆两个子页):
   - **事件配置** 页:订阅方式选 **长连接** → 保存 → 添加事件 `im.message.receive_v1`(收群消息)
   - **回调配置** 页:订阅方式选 **长连接** → 保存 → 添加事件 `card.action.trigger`(卡片按钮回调)
4. **发布版本**:页面顶部 **创建版本** → 滚到底点 **保存** → 弹框点 **发布**。**没发版的应用不会收到事件**,这一步常被忘记。
5. **拿凭据**:凭据与基础信息页拷 `App ID`(`cli_xxxxxxxxxx`)和 `App Secret`,下一步配置向导会问你。
6. **拉机器人进群**:想用的飞书群 → 群设置 → 群机器人 → 添加机器人 → 选你的应用。**群名要等于用户主目录下的项目目录名**,daemon 用这个绑定群 ↔ Claude session。

### 3. 跑配置向导

```bash
lodestar-setup
```

交互式问你 3 件事:

1. 上一步拿到的 `App ID` / `App Secret`
2. **LLM 后端**(4 选 1):
   - **Anthropic 官方**:`claude.ai` 订阅或 API key,美元结算
   - **GLM 智谱 coding plan**:国内可访问,人民币计费,跟 Claude Code 协议原生兼容
   - **DeepSeek + anthropic-proxy**:最便宜,需要自己跑一个 proxy 转协议
   - **自定义 `base_url`**:高级
3. `projects_root`(默认是用户主目录)

写到:
- Linux / macOS:`~/.config/lodestar/config.toml`
- Windows:`%APPDATA%\Lodestar\config.toml`

设了 LLM 后端的话,daemon 拉起 claude 子进程时会自动注入 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` —— **不用碰系统环境变量**。

> 想跳过向导手写配置也行,schema 见[配置文件](#配置文件)章节。

### 4. 启动

```bash
lodestar-daemon
```

把机器人拉进任意飞书群,发一条消息 —— Claude 上线。

### 5. 7×24 守护(可选)

**Linux / macOS** 用 `systemd --user`(把 `ExecStart` 路径换成你 `which lodestar-daemon` 的结果):

```ini
[Unit]
Description=Lodestar daemon
After=network-online.target

[Service]
Type=simple
ExecStart=%h/.npm-global/bin/lodestar-daemon
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now lodestar
```

**Windows** 用 Task Scheduler 设登录时拉起 `lodestar-daemon`;或者干脆开一个 cmd / PowerShell 窗口让它一直挂着(关窗就停)。

WS watchdog + alive-marker 联手:每次重启,daemon 会把**上次还在运行的 session 全部 `--resume` 自动复活**;你主动 `kill` 过的不会被吵醒。

### 配置文件

向导写出来的 TOML 长这样:

```toml
[feishu]
app_id     = "cli_xxxxxxxxxxxxxxxx"
app_secret = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

[runtime]
projects_root = "/home/you"

[claude]                                    # 可选,留空则走 claude 自带登录
base_url   = "https://open.bigmodel.cn/api/anthropic"
auth_token = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

[notify]                                    # 可选,默认 127.0.0.1:9876
bind = "127.0.0.1"
port = 9876
```

路径覆盖:`LODESTAR_CONFIG=/abs/path.toml`、`LODESTAR_CONFIG_DIR=...`、`XDG_CONFIG_HOME` 都认。运行时状态走 Linux/Mac `~/.local/share/lodestar/` 或 Windows `%LOCALAPPDATA%\Lodestar\`(`LODESTAR_DATA_DIR` / `XDG_DATA_HOME` 可改写) —— daemon.pid、daemon.log、session-chat-map、session-resume-map、alive-marker、inbox/ 都在那里。

## 通知端点(Notify)

本机任何进程都能往群里推一张卡片 —— 不走 SDK、不走鉴权,daemon 启动时
顺带跑一个 loopback HTTP listener,默认绑 `127.0.0.1:9876`。

```bash
curl -fsS -X POST http://127.0.0.1:9876/notify \
  -H 'content-type: application/json' \
  -d '{"project":"feishu","text":"**build done** 12 files"}'
```

请求体:

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `project` | ✅ | 飞书群名(= session 名 = `~/` 下的项目目录名)|
| `text` | ✅ | Feishu schema-2.0 markdown:`**bold**`、`` `code` ``、`[link](url)`、`<font color='red'>…</font>`;~30 KB 上限,超限返回 502 |
| `title` |   | 卡片 header 标题,默认等于 `project` |
| `level` |   | `info`(默认,蓝)/ `warn`(黄)/ `error`(红)|

响应:`200 {ok, chat_id, message_id}` / `400` 参数错 / `404` 群没绑定过 / `502` 飞书 API 拒收。

> ⚠️ 群必须**至少有一条消息**触达过 daemon(WS 收到过),否则 `chatIdForSession` 查不到绑定,返回 404。新建群第一次发消息后即可用。

可选配置(Linux/Mac `~/.config/lodestar/config.toml`;Windows `%APPDATA%\Lodestar\config.toml`):

```toml
[notify]
bind = "127.0.0.1"      # 默认 loopback;改 0.0.0.0 必须自己加前置鉴权
port = 9876
```

cron / systemd hook 的常见用法:

```cron
0 3 * * * /usr/local/bin/backup.sh \
  && curl -fsS -X POST http://127.0.0.1:9876/notify -H 'content-type: application/json' \
       -d '{"project":"ops","text":"✅ nightly backup OK"}' \
  || curl -fsS -X POST http://127.0.0.1:9876/notify -H 'content-type: application/json' \
       -d '{"project":"ops","level":"error","text":"❌ nightly backup FAILED"}'
```

> 想让 Claude Code 自动调这个 endpoint(说一句"build 完通知我"就自己推),
> 建议你自己写一个 skill —— 在 `~/.claude/skills/feishu-notify/SKILL.md`
> 放一个 frontmatter + 触发关键词,把上面这段 curl 的 shape 抄进去即可。
> 项目本身不附带 skill 文件,要不要装、装成什么样,完全交给你。

## 许可

[MIT](LICENSE)
