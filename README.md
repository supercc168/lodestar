<p align="center">
  <img src="https://raw.githubusercontent.com/leviyuan/lodestar/main/promo.jpg" alt="夜航星 Lodestar" width="100%">
</p>

# 夜航星 (Lodestar)

> **你醒着它在听,你睡了它还在跑。**

AI 不是帮手,是倍率。它放大的不是体力,是你 —— 你的直觉、判断和品味,每一样都被乘以一个你以前不敢想的系数。

夜航星让这件事真正发生:在你思考的地方接住想法,在你转身之后继续推向终点。

---

## ✨ 你会得到什么

<table>
<tr>
<td width="50%" valign="top">

**🌊 流式打字机**

同一张卡片 token 级渲染,不刷屏。

</td>
<td width="50%" valign="top">

**🔧 工具调用一格一面板**

每步折叠、审批就地三按钮。

</td>
</tr>
<tr>
<td valign="top">

**💬 自然双向对话**

它能反问、你能抢话,自动排队进下轮。

</td>
<td valign="top">

**📊 本轮成本一眼看清**

时长 / 上下文 / 价钱卡底直显。

</td>
</tr>
<tr>
<td valign="top">

**📦 一张卡管所有项目**

`hi` 跨群跨项目一屏总览。

</td>
<td valign="top">

**🛡 跑得稳、续得上**

多项目并发、重启自动接回、关键时刻锁屏推送。

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

**2. 飞书自建应用**

去[飞书开放平台](https://open.feishu.cn/app)创建企业自建应用 → 添加机器人 → 开权限 + 订阅长连接事件 → 发布版本 → 拿到 `App ID` 和 `App Secret`。

详细清单 `lodestar-setup` 向导会一步步念给你听,跟着粘就行。

**3. 跑向导**

```bash
lodestar-setup
```

装好 claude CLI、配 LLM 后端(订阅 / API key / DeepSeek 三选一)、验飞书凭据,然后自动起 daemon。

**4. 拉机器人进群**

群名 = `projects_root` 下的目录名(没建会自动建)。发条消息,Claude 接管。

---

## 🎛 控制指令

群里直接发这五个**裸词**(不要斜杠,大小写不敏感)控 daemon:

| 指令 | 行为 |
| --- | --- |
| `hi` | 未运行时启动;运行中弹一张状态卡片 |
| `stop` | 软打断当前 turn,子进程保活,排队消息打 ❌ |
| `kill` | 优雅关闭 Claude 进程,`sessionId` 落盘 |
| `restart` | 用上次 `sessionId` 重启(保留上下文)|
| `clear` | 杀进程并开新 session(等价 `/clear`)|

---

## 📦 命令

| 命令 | 作用 |
| --- | --- |
| `lodestar-setup` | 首次配置向导 |
| `lodestar-daemon` | 启动 daemon |
| `lodestar-stop` | 停止 daemon |
| `lodestar-update` | 升级到最新版(含 Claude CLI)|

想 7×24 长跑,用 `systemd --user`(Linux/macOS)或 Windows 任务计划程序拉起 `lodestar-daemon`。重启后上次活跃的 session 会自动 `--resume` 接回。

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

## 📄 许可

[MIT](LICENSE)
