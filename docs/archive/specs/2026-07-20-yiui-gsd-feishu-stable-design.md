# yiui-gsd 在飞书 Lodestar 下稳定可用 — 设计

> 状态：已批准（对话评审 2026-07-20）  
> 范围：Codex + Claude 双后端；飞书 GSD 状态卡（按钮为主）；混合架构；Claude 全局去 superpowers/OMC

## 1. 背景与问题

`yiui-gsd` 已作为项目 skill 落地，本机 GSD 1.7.0 与 Sol 子代理策略已就绪，但在飞书 Lodestar 路径上**不能称为稳定可用**：

1. **平台假设**：任务切换脚本使用 Windows Junction（`New-Item -ItemType Junction` / `cmd rmdir`），本机 macOS 桥接不可靠。
2. **双后端发现不对称**：
   - Codex：可读项目 `.agents/skills/yiui-gsd` + 全局 `gsd-*`。
   - Claude（飞书默认 provider）：主要认 `.claude/` / `CLAUDE.md` / Claude skills，**不保证**加载 `.agents/skills`。
3. **Claude 全局规划脑仍在**：`~/.claude/settings.json` 仍 enable `oh-my-claudecode@omc` 与 `superpowers@superpowers-marketplace`；`~/.claude/CLAUDE.md` 仍是 OMC 编排合同。规划入口会被抢。
4. **飞书无 GSD 控制面**：没有 Codex App `update_plan` 计划栏；进度与切换只能靠聊天自觉，易与 `.gsd` 磁盘状态漂移。
5. **职责不清**：若只靠 agent 自觉跑 skill，TRACKER/junction 正确性无 daemon 级保证。

## 2. 目标与非目标

### 2.1 目标

1. 飞书群内用 **GSD 状态卡 + 按钮** 稳定管理任务（进度 / 继续 / 暂停 / 完成 / 开新任务入口）。
2. **Codex 与 Claude** 两条后端都能执行 GSD phase，且规划入口只有 **yiui-gsd**。
3. macOS / Linux / Windows 上项目根 `.planning` 都能正确指向活跃任务的 `.gsd/<slug>/.planning`。
4. Claude **用户全局**不再加载 superpowers / OMC 规划链路。
5. **唯一事实源**仍是磁盘：`.gsd/TRACKER.md` → 活跃 `TASK.md` → `.planning/STATE.md`；飞书卡仅为镜像与控制面。

### 2.2 非目标（本轮不做）

- 不重写 GSD core，不把官方 `gsd-*` 复制进仓库。
- 不恢复 Codex App `update_plan` 计划栏（飞书用状态卡替代）。
- 不把现有飞书 Task 清单 `task` worker 与 GSD 合并为一条产品线。
- 本轮不做 AutoUI 专用飞书面板（可后置）。
- 不在未获当条用户明确授权时重启 live daemon 做验证。

## 3. 已锁定决策

| 项 | 选择 |
|----|------|
| Provider 范围 | Codex **与** Claude 都要稳定 |
| 飞书交互 | **卡片按钮为主**（可保留弱裸词入口如 `gsd`） |
| 架构 | **混合**：daemon 管状态/切换/桥接/卡；agent 跑 phase |
| Provider 选择 | **跟随当前群 model**（不强制 GSD 切 Codex） |
| Claude 清理 | **本机全局**关闭 superpowers + OMC 规划，只留 yiui-gsd 规划入口 |

## 4. 架构

### 4.1 组件

```text
飞书群
  ├─ 弱入口: 裸词 `gsd` / `gsd status`（可选）
  └─ GSD 状态卡（主入口，按钮）
        │
        ▼
Lodestar daemon
  ├─ GsdStore
  │    读/写 .gsd/TRACKER.md、TASK.md 元数据状态
  │    触发 .gsd 本地 git commit（复用或对齐 yiui-gsd 脚本语义）
  ├─ PlanningBridge
  │    项目根 .planning → .gsd/<slug>/.planning
  │    Darwin/Linux: symlink；Windows: junction
  ├─ GsdPanel
  │    卡片渲染 + card.action.callback kinds
  └─ Session 注入
       「继续 / 开新任务」→ 对当前 provider 会话的受控 prompt
        │
        ▼
当前群 selectedProvider（claude | codex）
  └─ 必须加载 yiui-gsd
       └─ 内部路由到 gsd-*（Codex 原生更完整；Claude 用项目/全局引导兼容）
```

### 4.2 职责边界

| 职责 | 归属 |
|------|------|
| TRACKER / 任务状态机（运行中/暂停/完成/无任务） | Daemon `GsdStore` |
| `.planning` 桥接创建/修复/校验 | Daemon `PlanningBridge`（与 skill 脚本共享规则） |
| 状态卡展示与按钮 | Daemon `GsdPanel` + `daemon.handleCardAction` |
| discuss / plan / execute / verify / ship 等 phase 智能工作 | Agent + `yiui-gsd` + `gsd-*` |
| 子 agent 模型策略（Sol/medium/high） | 既有 Codex `gsd-*.toml` + defaults；Claude 侧不伪造同等 TOML，靠引导与可用子 agent |
| 飞书 Task 清单自动化 | **不在本设计内**（现有 `task`） |

### 4.3 数据流

**只读进度：**

```text
按钮「进度」→ GsdStore.read() + PlanningBridge.health()
  → 重绘 GSD 卡（不启动 agent turn）
```

**继续执行：**

```text
按钮「继续」
  → 校验：有活跃任务、bridge 健康、session 空闲可投递
  → 可选：确保 TRACKER 为运行中
  → Session 注入固定 GSD prompt（continue）
  → Agent 按 yiui-gsd 读 STATE，推进唯一下一步
  → 结束后用户可再点「进度」刷新卡（或 turn 结束钩子轻量刷新）
```

**开新任务：**

```text
按钮「新任务」→ 卡进入 awaiting_name 短状态 + toast 引导
用户下一条消息作为任务名（或显式 `gsd 新任务：…`）
  → GsdStore.createTask(slug, name)
  → 暂停旧运行中任务（若有）
  → PlanningBridge.switch(slug)
  → .gsd commit
  → 重绘卡
  → Session 注入 new-task / discuss-or-onboard prompt
```

### 4.4 事实源与禁止项

- Canonical：`.gsd/**` 磁盘状态。
- 飞书卡、agent 对话、App 计划栏均不得成为第二状态源。
- Agent 不得在未更新 TRACKER 的情况下“口头切换”活跃任务。
- Daemon 元数据操作（暂停/完成/建任务/切 bridge）**先写盘再回卡**；写盘失败则 toast 错误，不假装成功。

## 5. PlanningBridge（跨平台）

### 5.1 语义

- Canonical：`.gsd/<task-slug>/.planning/`
- Runtime：项目根 `.planning` 必须是指向 canonical 的链接。
- GSD 原生 workflow 只认项目根 `.planning/`；多任务靠链接切换。

### 5.2 实现规则

| 平台 | 链接类型 | 删除旧链接 |
|------|----------|------------|
| Darwin / Linux | symlink（优先相对目标，失败则绝对路径） | `unlink` / `rm` 仅移除链接本身 |
| Windows | junction（保持现有语义） | 仅对 reparse point 使用安全删除，禁止 `Remove-Item -Recurse` 打到 canonical |

### 5.3 API（逻辑）

- `ensureTaskPlanningDir(slug)`
- `switchActive(slug)` → 创建/替换 `.planning` 链接
- `health()` → `{ ok, kind: 'symlink'|'junction'|'missing'|'not-link'|'broken', target? }`
- `clearBridge()`（无活跃任务时可选）

### 5.4 与 yiui-gsd 脚本

- `switch-active-task.ps1`（及文档 `extra-junction-bridge.md`）必须与 daemon `PlanningBridge` **同一语义**。
- 推荐：抽出跨平台实现（ps1 调同一逻辑，或 daemon 用 TS 实现 + skill 文档指向“优先 daemon/统一脚本”）。
- 禁止飞书路径只修 daemon、agent 路径仍跑坏的 Windows-only 脚本而不自检。

## 6. GsdStore

### 6.1 读写范围

- `.gsd/TRACKER.md`：当前活跃任务块 + 索引表（字段对齐 `extra-tracker-schema.md`）。
- `.gsd/<slug>/TASK.md`：名称、状态、简述。
- 不在 Store 内解析完整 GSD phase 计划细节；phase 摘要可从 `.planning/STATE.md` 只读提取有限字段。

### 6.2 状态枚举

- `无任务` | `运行中` | `已暂停` | `已完成`
- 不变量：**至多一个**「运行中」。

### 6.3 操作

- `readSnapshot()` → 卡渲染与按钮使能
- `pauseActive()` / `completeActive()`
- `createAndActivate({ name, slug? })`
- `activate(slug)`（切换）
- 每次突变后：本地 `.gsd` git commit（消息简洁；失败记日志，是否阻断由实现定——默认：**元数据已写盘则卡可刷新，commit 失败记 warning**）

### 6.4 slug

- 小写 kebab-case；冲突追加 `-2`、`-3`…（对齐 yiui-gsd tracker schema）。

## 7. 飞书 GSD 状态卡

### 7.1 入口

- 裸词 `gsd`：打开或刷新状态卡（不强制开 agent turn）。
- 首次 GSD 相关按钮成功后：保证群内有一张可更新的状态卡（策略：复用 message 更新或按 session 记 `gsdCardMessageId`，实现时选与现有 task/model 卡一致的稳定模式）。

### 7.2 展示字段

- 任务名称 / `task_slug`
- 状态：运行中 | 已暂停 | 已完成 | 无任务
- 当前 phase / 下一步（STATE 有则显示，无则 `unknown`）
- bridge 健康：OK / 缺失 / 损坏
- 当前 provider 标签（仅展示）
- 最后更新时间（TRACKER）

### 7.3 按钮（短文案，手机优先）

| 文案 | kind | 前置条件 |
|------|------|----------|
| 进度 | `gsd_refresh` | 有 session |
| 继续 | `gsd_continue` | 有活跃可继续任务 + bridge OK + 可投递 |
| 暂停 | `gsd_pause` | 状态为运行中 |
| 完成 | `gsd_complete` | 有活跃任务（运行中或已暂停） |
| 新任务 | `gsd_new_prompt` | 有 session；进入 awaiting_name |

所有 callback `value` 必须带：

- `kind`
- `task_slug`（可空，无任务时）
- `panel_gen`（单调或随机，防过期点击）

### 7.4 开新任务命名 UX（本轮）

- Card Kit 无可靠自由输入时：**按钮进入 awaiting_name**，toast/卡文案提示用户下一条消息作为任务名。
- Session 在 awaiting_name 窗口内拦截下一条用户文本优先喂给 `GsdStore.createAndActivate`，再注入 agent；超时或用户发明确非任务命令则取消 awaiting。
- 后续若 Card Kit 支持更好输入控件，可替换而不改 Store API。

### 7.5 handleCardAction

- 在 `daemon.ts` `handleCardAction` 增加 `gsd_*` cases。
- 3 秒内需要即时 UI 时：优先 toast ACK；卡内容用既有安全路径更新（遵守 AGENTS.md：避免 ACK 前错误 `message.patch` 导致闪烁/回滚；与现网 verify 过的 task/notify 模式对齐）。
- 未知/过期 `panel_gen`：toast 提示刷新，不执行突变。

### 7.6 与 turn 并发

- `gsd_continue` / 开任务注入：若 session 正忙且不能安全排队，**拒绝**并 toast（默认拒绝，避免打断进行中的非 GSD turn）。
- `gsd_refresh` / `gsd_pause` / `gsd_complete`：允许在忙时做磁盘元数据操作（pause/complete 需文档化：不中断当前 agent turn，仅改 TRACKER；若需 stop turn，本轮**不**自动 stop，除非用户另发 `stop`）。

## 8. Session 注入契约

### 8.1 固定 prompt 模板（逻辑字段）

```text
[Lodestar GSD]
- 只用 yiui-gsd；禁止 superpowers / OMC / oh-my-claudecode / ralplan / ralph / ultrawork / “plan this” 旧规划入口
- 先读 .gsd/TRACKER.md 与活跃任务 STATE.md（经 .planning）
- 当前动作: <continue | new-task-discuss | …>
- task_slug: <slug>
- 任务名: <name>
- 完成后用中文简报：状态、phase、下一步；不得重做已 GREEN/已验证项
- 状态以磁盘为准；不要把聊天计划当作 TRACKER
```

### 8.2 注入通道

- 复用现有 `sendUserText` / 用户消息投递路径，保证与附件、reaction、ACK 语义一致。
- 注入内容对用户可见（飞书是人机群）：文案应短、可辨认为系统 GSD 指令，避免伪装成用户闲聊。

## 9. 双后端 skill 发现

### 9.1 Codex

- 工作目录 = 项目根（Lodestar `session.workDir`）。
- 依赖已安装：项目 `.agents/skills/yiui-gsd`、全局 `~/.agents/skills/gsd-*`、`~/.codex/agents/gsd-*`。
- 飞书侧不额外改 codex skill 路径，除非实测 app-server 未加载项目 skills（若未加载，再开补丁：文档化 cwd/trust 或启动参数；本设计要求实现阶段用实机验证并修到通过验收）。

### 9.2 Claude

1. **项目可见入口**
   - 增加项目级 `CLAUDE.md` 或 `.claude/CLAUDE.md` 硬规则：GSD/长任务 → yiui-gsd；先读 TRACKER；禁旧规划入口。
   - `.claude/skills/yiui-gsd` 指向或同步 `.agents/skills/yiui-gsd`（**单一正文源**在 `.agents/skills/yiui-gsd`）。
2. **settingSources**
   - 保持 project 源启用（默认 `user+project+local` 或项目 profile 等价配置），确保项目 CLAUDE.md/skills 被 SDK 加载。
3. **全局**
   - 见第 10 节；避免用户级 OMC/superpowers 覆盖项目规则。

## 10. Claude 全局清理

### 10.1 `~/.claude/settings.json`

- `enabledPlugins`：
  - `oh-my-claudecode@omc` → `false` 或移除
  - `superpowers@superpowers-marketplace` → `false` 或移除
  - 保留 `typescript-lsp@claude-plugins-official`（及无关插件）
- 移除或停用 OMC `statusLine.command`（`hud/omc-hud.mjs`）
- `extraKnownMarketplaces` 可保留但不 enable 插件

### 10.2 `~/.claude/CLAUDE.md`

- 删除 `<!-- OMC:START -->…<!-- OMC:END -->` 编排合同。
- 写入精简全局规则：多阶段/长任务规划默认 **yiui-gsd**；禁止 OMC/superpowers 规划入口。

### 10.3 其它

- 停用 `~/.claude/skills/omc-reference` 软链引用（删除链接或不再依赖）。
- 修改前备份到 `~/.claude/backups/yiui-gsd-<timestamp>/`。
- **影响面**：用户级全局，影响本机所有 Claude 项目——这是已锁定决策；文档中必须写明回滚步骤。

### 10.4 回滚

1. 从 backups 恢复 `settings.json` 与 `CLAUDE.md`。
2. 按需重新 enable 插件。
3. 新开 Claude 会话验证。

## 11. yiui-gsd skill 层改动

- 文档与脚本：junction → **跨平台 bridge**。
- Feishu/无 `update_plan`：保持“不可用则跳过镜像，不降级 GSD 状态”。
- 明确：daemon 已做的 Store/bridge 操作，agent 不得重复创建冲突任务；继续时以 TRACKER 为准。
- phrase-map 可增加飞书按钮等价白话（继续/进度）以便非按钮触发一致。

## 12. 测试与验收

### 12.1 自动化（仓库内）

- `PlanningBridge`：symlink 创建/替换/拒绝非链接目录/health。
- `GsdStore`：创建/暂停/完成/单运行中不变量/slug 冲突。
- GSD 卡渲染：关键字段与按钮 kind 快照或字符串包含断言。
- `handleCardAction`：过期 `panel_gen`、无 session、busy 时 continue 拒绝。

### 12.2 实机 / 半实机（飞书）

在**用户当条消息授权**或非 live 干扰路径下验证：

1. Claude 全局：新会话无 OMC/superpowers 规划抢占。
2. 飞书 Codex：状态卡按钮与 TRACKER 一致；继续能注入并推进。
3. 飞书 Claude：同上。
4. macOS：开/切任务后 `.planning` 为正确 symlink。
5. 杀会话重进：仅磁盘恢复；刷新卡与 TRACKER 一致。

### 12.3 验收清单（稳定可用定义）

- [ ] Claude 全局规划入口仅为 yiui-gsd 导向，OMC/superpowers 插件未 enable  
- [ ] 飞书 Codex：进度/继续/暂停/完成/新任务主路径通过  
- [ ] 飞书 Claude：同上  
- [ ] macOS bridge health=OK  
- [ ] 无第二状态源  
- [ ] 并发与过期按钮安全  
- [ ] `bun test` 相关新增/回归通过  

## 13. 实现顺序

1. `PlanningBridge` + yiui-gsd 脚本/文档对齐  
2. `GsdStore`  
3. GSD 卡 + `handleCardAction` + 弱裸词 `gsd`  
4. Session 注入 continue/new-task  
5. Claude 项目入口（CLAUDE.md + skills 暴露）  
6. Claude 全局清理（备份→改→验证）  
7. 测试与用户文档（开发指南短节）  

## 14. 风险与缓解

| 风险 | 缓解 |
|------|------|
| Claude 仍不加载 `.agents` skill | 项目 `.claude/skills`  fort + CLAUDE.md 硬规则 + 注入 prompt |
| 全局关 OMC 影响其它仓库习惯 | 备份+回滚说明；全局规则写清仅规划入口变更 |
| 按钮与 agent 双写 TRACKER 冲突 | 元数据只让 daemon 写；agent 只推进 planning 内容 |
| 长 GSD turn 与飞书体验 | 卡负责状态；不在本轮做复杂进度推流 |
| 改 live daemon 需重启 | 实现后仅报告需重启；重启需用户当条授权 |

## 15. 文档位置

- 本 spec：`docs/archive/specs/2026-07-20-yiui-gsd-feishu-stable-design.md`
- 不再使用 `docs/superpowers/` 路径（该树已归档迁移）。

## 16. 开放实现细节（计划阶段钉死，不阻塞本 spec）

- GSD 卡 messageId 持久化键名与存放处（session 内存 vs XDG map）。
- awaiting_name 超时秒数默认值。
- turn 结束后是否自动 `gsd_refresh`（建议：是，轻量只读刷新）。
- Windows CI 是否覆盖 junction（本机开发以 macOS 为主时，TS bridge 单测 mock `fs` 即可）。
