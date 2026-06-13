<p align="center">
  <img src="https://raw.githubusercontent.com/leviyuan/lodestar/main/promo.jpg" alt="夜航星 Lodestar" width="100%">
</p>

# 夜航星 (Lodestar)

AI 不是帮手,是倍率。它放大的不是体力,是你 —— 你的直觉、判断和品味,每一样都被乘以一个你以前不敢想的系数。

夜航星让这件事真正发生:在你思考的地方接住想法,在你转身之后继续推向终点。

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

群里发这些**裸词**(不要斜杠,大小写不敏感)可以控 daemon:

| 指令 | 行为 |
| --- | --- |
| `hi` | 未运行时同一张卡动态启动并收束为控制台;运行中弹控制台 |
| `stop` / `st` | 软打断当前 turn,子进程保活,排队消息打 ❌ |
| `kill` / `kl` | 用状态卡展示关闭 Codex 进程,`threadId` 落盘 |
| `restart` / `rs` | 用状态卡展示按上次 `threadId` 重启(保留上下文)|
| `clear` / `cl` | 用状态卡展示杀进程并开新 thread(等价 `/clear`)|
| `compact` / `cm` | 主动触发当前 thread 的上下文压缩,完成后状态卡收束 |
| `model` / `md` | 展示可用 Codex 模型面板,先选模型再选 reasoning effort,并按群持久化 |
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

### 🔔 HTTP 通知端点

本机任何脚本一行 curl 就能往群里推一张 markdown 卡片(info / warn / error 三档染色):

```bash
curl -sS -X POST http://127.0.0.1:9876/notify \
  -H 'Content-Type: application/json' \
  -d '{"project":"xxx","text":"build done","level":"info"}'
```

---

> [!TIP]
> 想 7×24 长跑,用 `systemd --user`(Linux/macOS)或 Windows 任务计划程序拉起 `lodestar-daemon`。重启后上次活跃的 sessions 会并发自动 `--resume` 接回。

---

## 📄 许可

[MIT](LICENSE)
