<p align="center">
  <img src="https://raw.githubusercontent.com/leviyuan/lodestar/main/promo.jpg" alt="夜航星 Lodestar" width="100%">
</p>

# 夜航星 (Lodestar)

**在你最熟悉的飞书群里，开一段不熄灯的 Claude Code 会话。**

## 项目哲学

AI 不是帮手，是倍率。它放大的不是体力，是你——你的直觉、判断和品味，每一样都被乘以一个你以前不敢想的系数。最终走多远，取决于被放大的你有多强。

夜航星让这件事真正发生：在你思考的地方接住想法，在你转身之后继续把它推向终点。一个群，一个项目，一段不熄灯的对话。你醒着它在听，你睡了它还在跑。

## 怎么用

每个飞书群对应一个 Claude 会话。**群名 = `~/` 下的项目目录名**。

- 在群里发任意文字 — Claude 接管这一轮，回复以**流式打字机**实时渲染在一张飞书卡片里。
- 思考过程、每一次工具调用都在卡片里被收纳为**可展开折叠面板**：折起来是概述，展开是详情。你随时能审阅它在做什么。
- 需要授权的操作（执行命令、修改文件……）会单独弹一张橙色**权限卡片**，你在群里点 `允许` / `始终允许` / `拒绝` 就行。
- **图片、文件双向互传**：用户发到群里的图/文件，Claude 通过消息里的 `[file: /abs/path]` 提示就能读；Claude 想把文件发回来，在回复任意位置写 `[[send: /abs/path]]`，标记会被剥离，文件以独立消息出现在群里。出站路径限制在该会话的工作目录、`/tmp/lodestar-*` 与 inbox 之内，`/etc`、`~/.ssh`、`~/.config` 等敏感目录被白名单拒绝。
- 一轮跑完，卡片合上、可转发；下一句话开新一轮。

### 文本控制指令

直接发这四个**裸词**（不需要斜杠，不区分大小写），daemon 拦截、不转发给 Claude：

| 指令 | 行为 |
| --- | --- |
| `hi` | 未运行时启动；运行中弹一张**控制台卡片**（状态行 + 中断/clear/终止/ls 按钮） |
| `kill` | 优雅关闭 Claude 进程；记住 `sessionId`，下次 `restart` 还能 resume |
| `restart` | 用上一次的 `sessionId` 重启会话（保留上下文） |
| `clear` | 杀掉进程并启动一个全新 session（等价于 Claude Code 的 `/clear`） |

> 这四个词被全局保留：在群里发 "hi" 当问候也会触发控制台卡片，不会到 Claude 那边。换来的是手机上单手打字的便利。

整个对话在群里、在手机上、在桌面上完整发生。**离开终端，但不离开 Claude Code。**

## 安装

### 1. 准备

- 一台能常跑后台进程的机器（自家服务器或闲置主机）
- [Bun](https://bun.sh) 运行时
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 已登录 Anthropic 账号 (`claude auth login`)
- 一个飞书自建应用 (`cli_xxx`)，开通：
  - `im:message:send_as_bot` / `im:message` / `im:chat:readonly` / `im:resource`
  - `cardkit:card:read` `cardkit:card:write`
    `cardkit:card.element:read` `cardkit:card.element:write`
    `cardkit:card.settings:read` `cardkit:card.settings:write`

### 2. 配置

把凭据写到 `~/.config/lodestar/config.toml`：

```toml
[feishu]
app_id     = "cli_xxxxxxxxxxxxxxxx"
app_secret = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

[runtime]
projects_root = "~/"        # 可选，新建群对应的项目目录会落到这里
```

也支持 `LODESTAR_CONFIG=/abs/path.toml` 或 `XDG_CONFIG_HOME` 覆盖。

### 3. 启动

```bash
git clone https://github.com/leviyuan/lodestar.git ~/lodestar
cd ~/lodestar
bun install
bun daemon.ts
```

把机器人拉进任意飞书群，发一条消息——Claude 就上线了。

> **小贴士**：群名首次出现时，daemon 会自动在 `~/{群名}/` 创建项目目录并 `git init`。换句话说，开新群 = 开新项目。

### 4. 守护进程（可选）

要让 daemon 7×24 跑，最简单的方法是配一个 `systemd --user` 单元：

```ini
[Unit]
Description=Lodestar daemon
After=network-online.target

[Service]
Type=simple
ExecStart=/home/USER/.bun/bin/bun /home/USER/lodestar/daemon.ts
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

`systemctl --user enable --now lodestar`。

## 许可

[MIT](LICENSE)
