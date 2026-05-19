<p align="center">
  <img src="https://raw.githubusercontent.com/leviyuan/lodestar/main/promo.jpg" alt="夜航星 Lodestar" width="100%">
</p>

# 夜航星 (Lodestar)

AI 不是帮手,是倍率。它放大的不是体力,是你 —— 你的直觉、判断和品味,每一样都被乘以一个你以前不敢想的系数。最终走多远,取决于被放大的你有多强。

夜航星让这件事真正发生:在你思考的地方接住想法,在你转身之后继续把它推向终点。**你醒着它在听,你睡了它还在跑。**

## 你会得到什么

- 🌊 **像打字机一样把答案推到你眼前**
- 🔧 **每个工具调用都自动归档,展开就看,不展开不挡路**
- ❓ **它能反问你,你可以选,也可以自由回答**
- ⌨️ **你抢着说话不会打断它,新想法自动接力进下一轮**
- 📊 **这一轮花了多少时间、多少钱,卡片底部一眼看清**
- 📦 **所有项目所有群,一条 `hi` 全在一张卡里**
- 📎 **图片随手丢进群、文件随手从群里拎出来**
- 📲 **该叫醒你的时候锁屏推送,不该吵你的时候安静**
- 🛑 **想停就停,进程不掉,上下文还在**
- 🗂 **同时挂 N 个项目,互不串扰**
- 🔄 **意外重启,上一秒的对话原样接回**
- 🛡 **守得住的稳定 —— 它替你扛 WebSocket 抖动、宕机自愈**

## 用起来

跨平台 (Windows / macOS / Linux),Node ≥ 18。

```bash
npm i -g @leviyuan/lodestar
```

去[飞书开放平台](https://open.feishu.cn/app) 创建企业自建应用 → 添加机器人 → 开权限 + 订阅长连接事件 → 发布版本 → 拿到 `App ID` 和 `App Secret`。详细清单 `lodestar-setup` 会一步步念给你听。

```bash
lodestar-setup
```

向导会装好 claude CLI、配 LLM 后端 (订阅 / API key / DeepSeek 三选一)、验飞书凭据,然后自动起 daemon。把机器人拉进飞书群,群名 = `projects_root` 下的目录名(没建会自动建),发条消息 Claude 就接管这一轮。

群里直接发这五个**裸词**(不要斜杠,大小写不敏感)控 daemon:

| 指令 | 行为 |
| --- | --- |
| `hi` | 未运行时启动;运行中弹一张状态卡片 |
| `stop` | 软打断当前 turn,子进程保活,排队消息打 ❌ |
| `kill` | 优雅关闭 Claude 进程,`sessionId` 落盘 |
| `restart` | 用上次 `sessionId` 重启 (保留上下文) |
| `clear` | 杀进程并开新 session(等价 `/clear`) |

## 命令

| 命令 | 作用 |
| --- | --- |
| `lodestar-setup` | 首次配置向导 |
| `lodestar-daemon` | 启动 daemon |
| `lodestar-stop` | 停止 daemon |
| `lodestar-update` | 升级到最新版 (含 Claude CLI) |

想 7×24 长跑,用 `systemd --user`(Linux/macOS)或 Windows 任务计划程序拉起 `lodestar-daemon` 即可,重启后上次活跃的 session 会自动 `--resume` 接回。

## 附加能力

**🔔 HTTP 通知端点** —— 本机任何脚本 `curl -X POST http://127.0.0.1:9876/notify -d '{"project":"xxx","text":"..."}'` 就能往群里推一张 markdown 卡片(info / warn / error 三档染色)。

**⏰ 定时任务** —— 在群里跟 Claude 说"每天早上 9 点总结昨天 PR",它自己 `schedule_create` 排好;每次 fire 起一个干净的 Claude 子进程跑,不累积上下文,silent / verbose 输出二选一,`hi` 面板带删/切按钮。

## 许可

[MIT](LICENSE)
