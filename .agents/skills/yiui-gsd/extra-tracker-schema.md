# TRACKER.md 与 TASK.md 规范

## 事实源与职责

- `.gsd/{task-slug}/TASK.md` 保存单个任务的身份、状态和简述。
- `.gsd/{task-slug}/.planning/STATE.md` 保存阶段、计划和单调执行游标。
- `.gsd/PROJECT.md` 保存所有 workstream 共享的项目级上下文，通过根 `.planning/PROJECT.md` 硬链接暴露；不得写入单任务进度。
- `.gsd/TRACKER.md` 是所有未完成任务的聚合索引，只能由 Node helper 的 `update-gsd-tracker` 从 TASK/STATE 重建。
- 当前 Codex 会话选择哪个任务由 GSD session-local workstream 保存，不写入 TRACKER，也不改变其他任务状态。

## TRACKER.md 模板

```markdown
# GSD 任务跟踪

> 这里只列出未完成任务。当前会话选择由 GSD session-local workstream 保存，不属于任务状态。

## 未完成任务

| task_slug | 名称 | 类型 | 状态 | 当前阶段 | 创建时间 | 最后更新 | 简述 |
|-----------|------|------|------|----------|----------|----------|------|
```

TRACKER 只允许出现 `运行中` 和 `已暂停`：

- `运行中`：任务未暂停，允许已选择该 task_slug 的会话推进；不表示 AI 所有权或进程存活。
- `已暂停`：保留任务与全部证据，但任何会话都不得自动推进。
- `已完成`：先在 TASK/STATE 落盘完成事实，再从 TRACKER 聚合表删除；任务目录和 `.gsd` Git 历史继续保留。

`当前阶段` 从对应 STATE 的 `current_phase` 读取；没有 STATE 或无法判断时写 `unknown`。表格按“运行中优先、最后更新时间倒序、task_slug”确定性排序。

## 更新规则

创建、暂停、恢复、完成、切换或 phase 推进后：

1. 先更新当前任务的 TASK/STATE。
2. 执行 `node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs update-gsd-tracker --project-root .`，由 helper 在共享锁内扫描所有 TASK 并原子替换 TRACKER。
3. 执行 `node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs gsd-local-commit --project-root . --task-slug <slug> --message "<message>"`；helper 会在同一共享锁内再次重建 TRACKER，并且只暂存 TRACKER 和当前任务目录。

禁止手工维护 TRACKER 行、保留“当前活跃任务”单值区，或把已完成任务继续放在表中。

普通任务使用 Node helper 的 `new-gsd-task` 创建；AutoUI 使用 `bootstrap-autoui-task`，禁止混用两个 bootstrap。
暂停或完成任务使用 Node helper 的 `set-gsd-task-status`；禁止绕过完成门禁直接把 TASK 标成已完成。

## TASK.md 模板

路径：`.gsd/{task-slug}/TASK.md`

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
| `generic` | 普通 GSD 任务 |
| `autoui` | UI 全自动任务；产物含 evidence/milestones/notes，规范见 yiui-auto-ui |

### 状态转换

```text
运行中 <-> 已暂停
运行中/已暂停 -> 已完成
```

- 创建新任务时只新增一个 `运行中` TASK，不暂停其他任务。
- “切换/继续到 XX”只把目标任务从 `已暂停` 恢复为 `运行中`，不改其他 TASK。
- 完成是终态；若确需重开，必须按 GSD 新鲜失败证据与 `reopen_reason` 规则显式处理，不能靠切换脚本隐式恢复。
- 同一 task_slug 同时只允许一个写入者；任务状态本身不记录由哪个 AI 执行。

## task-slug 生成规则

1. 从用户中文或英文标题提取关键词。
2. 转为小写 kebab-case，只允许 `a-z0-9-`，且不能以连字符开头或结尾。
3. 示例：「客户端任务系统」转为 `client-quest-system`。
4. 若 `.gsd/{slug}/` 已存在，追加 `-2`、`-3`，不得覆盖历史任务目录。

## 从 STATE.md 推断当前阶段

| STATE 线索 | TRACKER 当前阶段 |
|------------|------------------|
| 讨论中 / CONTEXT 未闭合 | discuss |
| PLAN 已生成未执行 | plan |
| 执行中 / wave | execute |
| 待验证 / UAT | verify |
| 待 ship / PR | ship |
| 无法判断 | unknown |

优先读取 STATE 中显式的 `current_phase`；上表只用于旧状态缺少该字段时的人工修正，不允许脚本猜测。

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

字段的完整状态机、阻断分级和校验命令见 `extra-finalization-gate.md`。

## 本地 Git 提交

提交信息：`gsd({task-slug}): {动作简述}`。

共享 `.gsd` 仓库内禁止 `git add -A`。提交 helper 默认只允许 `TRACKER.md` 和当前 task_slug；当前操作明确修改项目级上下文时才传 `--include-shared-project` 额外允许 `PROJECT.md`。发现当前索引已有其他任务或范围外文件时必须停止，不能替调用方取消暂存或把其他任务带入提交。
