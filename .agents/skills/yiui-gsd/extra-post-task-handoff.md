# 任务派发与收口流程约定

- 落盘时间：2026-09-14
- 来源：`nullable-postdelivery-followups` 全任务复盘（`.gsd/nullable-postdelivery-followups/RETROSPECTIVE.md` 第 3 节）与 `FOLLOWUP-PLAN.md`，用户裁决取**方案 B**（流程约定随下一次 GSD 任务生效，不单独立项）
- 适用范围：yiui-gsd 编排下所有任务的 planner / executor / checker 派发与收口波
- 性质：对既有 `extra-planning-efficiency.md` / `extra-codex-agent-policy.md` / `extra-finalization-gate.md` 的**追加**，不修改既有规则；冲突时以本文件为准（复盘后修订）

## 1. 任务开局（新任务或继续任务的第一波）

### 1.1 底噪清单波（复盘 #5，P2）

任务开局第一波必须包含「底噪清单波」，产出 `evidence/noise-baseline-<波号>.json`（或任务级 `NOISE-BASELINE.md`）：

- 对四树工作副本（Server / ClientServer / Client / Client2）逐个执行 `svn status`，**全量逐文件**登记：
  - 路径（仓库相对路径）
  - `sha256`（文件存在时实测；目录条目按 svn 语义登记）
  - 来源判断（已知原因，如 et-skill-router SKILL.md 四树副本、Unity 自动生成 .meta、AIBridgeSettings.asset 等；未知则记 `unknown`）
- 底噪清单落盘前不得改任何产品文件；清单本身冻结（sha256 锁定）
- **收口波必须复核**：重新跑四树 `svn status`，与开局清单逐条比对，任何新增/消失/变化条目必须归因（任务改动 / 外部因素 / 无法归因），写入收口 SUMMARY
- 底噪是「越出底噪 0 条」判定的基准，未做底噪清单波不得宣称收口零漂移

### 1.2 EXECUTOR-HANDBOOK.md（复盘 #3，P1）

任务开局创建任务级 `.gsd/<task-slug>/.planning/EXECUTOR-HANDBOOK.md`，作为**任务级纪律唯一权威**。至少包含：

```text
## 任务级纪律（每次 executor 派发必读）
1. 进程红线：PID 46459 只读（ps/lsof），不部署不重启不停止任何服务
2. 四树底噪口径：CS/SV/CL/CL2 各底噪值 + 引用 NOISE-BASELINE
3. 产品提交纪律：SVN 显式路径提交、零目录、提交+取更新后逐字节比对
4. .gsd 提交纪律：仅走 helper（gsd-local-commit 限域 {TRACKER.md, task_slug}）
5. 日志/编译/裁决纪律（按任务实际需要增补）
## 本任务特例（每个波次在此追加/撤销）
```

- executor 派发提示**只引用** `读 HANDBOOK + 本波 PLAN`＋本波特例；禁止把纪律文本整段手写进提示
- HANDBOOK 版本随任务 git 走，漂移可 diff；变更 HANDBOOK 需在派发提示中注明变更点

## 2. planner 派发（复盘 #2，P1）

- planner 派发必须附：**计划内每个 `<verify>` 块的每个硬断言期望值（sha256 / 行号 / 计数 / 路径 / 端口）在落盘前用 Bash 实测一遍，并把实测命令与实测结果写进 plan 附注**
- 禁止基于研究/推演写期望值；checker 的磁盘实测职责保留（抓残余），但期望往返应从多轮降到 1 轮
- 派发验收：PLAN.md 每个硬断言都能找到对应附注实测依据，否则退回 planner

## 3. checker 修订循环（复盘 #8，P3）

- checker 修订循环**复用同一子代理**：用 `send_message` 续轮，不每次新派（省必读文件重载）
- checker 第 1 轮产出「磁盘实测清单」（它算过的事实，如文件数/警告口径/路径基准）随修订提示一并传给 planner，避免修订轮重算
- 修订轮提示 = 第 1 轮实测清单 + 本轮 BLOCKER 清单，不再重发全量必读文件

## 4. 偏差登记（复盘 #7，P3）

- 所有偏差登记统一加 `kind` 字段，取值四选一：
  - `plan-defect`：计划硬断言与磁盘现实不符
  - `env-change`：环境/外部状态变化
  - `exec-choice`：执行期按用户指令/裁决改变口径
  - `tool-limit`：工具能力受限（探针输入、svn diff 编码等）
- 收口波按 kind 统计，写入收口 SUMMARY；`plan-defect` 占比高时必须提示下一阶段 planner 补实测

## 5. ENOBUFS 降级提交（复盘 #1，P0；工具链已落地）

- 根因与修复：`yiui-gsd.mjs` 的 `runGit` 此前未设 `maxBuffer`（Node 默认 1MB），`.gsd` 仓积累大体积未跟踪目录后 git 输出超限即报 ENOBUFS；现上限提到 256MB，并对 spawn 层失败分类为 `GitSpawnError`
- helper 内置**降级提交路径**：git spawn 不可用时自动进入，先校验 staged 清单 ⊆ {TRACKER.md, task_slug 目录（及可选 PROJECT.md）}，越域即拒绝并 reset；校验通过才 commit（`--quiet` 小输出）
- 自证/应急开关：`YIUI_GSD_FORCE_FALLBACK_COMMIT=1` 强制走降级路径（2026-09-14 已在隔离仓实测成功提交与越域拒绝各一次，真实仓实弹成功提交一次）
- 禁止回退到「手工 git add + 人工 awk 检查越域」的等价提交；一律走 helper

## 6. 收口波（汇总）

收口波必须同时产出：底噪漂移复核（§1.1）＋偏差 kind 统计（§4）＋终验门禁（见 `extra-finalization-gate.md`）；三项缺一不得宣告任务完成。
