# GSD 终验代际门禁

## 目的

把“先终验、后终审、再改代码、再重跑终验”的循环变成磁盘上的可校验状态。聊天摘要不能替代 `STATE.md`，上下文压缩后只按代际字段和第一个未完成游标恢复。

## 固定顺序

```text
实现完成
→ 阻断级审查收敛
→ 冻结范围
→ 最终验收一次
→ 完成
```

禁止把常规设计终审放到最终验收之后。最终验收只证明已经审查并冻结的同一代际，不能为随后发生的变化背书。

## STATE 字段

```yaml
finalization:
  change_generation: 0
  reviewed_generation: -1
  scope_frozen: false
  blocking_findings: 0
  final_verified_generation: -1
  final_verification_runs: 0
```

- `change_generation`：当前交付物版本。一个单调子游标内，只要代码、配置、资源、脚本或影响验收结论的文档发生变化，该变更批次完成时增加一次。
- `reviewed_generation`：最近完成阻断级审查且阻断项已收敛的代际。仅执行过审查但仍有阻断项时不能推进该值；代码变化后即使数字暂未重置，只要不再等于 `change_generation`，旧审查就已失效。
- `scope_frozen`：当前 `TASK.md` 完成标准和剩余阻断清单已经冻结。处理已列阻断项不算扩大范围；新增范围、改变完成标准或接受新的阻断项时改回 `false`。
- `blocking_findings`：尚未关闭且直接违反当前 `TASK.md` 完成标准的 Critical / Important 数量。
- `final_verified_generation`：最近通过最终验收的代际。
- `final_verification_runs`：形成有效测试结果的最终验收次数。测试基础设施在用例开始前失败不计次数，但必须在 `STATE.md` 留下原因。

## 阻断分级

- 只有违反当前 `TASK.md` 完成标准的 Critical / Important 才能阻断，并必须写入单调游标或明确的阻断清单。
- Moderate / Minor、额外测试强化、范围外重构和“顺便优化”写入延后清单，不增加 `blocking_findings`，不扩张当前任务。
- 一次最终审查新增超过 3 个独立阻断项时，暂停当前收口并拆分新的 GSD 任务；当前任务不得在阻断未处理时伪装完成。
- 已经 GREEN / 已验证的游标只凭新鲜、可复现失败证据重开，并在该游标证据中增加 `reopen_reason`、复现命令和失败结果。

## 代际推进

1. 实现阶段以单调游标为单位完成 RED、GREEN 和局部验证。
2. 每个包含交付物变化的游标批次结束时，将 `change_generation` 增加一次并先提交 `.gsd` 状态。
3. 所有计划内实现完成后执行一次阻断级总审查；关闭阻断项后，将 `reviewed_generation` 设为当前 `change_generation`。
4. 冻结 `TASK.md` 完成标准和剩余范围，设置 `scope_frozen: true`、`blocking_findings: 0`。
5. 运行只读门禁：

   ```powershell
   pwsh ./.agents/skills/yiui-gsd/scripts/assert-finalization-gate.ps1
   ```

6. 门禁通过后，对当前代际运行一次最终验收。通过后增加 `final_verification_runs`，并将 `final_verified_generation` 设为当前 `change_generation`。
7. 标记任务完成前再运行：

   ```powershell
   pwsh ./.agents/skills/yiui-gsd/scripts/assert-finalization-gate.ps1 -RequireCompleted
   ```

## 失败恢复

- 门禁失败：只修正状态事实或未关闭阻断项，不运行最终验收。
- 最终验收发现产品或测试失败：修复属于新交付物变化，增加 `change_generation`，使旧审查和旧终验失效；重新审查新代际后再执行一次最终验收。
- 最终验收后发现普通改进：进入延后清单，不重开当前任务。
- 最终验收后出现新鲜、可复现且违反当前完成标准的失败：记录 `reopen_reason`，进入新代际并重新走完整门禁。

## 允许终验的条件

```text
reviewed_generation == change_generation
scope_frozen == true
blocking_findings == 0
```

任务完成还必须满足：

```text
final_verified_generation == change_generation
final_verification_runs >= 1
```
