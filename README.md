<p align="center">
  <img src="https://raw.githubusercontent.com/leviyuan/lodestar/main/promo.jpg" alt="夜航星 Lodestar" width="100%">
</p>

# 夜航星 (Lodestar)

夜航星把飞书群变成 Claude Code 的远程终端:一个群对应一个项目目录,你在群里发消息,Claude 就在那个目录里读代码、改文件、跑命令。

人离开电脑也不耽误 —— 手机上看它干活、随时插话,关掉飞书它照样在后台接着跑。

---

## 功能

<table>
<tr>
<td width="50%" valign="top">

**🌊 流式打字机**

回复在同一张卡片上逐字刷新,不会刷出一长串新消息。

</td>
<td width="50%" valign="top">

**🔧 工具调用逐步可见**

每次调用单独一个折叠面板,需要授权时直接在卡片上点按钮。

</td>
</tr>
<tr>
<td valign="top">

**💬 能反问也能插话**

Claude 会反问,你也能中途打断,没处理完的消息自动排到下一轮。

</td>
<td valign="top">

**📊 这一轮花了多少**

耗时、上下文用量、对应花费,都显示在卡片底部。

</td>
</tr>
<tr>
<td valign="top">

**📦 一屏看完所有项目**

发个 `hi`,跨群、跨项目的状态收进一张卡片。

</td>
<td valign="top">

**🛡 重启不丢上下文**

多个项目并发跑,daemon 重启后自动接回上次会话,关键节点推送到锁屏。

</td>
</tr>
</table>

---

## 🚀 用起来

跨平台 (Windows / macOS / Linux),Node ≥ 18。

**1. 装包**

```bash
npm i -g @leviyuan/lodestar
```

装完得到 4 个命令:

| 命令 | 作用 |
| --- | --- |
| `lodestar-setup` | 首次配置向导 |
| `lodestar-daemon` | 启动 daemon |
| `lodestar-stop` | 停止 daemon |
| `lodestar-update` | 升级到最新版(含 Claude CLI)|

**2. 跑向导**

```bash
lodestar-setup
```

手把手带你装 claude、配 API、建飞书应用、启动 lodestar。

**3. 拉机器人进群**

群名 = `projects_root` 下的目录名(没建会自动建)。发条消息,Claude 接管。

群里发这五个**裸词**(不要斜杠,大小写不敏感)可以控 daemon:

| 指令 | 行为 |
| --- | --- |
| `hi` | 未运行时启动;运行中弹一张状态卡片 |
| `stop` | 软打断当前 turn,子进程保活,排队消息打 ❌ |
| `kill` | 优雅关闭 Claude 进程,`sessionId` 落盘 |
| `restart` | 用上次 `sessionId` 重启(保留上下文)|
| `clear` | 杀进程并开新 session(等价 `/clear`)|

---

## 🎁 附加能力

### 🔔 HTTP 通知端点

本机任何脚本一行 curl 就能往群里推一张 markdown 卡片(info / warn / error 三档染色):

```bash
curl -X POST http://127.0.0.1:9876/notify \
  -d '{"project":"xxx","text":"build done"}'
```

### ⏰ 定时任务

在群里跟 Claude 说"每天早上 9 点总结昨天 PR",它自己排好。每次 fire 起一个干净的 Claude 子进程跑,不累上下文,silent / verbose 二选一,`hi` 面板带删/切按钮。

---

> [!TIP]
> 想 7×24 长跑,用 `systemd --user`(Linux/macOS)或 Windows 任务计划程序拉起 `lodestar-daemon`。重启后上次活跃的 session 会自动 `--resume` 接回。

---

## 📄 许可

[MIT](LICENSE)
