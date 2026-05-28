<p align="center">
  <img src="https://raw.githubusercontent.com/leviyuan/lodestar/main/promo.jpg" alt="夜航星 Lodestar" width="100%">
</p>

# 夜航星 (Lodestar)

AI 不是帮手,是倍率。它放大的不是体力,是你 —— 你的直觉、判断和品味,每一样都被乘以一个你以前不敢想的系数。

夜航星让这件事真正发生:在你思考的地方接住想法,在你转身之后继续推向终点。

`您赛博办公的最佳实践`

---

## 🚀 用起来

跨平台 (Windows / macOS / Linux),npm 全局安装后由 Node.js 运行,需要 Node.js ≥ 18；Bun 只用于源码开发和发布构建。

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
| `lodestar-update` | 升级到最新版(含 Codex CLI)|
| `lodestar-version` | 查看 Lodestar 和 Codex CLI 版本 |

**2. 跑向导**

```bash
lodestar-setup
```

手把手带你装 Codex、登录 ChatGPT、建飞书应用、启动 lodestar。

**3. 拉机器人进群**

群名 = `projects_root` 下的目录名(没建会自动建)。发条消息,Codex 接管。

群里发这五个**裸词**(不要斜杠,大小写不敏感)可以控 daemon:

| 指令 | 行为 |
| --- | --- |
| `hi` | 未运行时同一张卡动态启动并收束为控制台;运行中弹控制台 |
| `stop` | 软打断当前 turn,子进程保活,排队消息打 ❌ |
| `kill` | 用状态卡展示关闭 Codex 进程,`threadId` 落盘 |
| `restart` | 用状态卡展示按上次 `threadId` 重启(保留上下文)|
| `clear` | 用状态卡展示杀进程并开新 thread(等价 `/clear`)|

---

## 🎁 附加能力

### 🔔 HTTP 通知端点

本机任何脚本一行 curl 就能往群里推一张 markdown 卡片(info / warn / error 三档染色):

```bash
curl -X POST http://127.0.0.1:9876/notify \
  -d '{"project":"xxx","text":"build done"}'
```

---

> [!TIP]
> 想 7×24 长跑,用 `systemd --user`(Linux/macOS)或 Windows 任务计划程序拉起 `lodestar-daemon`。重启后上次活跃的 session 会自动 `--resume` 接回。

---

## 📄 许可

[MIT](LICENSE)
