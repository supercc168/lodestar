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

- 🌊 **真·流式卡片** — 飞书 Card Kit v1 streaming,Claude 一个 token 一个 token 地打在同一张卡片里,不是发一堆零碎消息刷屏。
- 🧠 **思考过程透明** — `thinking` 流式渲染,turn 结束后自动收起为可展开面板。每次工具调用也是一格折叠面板:折起是概述,展开看完整 input/output。
- 🔐 **权限审批就地完成** — 需要授权的工具调用,**原地**升级为 🔐 等审批状态,三颗按钮 `允许 / 始终允许 / 拒绝` 直接嵌在面板里。不弹独立卡片,不破坏时序。点完按钮,后续 output 接在同一条线上继续往下走。
- ❓ **结构化追问** — Claude 的 `AskUserQuestion` 在群里呈现为可点击选项行;不满意?直接在群里**打字回答**,daemon 会把自由文本当作 custom answer 发回去。多题串行,有进度计数和"已答 N 题"折叠历史。
- 📦 **状态面板一键唤出** — 发 `hi` 弹一张控制台:model、上下文占用 %、累计 tokens/cost、上一轮 delta、session id、订阅额度(5h / 7d 真实 utilization,直读 Anthropic 官方 OAuth Usage API,凭据走 `~/.claude/.credentials.json`,token 过期自动 refresh)、本机所有活跃项目并列展示。
- 📎 **图片 / 文件双向互传** — 用户在群里发图/文件,Claude 通过消息里的 `[file: /abs/path]` 提示就能读;Claude 在回复里写 `[[send: /abs/path]]`,标记被剥离,文件以独立消息发回群里。出站路径走 realpath + 白名单校验,只允许工作目录、`/tmp/lodestar-*`、inbox 三块,`/etc`、`~/.ssh`、`~/.config` 即使被符号链接绕也拒绝。
- 📲 **加急锁屏推送** — 需要你回答问题、需要你批准操作、一轮跑完了——三种关键时刻自动触发飞书"应用内加急",直接打穿勿扰、亮屏推送。卡片摘要会同步改写成具体待办("🔐 等审批: Bash · rm -rf …"、"❓ 待回答 3 题: …"),锁屏一瞥就知道发生了什么。
- 🗂 **多项目并发** — 一个 daemon 同时持有 N 个飞书群 ↔ N 个 Claude session。状态面板能跨群看到所有活跃项目和它们的 uptime,在群 A 里就能查群 B 在干嘛。
- 🔄 **不丢上下文** — 每次 `system/init` 落盘 SDK session_id;daemon 被 systemd 重启、机器断电、手抖 kill 进程,下次 `restart` 或自动复活都 `--resume` 到同一段对话,Claude 不知道你离开过。
- 🛡 **后台守护级稳定性** — 单 PID 锁、WS pong watchdog(180s 无心跳自杀,交给 systemd 拉起)、5s 重投 stale 消息丢弃、200 条 message_id 去重、SIGTERM 优雅写盘、`alive marker` 区分"我自己挂的"和"被用户主动 kill 的"——后者不会被复活。

## 怎么用

每个飞书群对应一个 Claude 会话。**群名 = `~/` 下的项目目录名**。这套绑定是骨架,新群第一次发消息时,daemon 会自动 `mkdir -p ~/{群名}` + `git init` 把项目骨架打起来,**开新群 = 开新项目**。

在群里发任意文字,Claude 接管这一轮。回复以流式打字机渲染在一张卡片里,工具调用、思考过程、权限审批、追问选项,全都收纳在这张卡片的不同面板里——一目了然,可转发,可回看。

下一句话开新一轮卡片。

### 文本控制指令

直接发这四个**裸词**(不需要斜杠,不区分大小写),daemon 拦截、不转发给 Claude:

| 指令 | 行为 |
| --- | --- |
| `hi` | 未运行时启动;运行中弹一张**状态卡片** |
| `kill` | 优雅关闭 Claude 进程;记住 `sessionId`,下次 `restart` 还能 resume |
| `restart` | 用上一次的 `sessionId` 重启会话(保留上下文) |
| `clear` | 杀掉进程并启动一个全新 session(等价于 Claude Code 的 `/clear`) |

> 这四个词被全局保留:在群里发 "hi" 当问候也会触发控制台卡片,不会到 Claude 那边。换来的是手机上单手打字的便利。

## 安装

### 1. 准备

- 一台能常跑后台进程的机器(自家服务器、闲置 NAS、树莓派均可)
- [Bun](https://bun.sh) 运行时(≥ 1.0)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 装好且能跑(怎么认证、走官方账号还是第三方网关,你自己看着办)
- 一个飞书自建应用 (`cli_xxx`),开通:
  - `im:message:send_as_bot` / `im:message` / `im:chat:readonly` / `im:resource`
  - `im:message.urgent`(加急推送)
  - `cardkit:card:read` `cardkit:card:write`
    `cardkit:card.element:read` `cardkit:card.element:write`
    `cardkit:card.settings:read` `cardkit:card.settings:write`

### 2. 配置

把凭据写到 `~/.config/lodestar/config.toml`:

```toml
[feishu]
app_id     = "cli_xxxxxxxxxxxxxxxx"
app_secret = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

[runtime]
projects_root = "~/"        # 可选,新建群对应的项目目录会落到这里
```

也支持 `LODESTAR_CONFIG=/abs/path.toml` 或 `XDG_CONFIG_HOME` 覆盖。运行时状态走 `~/.local/share/lodestar/`(可用 `LODESTAR_DATA_DIR` 或 `XDG_DATA_HOME` 改写)——daemon.pid、daemon.log、session-chat-map、session-resume-map、alive-marker、inbox/ 都在那里。

### 3. 启动

```bash
bun install -g @leviyuan/lodestar
lodestar-daemon
```

或者一次性跑(无需全局安装):

```bash
bunx @leviyuan/lodestar
```

把机器人拉进任意飞书群,发一条消息——Claude 就上线了。

### 4. 守护进程(推荐)

让 daemon 7×24 跑,最简单的方法是配一个 `systemd --user` 单元:

```ini
[Unit]
Description=Lodestar daemon
After=network-online.target

[Service]
Type=simple
ExecStart=/home/USER/.bun/bin/lodestar-daemon
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now lodestar
```

WS watchdog + alive-marker 的联手设计,意味着每次 systemd 拉起,daemon 会把**上次还在运行的 session 全部 `--resume` 自动复活**;你主动 `kill` 过的不会被吵醒。

## 许可

[MIT](LICENSE)
