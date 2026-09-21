---
name: fable-plan-dsh-exec
description: 跨模型工作流——claude:fable 档做规划与方案审阅,deepseek(dsh)档执行。用户说"fable 规划 deepseek 执行"、"用 fable 出计划/审方案、dsh 施工"、要求"强模型规划审阅 + deepseek 执行"分工、或对单任务指定规划/执行用不同档位时触发。
---

# fable-plan-dsh-exec(fpd)

单任务的跨模型编排:planner/reviewer 走 `claude:fable` 档(Claude 第一方 fable,底层 `claude-fable-5`),executor 走 dsh 档(DeepSeek Harness 原生后端)。编排由主 agent 完成,各波是独立的一次性委派 run。

## 定位与边界

- fpd 是**单任务跨模型编排**,不接管 GSD 状态:任务带 TRACKER/阶段/里程碑语义、或用户话术含"创建任务/切换/继续 GSD 任务",仍走 yiui-gsd,不要用 fpd 绕过。
- 目录隔离:fpd 只写 `.fpd/<slug>/`(已 gitignore);不写 `.gsd/`、`.planning/`。
- 机制依赖:daemon 的 `/agents/*` 端点 + `lodestar-agent` CLI(身份目录、run/follow-up、单层委派三层强制)。fpd helper 只做身份解析、目录初始化、限时等待三个机械动作。

## 机制速览(为什么这样设计)

- 身份目录跨 provider:每个已配置档位一个身份,`claude:fable` 与 dsh 档(`deepseek-v4-pro`)共存(`src/agent-identities.ts`);dsh 档由 `config.toml [deepseek-harness]` 派生,未填 `api_key` 时身份 `status: source_disabled`(`src/session-model.ts` selectableDshModelChoices)。
- 单层委派已由 daemon 三层强制:worker 的 startRun/followUp 首行即拒(policy 层)、claude `disallowedTools` / codex `--disable multi_agent` / dsh deny 委派工具(工具层)、`DELEGATED_AGENT_INSTRUCTIONS` 并入 developerInstructions(指令层)。fpd 各波 worker 都受此约束,波次间交接必须回到主 agent 中转。
- dsh 会话内的原生 subagent 全是 `deepseek-official` 模型(`src/dsh-bridge.ts`):跨模型跳线只能发生在主 agent 编排层。
- effort 档不互通:dsh 档(off/low/high/max)与 claude 档无交集,各身份 `default_effort` 已锁,`supported_efforts=[default]`,传错会被 daemon 拒(`src/agent-runner.ts:58`)。

## 标准工作流

### 波 0 · 开局(主 agent)

1. 定 `task-slug`(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`),把用户任务描述整理写进 `.fpd/<slug>/TASK.md`(含目标、非目标、已知约束)。
2. `fpd init <slug>` + `fpd resolve`(每次新任务现查身份,不缓存):planner/executor 身份落 `.fpd/<slug>/STATUS.md`。
3. 任一身份未就绪 → 停下给用户可执行指引(dsh 未配 → `config.toml [deepseek-harness] api_key`;fable 未就绪 → 查 `lodestar-agent identities`)。
4. 每次派发,首行 Bash 注释 `# desc:`(环境硬规则);prompt 一律 `--stdin` 配**引号 heredoc**(`<<'EOF'`,防 shell 展开)。

### 波 1 · planner(claude:fable,新 run)

```bash
# desc: 派发 planner 波(fable 规划)
lodestar-agent run --identity '<PLANNER_ID>' --no-wait --stdin <<'EOF'
你是本任务的规划师(planner),角色 worker,禁止委派任何子代理、禁止执行计划内容(只规划不施工)。
任务描述:.fpd/<TASK_SLUG>/TASK.md。
1. 读 TASK.md;计划依赖的环境事实(路径/版本/端口/现有文件)用 Bash 现测,禁止凭记忆断言。
2. 产出 .fpd/<TASK_SLUG>/PLAN.md:目标、步骤分解、依赖关系、验收标准。每个硬断言的期望值(sha256/行号/计数/路径/端口)必须在落盘前用 Bash 实测一遍,把实测命令与实测结果写进 plan 附注。
3. 每步可被单一执行者独立完成;不写"由后续模型/子代理完成"的占位。
4. stdout 只输出一行摘要:PLAN.md 路径 + 步骤数 + 结论。
EOF
```

- 从 `--no-wait` 输出取 `run_id`(`grep -m1 '"run_id"'`),写入 STATUS.md,再 `fpd wait <run_id>` 到终态。
- 交付验收:PLAN.md 每个硬断言都能找到对应附注实测依据,否则退回修订。

### 波 2 · reviewer(同一 fable 子会话 follow-up)

```bash
# desc: 派发 reviewer 波(fable 审阅,复用规划会话)
lodestar-agent follow-up '<PLAN_RUN_ID>' --no-wait --stdin <<'EOF'
切换角色为审阅者(reviewer),仍是 worker,禁止委派、禁止执行。
读 .fpd/<TASK_SLUG>/PLAN.md,对抗式审阅,产出 .fpd/<TASK_SLUG>/REVIEW.md:
- 硬断言是否全部有实测附注依据;缺失/不可测/无回滚路径的逐条列出;
- 步骤是否可被单一执行者独立完成;隐藏前置或交叉依赖;
- 结论:APPROVE,或 BLOCKERS(每条带必须的修订点)。
stdout 只输出一行摘要:结论 + blocker 数。
EOF
```

- **修订循环**:REVIEW.md 为 BLOCKERS 时,主 agent 把 blocker 清单整理成修订要点,对**同一 run_id** 再发 follow-up 让同一子会话改 PLAN.md 并复读 REVIEW.md;随后主 agent 复核。上限 **3 轮**,3 轮未 APPROVE → 停下向用户报告分歧点,由用户裁决。
- 修订轮不再重发全量必读文件,只发上一轮实测清单 + 本轮 blocker(引用,不粘贴全文)。

### 波 3 · executor(dsh,新 run)

1. 主 agent 先写 `.fpd/<slug>/EXEC-BRIEF.md`(交接简报):PLAN.md 路径 + REVIEW.md 审阅结论摘要 + 纪律与红线(进程红线/提交纪律等按任务实际写)。prompt 不粘贴计划全文。
2. 派发:

```bash
# desc: 派发 executor 波(dsh 执行)
lodestar-agent run --identity '<EXECUTOR_ID>' --no-wait --stdin <<'EOF'
你是本任务的执行者(executor),角色 worker,禁止委派任何子代理(含 dsh 原生 subagent)。
按序必读:.fpd/<TASK_SLUG>/EXEC-BRIEF.md → .fpd/<TASK_SLUG>/PLAN.md → .fpd/<TASK_SLUG>/REVIEW.md。
1. 严格按 PLAN 执行;偏离计划、遇到 blocker 或 REVIEW 已知残余风险被触发时,停下在 stdout 报告并等主 agent 裁决,不自行改计划。
2. 产出 .fpd/<TASK_SLUG>/SUMMARY.md:每步实际命令 + 实测结果,与 PLAN 硬断言逐条对照(✅/❌/偏离说明)。
3. stdout 只输出一行摘要:SUMMARY.md 路径 + 硬断言通过数/总数 + 结论。
EOF
```

- 执行是 dsh 原生会话:模型为 `[deepseek-harness]` 配置的档,effort 为该档默认,一律不传 `--effort`。
- 执行中偏离/blocker:主 agent 用 follow-up 续同一 dsh 子会话裁决,不新起 run。

### 波 4 · 收口(主 agent)

- 读 SUMMARY.md,对每个 ❌/偏离逐条跟进;对通过项**抽查实测**(evidence-based,不以 child claim 为准)。
- 需要补工时:对同一 exec run 发 follow-up(修订循环纪律同波 2)。
- 全绿后更新 STATUS.md 各波状态为 completed,向用户报告:各波实际身份、审阅轮数、硬断言结果、遗留项(如实)。

## 铁律

1. **单层委派**:任何波 worker 不得再委派(prompt 里必须写明"禁止委派");跨波交接只经主 agent 中转。
2. **身份现查**:每次新任务开始 `fpd resolve`;禁止缓存/脑补身份;身份变化(目录 generation 变)时重新解析。
3. **不传 `--effort`**:各身份 default_effort 已锁,跨 provider 传 effort 必被拒。
4. **交付走文件**:子 agent 产出写 `.fpd/<slug>/`,stdout 只放一行摘要(长输出会被 daemon 截断落 artifact,主线读文件稳定)。
5. **交接不粘贴全文**:prompt 只给路径 + 本轮增量;纪律文本引文件不重发(同 EXECUTOR-HANDBOOK 模式)。
6. **修订循环复用子会话**:plan/review 走同一 fable run 的 follow-up;exec 走同一 dsh run 的 follow-up;上限 3 轮。
7. **收口以主 agent 磁盘实测为准**;child 的"已完成"不等于事实。
8. **run_id 即状态**:每次派发后 run_id 立即写入 STATUS.md;任何中断都能凭 STATUS.md 恢复。

## 恢复与续跑

- 读 `.fpd/<slug>/STATUS.md` 判断停在哪个波:
  - 停在 plan/review:对记录的 run_id 直接 follow-up 续轮(先 `lodestar-agent status` 看状态;run 仍在跑则 `fpd wait`)。
  - 停在 exec:run 未终态 → `fpd wait` 续等;已 failed → 主 agent 判断原因后 follow-up 续轮或向用户报告;已 completed 但收口未做 → 从波 4 继续。
- `fpd wait` 超预算(默认 9 分钟,适配 Bash 600s 上限):run 状态在 daemon 侧不受影响,改用 Bash `run_in_background` 的 until 循环续等,或稍后 `fpd wait` 再跟。

## helper 用法

`fpd` 命令由 Lodestar daemon 装入 `DATA_DIR/bin`(Lodestar 会话 PATH 已含)。非 Lodestar 会话或命令缺失时,用 `node .agents/skills/fable-plan-dsh-exec/scripts/fpd.mjs` 直接跑同一脚本。

```bash
# desc: 解析 planner/executor 身份(fable + dsh,严格 ready 校验)
fpd resolve [--planner <model-substr>] [--executor <model-substr>] [--json]

# desc: 初始化任务目录 .fpd/<slug>/(STATUS.md 记身份与波次)
fpd init <task-slug>

# desc: 限时等待 run 到终态(completed/failed/cancelled/needs_input)
fpd wait <run_id> [--budget-min 9]
```

- `--planner` 默认 `claude:fable`;`--executor` 默认 dsh 档 source-default(通常 `deepseek-v4-pro`)。
- 身份解析规则:先精确匹配 model,再大小写不敏感子串;命中但未 ready 视为不可用并给原因。
- 三个子命令都不落缓存:每次执行都现查 daemon 身份目录。
