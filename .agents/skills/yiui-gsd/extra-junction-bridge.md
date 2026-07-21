# .planning 跨平台 Workstream 路由

## 目录契约

```text
.planning/                                      # 稳定路由目录，不再指向单个任务
  PROJECT.md                                    # HardLink -> .gsd/PROJECT.md（项目级共享）
  workstreams/
    {task-slug}/                                # Unix symlink / Windows junction
      -> .gsd/{task-slug}/.planning/            # canonical GSD 状态
```

官方 GSD 通过 `--ws <task-slug>` 读取 `.planning/workstreams/{task-slug}/`。PROJECT 是官方 workstream 的项目级共享上下文；任务目标、ROADMAP、STATE 和 phases 仍按 task_slug 隔离。当前会话选择由官方 session-local workstream 指针保存；TRACKER 不保存全局唯一“活跃任务”。

Windows junction 的目录枚举行为与普通目录不同，因此 `$gsd-workstreams list` 不能作为本定制层的任务清单事实源。列任务读取 TRACKER，执行 GSD 始终显式传 `--ws`。Unix 与 Windows 都由同一个 Node helper 维护路由。

## 建立或切换路由

在项目根执行：

```bash
node .agents/skills/yiui-gsd/scripts/yiui-gsd.mjs switch-active-task --project-root . --task-slug client-quest-system
```

脚本会：

1. 验证 `.gsd/{task-slug}/TASK.md` 与 canonical `.planning`。
2. 把旧版“根 `.planning` 直接指向单任务”的 symlink/junction 安全替换为稳定目录。
3. 建立或校验共享 `.planning/PROJECT.md` 硬链接和 `.planning/workstreams/{task-slug}` 路由链接。
4. 若目标已暂停，将目标 TASK 和 STATE 恢复为运行中；不修改其他任务。
5. 调用官方 `workstream.set` 设置当前会话选择，并重建 TRACKER。

## 验证

```bash
ls -ld .planning/workstreams/client-quest-system
node "$HOME/.codex/gsd-core/bin/gsd-tools.cjs" query workstream.get --raw --cwd "$PWD"
node "$HOME/.codex/gsd-core/bin/gsd-tools.cjs" query init.progress --raw --cwd "$PWD" --ws client-quest-system
```

## 安全边界

- 只允许删除已验证为链接的路由；Windows 校验 reparse point，Unix 校验 symbolic link。禁止对 canonical 任务目录执行递归删除。
- `.planning/workstreams/{slug}` 已存在且不是路由链接时停止，不能覆盖真实目录。
- 同一 task_slug 同时只允许一个写入者。不同 task_slug 的 planning 文件可以隔离，但共享项目源码、Unity 和服务进程仍需按修改范围串行或使用独立 Git worktree。
- 缺少会话标识时，官方 GSD 会退回共享 workstream 指针；并行 Codex 会话必须确保 `CODEX_THREAD_ID` 或其他官方支持的 session key 存在。
