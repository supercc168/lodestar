<p align="center">
  <img src="https://raw.githubusercontent.com/leviyuan/lodestar/main/promo.jpg" alt="夜航星 Lodestar" width="100%">
</p>

# 夜航星 (Lodestar)

AI 不是帮手,是倍率。它放大的不是体力,是你——你的直觉、判断和品味,每一样都被乘以一个你以前不敢想的系数。最终走多远,取决于被放大的你有多强。

夜航星让这件事真正发生:在你思考的地方接住想法,在你转身之后继续把它推向终点。**你醒着它在听,你睡了它还在跑。**

## 你会得到什么

- 🌊 **流式卡片**:token 级渲染同一张卡,不刷屏;assistant 段、工具调用、追问全收纳在一张卡的不同面板里
- 🔧 **工具一格一面板**:折起概述、展开细节;连续 `Read` 自动合批一格;权限/审批就地三按钮
- ❓ **结构化追问**:`AskUserQuestion` 选项行 + 自由文本回答 + 多题翻页
- ⌨️ **连珠炮安全**:type-ahead 全收,排队进 ⏳ 反应,下一轮合并喂回模型,用 `<u>...</u>` 拆开独立消息
- 📊 **footer 实时指标**:`✅ ⏱时长 · 📊上下文% · 💰本轮成本`
- 📦 **`hi` 控制台**:跨群项目、上下文%、订阅额度一屏看完
- 📎 **图文双向**:`[file: /abs/path]` 进、`[[send: /abs/path]]` 出
- 📲 **关键时刻加急**:Ask / 审批 / done 走 `im:message.urgent` 锁屏推送,定时唤醒不打扰
- 🛑 **`stop` 软打断**:取消当前 turn + 清队列,子进程保活
- 🗂 **多项目并发**:一个 daemon 持 N 群 ↔ N session
- 🔄 **自动 resume**:重启后上次活跃 session 全部 `--resume`,主动 `kill` 过的不吵醒
- 🛡 **守护级稳定**:WS watchdog + 单 PID + alive marker
- 📡 **HTTP 通知端点**:任意本机进程 `POST /notify` 把 markdown 推成卡片,info / warn / error 染色
- ⏰ **定时任务**:让 Claude 自己定期跑一轮,每次 fire 起 fresh 子进程不累积上下文;silent 只推结果 / verbose 全 transcript 可切;hi 面板带删/切按钮

## 怎么用

每个飞书群对应一个 Claude 会话。**群名 = `projects_root` 下的目录名**。新群第一次发消息时 daemon 自动 `mkdir -p` + `git init`,开新群 = 开新项目。

群里发任意文字,Claude 接管这一轮,流式打字机渲染在一张卡片里。下一句话开新一轮卡片。

### 控制指令

直接发这五个**裸词**(不要斜杠,大小写不敏感),daemon 拦截、不转发给 Claude:

| 指令 | 行为 |
| --- | --- |
| `hi` | 未运行时启动;运行中弹一张**状态卡片** |
| `stop` | 软打断当前 turn + 清队列;子进程保活,排队中的消息打 ❌ |
| `kill` | 优雅关闭 Claude 进程;`sessionId` 落盘,可 `restart` 接回 |
| `restart` | 用上次 `sessionId` 重启(保留上下文);无进程时也能用 |
| `clear` | 杀进程并开新 session(等价 `/clear`);无进程时无效 |

## 安装

Windows / macOS / Linux 通吃,只要 Node ≥ 18。

### 1. 装包

```bash
npm i -g @leviyuan/lodestar
```

`@anthropic-ai/claude-code` 是 peer dep,npm 7+ 自动连带装。装完 `lodestar-daemon` / `lodestar-setup` / `claude` 三个命令进 PATH。

### 2. 飞书自建应用

去[飞书开放平台](https://open.feishu.cn/app)→ 创建企业自建应用:

1. **添加机器人能力**:左侧"添加应用能力"→"机器人"→**添加**。
2. **开通权限**(权限管理 → 开通权限):
   - 消息:`im:message:send_as_bot` `im:message` `im:chat` `im:resource` `im:message.urgent` `im:message.group_msg`(敏感,需审批) `im:message.group_at_msg:readonly`
   - 卡片:`cardkit:card:read` `cardkit:card:write`
3. **订阅事件**(事件与回调,拆两个子页):
   - **事件配置**:订阅方式选**长连接** → 保存 → 添加 `im.message.receive_v1`
   - **回调配置**:订阅方式选**长连接** → 保存 → 添加 `card.action.trigger`
4. **发布版本**:顶部 **创建版本** → 滚到底 **保存** → 弹框 **发布**。**没发版收不到任何事件**。
5. **拿凭据**:`App ID`(`cli_xxx`)和 `App Secret`,下一步要用。
6. **拉机器人进群**:群设置 → 群机器人 → 添加 → 选你的应用。**群名 = `projects_root` 下的目录名**。

### 3. 跑配置向导

```bash
lodestar-setup
```

四步走完即可:

1. **Claude CLI**:没装会自动 `npm i -g @anthropic-ai/claude-code`
2. **LLM 后端**(2 选 1):
   - **已配过**:claude.ai 订阅 / API key / 已设环境变量,直接用
   - **用 DeepSeek**(推荐,国内可用,人民币计费):粘 DeepSeek API key,向导写好 8 个 `ANTHROPIC_*` / `CLAUDE_CODE_*` 到 `[claude.env]` 节,daemon 拉起 claude 时自动注入,**不碰系统环境变量**
3. **Feishu 凭据**:粘上一步的 `App ID` / `App Secret`,向导调 `tenant_access_token` 端点验真,失败重输
4. **`projects_root`**(默认用户主目录),写盘后自动 detach 启动 daemon

配置写到:
- Linux / macOS:`~/.config/lodestar/config.toml`
- Windows:`%APPDATA%\Lodestar\config.toml`

### 4. 7×24 守护(可选)

**Linux / macOS** 用 `systemd --user`(`ExecStart` 换成你 `which lodestar-daemon` 的路径):

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

**Windows** 用 Task Scheduler 在登录时拉起 `lodestar-daemon`。

每次重启,上次还活着的 session 全部 `--resume` 自动复活;主动 `kill` 过的留在停机态。

### 配置文件

向导写出来的 TOML:

```toml
[feishu]
app_id     = "cli_xxxxxxxxxxxxxxxx"
app_secret = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

[runtime]
projects_root = "/home/you"

# 可选,daemon 拉起 claude 子进程时注入这些 env (DeepSeek / GLM / 任意 anthropic 兼容后端)
[claude.env]
ANTHROPIC_BASE_URL   = "https://api.deepseek.com/anthropic"
ANTHROPIC_AUTH_TOKEN = "sk-xxxxxxxx"
# ... 选 DeepSeek 时向导自动填全 8 个变量

# 可选,默认 127.0.0.1:9876
[notify]
bind = "127.0.0.1"
port = 9876
```

路径覆盖:`LODESTAR_CONFIG` / `LODESTAR_CONFIG_DIR` / `XDG_CONFIG_HOME` 都认。运行时状态在 Linux/Mac `~/.local/share/lodestar/` 或 Windows `%LOCALAPPDATA%\Lodestar\`(`LODESTAR_DATA_DIR` / `XDG_DATA_HOME` 可改) —— daemon.pid、daemon.log、session-chat-map、alive-marker、inbox/ 都在那里。

## 通知端点(Notify)

本机任何进程都能往群里推一张卡片 —— 不走 SDK、不走鉴权,daemon 启动时顺带跑一个 loopback HTTP listener,默认绑 `127.0.0.1:9876`。

```bash
curl -fsS -X POST http://127.0.0.1:9876/notify \
  -H 'content-type: application/json' \
  -d '{"project":"feishu","text":"**build done** 12 files"}'
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `project` | ✅ | 飞书群名(= session 名 = 项目目录名)|
| `text` | ✅ | Feishu schema-2.0 markdown:`**bold**`、`` `code` ``、`[link](url)`、`<font color='red'>…</font>`;~30 KB 上限 |
| `title` |   | 卡片 header,默认等于 `project` |
| `level` |   | `info`(蓝,默认)/ `warn`(黄)/ `error`(红)|

响应:`200 {ok, chat_id, message_id}` / `400` 参数错 / `404` 群没绑定过 / `502` 飞书 API 拒收。

> ⚠️ 群必须**至少有一条消息**触达过 daemon(WS 收到过),否则 404。新建群第一次发消息后即可用。

cron / systemd hook 用法:

```cron
0 3 * * * /usr/local/bin/backup.sh \
  && curl -fsS -X POST http://127.0.0.1:9876/notify -H 'content-type: application/json' \
       -d '{"project":"ops","text":"✅ nightly backup OK"}' \
  || curl -fsS -X POST http://127.0.0.1:9876/notify -H 'content-type: application/json' \
       -d '{"project":"ops","level":"error","text":"❌ nightly backup FAILED"}'
```

> 想让 Claude Code 自己说一句 "build 完通知我" 就推送 —— daemon 启动时**自动同步** `~/.claude/skills/feishu-notify/SKILL.md`,主端 Claude 立即就能用关键词触发(`LODESTAR_DISABLE_SKILL_SYNC=1` 关闭自动同步)。

## 定时任务(Schedule)

让 Claude **自己**定期跑一轮 —— 比上面 cron-curl 推卡片有用一个量级:每次 fire 起一个**全新的 Claude 子进程**(无 `--resume`、fresh `sessionId`、`bypassPermissions`、cwd = 项目目录),让它读最新的 git 状态 / 日志文件 / API,自己分析,然后把结果按你定义的格式贴回群里。

**怎么加**:在群里跟 Claude 说"以后每天早上 9 点 silent 给我总结昨天的 PR"就行 —— claude 会调 MCP 工具 `schedule_create` 落到 daemon 的 `schedules.json`。

| 工具 | 用途 |
| --- | --- |
| `schedule_create` | cron 周期(标准 5 段 `m h dom mon dow`,支持 `*` `*/N` `a,b,c` `a-b`) |
| `schedule_once` | 一次性延时(对齐内置 `ScheduleWakeup` 语义) |
| `schedule_list` | 当前项目所有 schedule |
| `schedule_delete` | 按 id 删除 |

MCP 工具是 daemon spawn claude 时通过 `--mcp-config` 注入的 —— **不用碰 `~/.claude.json`**;每个群独立 URL path `/mcp/<project>` 钉死项目,跨群零泄漏。

**两种 fire 输出**:

| 模式 | 输出 | 适用 |
| --- | --- | --- |
| `silent`(默认) | 只把最终 assistant text 推一张 notify 风格卡 | 每日报告、状态摘要、不打扰 |
| `verbose` | 完整 transcript:prompt 折叠 + assistant 段 + 工具调用 panel(input + output)+ 耗时/token footer | 偶尔检查任务跑得对不对 |

**`hi` 面板**:任意群发 `hi`,**⏰ 定时任务** 段列出 daemon 名下所有 schedule(跨项目全局 dashboard),每条带 `📁 项目` + `🔕silent` / `📜verbose` + 下次触发时间,展开看完整 prompt + cron + 上次触发,两个按钮 **切换 mode** / **🗑 删除** 走 `update_multi` 原地刷新当前卡。

**对比 SDK 自带的 `ScheduleWakeup` / `CronCreate`**:daemon 这一层补三件事 —— 持久化(daemon 重启不丢)、每次 fire 干净进程(不累积上下文)、跨项目可见(hi 面板)。

## 许可

[MIT](LICENSE)
