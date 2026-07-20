# TRACKER.md 与 TASK.md 规范

## TRACKER.md 路径

`.gsd/TRACKER.md`

## TRACKER.md 模板

```markdown
# GSD 任务跟踪

## 当前活跃任务

- 状态：无任务
- task_slug：
- 任务名称：
- 任务类型：
- 当前阶段：unknown
- 最后更新：
- planning_path：
- 备注：

## 任务索引

| task_slug | 名称 | 状态 | 创建时间 | 最后更新 |
|-----------|------|------|----------|----------|
```

### 字段说明

| 字段 | 取值 |
|------|------|
| 状态 | `无任务` / `运行中` / `已暂停` / `已完成` |
| 任务类型 | `generic` / `autoui`（活跃区；无任务时可留空） |
| 当前阶段 | `discuss` / `plan` / `execute` / `verify` / `ship` / `unknown` |
| planning_path | 活跃时填 `.gsd/{task-slug}/.planning/`，无任务时留空 |

### 更新时机（强制）

- 创建任务（generic 手工或 autoui bootstrap）
- bootstrap-autoui-task **已原子写入 TRACKER**，agent 勿重复手工改活跃区除非 phase 推进
- 切换活跃任务
- 暂停 / 完成
- 每个 phase 推进后（从 STATE.md 同步阶段到 TRACKER）
- junction 切换后

### 并发规则

- 「当前活跃任务 → 状态」为 `运行中` 的条目全局最多 1 个
- 切换任务时：旧任务 TASK.md + 索引表 → `已暂停`；新任务 → `运行中`

## TASK.md 路径

`.gsd/{task-slug}/TASK.md`

## TASK.md 模板

```markdown
# {任务名称}

- task_slug: {task-slug}
- 任务类型: generic
- 状态: 运行中
- 创建时间:
- 最后更新:
- 简述:

## 备注
```

### 任务类型

| 取值 | 说明 |
|------|------|
| `generic` | 普通 GSD 任务（默认） |
| `autoui` | UI 全自动任务；产物含 evidence/milestones/notes；规范见 yiui-auto-ui |

AutoUI 任务创建后，`TRACKER` 备注可写 `autoui` 便于过滤。

### TASK.md 状态

与 TRACKER 索引一致：`运行中` / `已暂停` / `已完成`

## task-slug 生成规则

1. 从用户中文或英文标题提取关键词
2. 转小写 kebab-case（仅 `a-z0-9-`）
3. 示例：「客户端任务系统」→ `client-quest-system`
4. 若 `.gsd/{slug}/` 已存在，追加 `-2`、`-3`…

## 从 STATE.md 推断当前阶段

读 `.gsd/{active}/.planning/STATE.md`（经 junction 时为项目根 `.planning/STATE.md`）：

| STATE 线索 | TRACKER 当前阶段 |
|------------|------------------|
| 讨论中 / CONTEXT 未闭合 | discuss |
| PLAN 已生成未执行 | plan |
| 执行中 / wave | execute |
| 待验证 / UAT | verify |
| 待 ship / PR | ship |
| 无法判断 | unknown |

## STATE.md 终验字段

进入执行阶段的任务应在 `STATE.md` YAML 前置区维护以下字段；旧任务最迟在第一次进入终验收口前补齐：

```yaml
finalization:
  change_generation: 0
  reviewed_generation: -1
  scope_frozen: false
  blocking_findings: 0
  final_verified_generation: -1
  final_verification_runs: 0
```

| 字段 | 说明 |
|------|------|
| `change_generation` | 当前交付物变更代际；同一单调子游标内的一个变更批次只增加一次 |
| `reviewed_generation` | 阻断级审查已完成且阻断项已收敛的代际；`-1` 表示尚无有效收敛结论 |
| `scope_frozen` | 当前 TASK 完成标准与剩余阻断清单是否已冻结 |
| `blocking_findings` | 违反当前 TASK 完成标准且尚未关闭的 Critical / Important 数量 |
| `final_verified_generation` | 已通过最终验收的代际；`-1` 表示尚未通过 |
| `final_verification_runs` | 当前任务已形成有效结果的最终验收次数 |

字段的完整状态机、阻断分级和校验命令见 `extra-finalization-gate.md`。

## 本地 git commit 消息格式

```
gsd({task-slug}): {动作简述}
```

示例：

- `gsd(client-npc): 创建任务`
- `gsd(client-npc): 进入 plan-phase`
- `gsd(client-npc): 切换到已暂停任务`
