# -*- coding: utf-8 -*-
import argparse
import os
import re
import sys
from datetime import datetime, timezone, timedelta


def write_utf8_sig(path: str, content: str) -> None:
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="\n") as f:
        f.write(content)


def read_text(path: str) -> str:
    if not os.path.isfile(path):
        return ""
    with open(path, encoding="utf-8-sig") as f:
        return f.read()


def now_iso() -> str:
    tz = timezone(timedelta(hours=8))
    value = datetime.now(tz).strftime("%Y-%m-%dT%H:%M:%S%z")
    if len(value) > 22 and value[-5] in "+-":
        value = value[:-2] + ":" + value[-2:]
    return value


def parse_tracker_field(content: str, field: str) -> str:
    match = re.search(rf"^- {re.escape(field)}：(.*)$", content, re.MULTILINE)
    if not match:
        return ""
    return match.group(1).strip()


def pause_running_task(root: str, tracker_content: str, now: str) -> None:
    status = parse_tracker_field(tracker_content, "状态")
    if status != "运行中":
        return
    old_slug = parse_tracker_field(tracker_content, "task_slug")
    if not old_slug:
        return
    task_path = os.path.join(root, ".gsd", old_slug, "TASK.md")
    content = read_text(task_path)
    if not content:
        return
    content = re.sub(r"^- 状态: .*$", "- 状态: 已暂停", content, count=1, flags=re.MULTILINE)
    content = re.sub(r"^- 最后更新: .*$", f"- 最后更新: {now}", content, count=1, flags=re.MULTILINE)
    write_utf8_sig(task_path, content)


def update_index_row(content: str, slug: str, name: str, status: str, created: str, updated: str) -> str:
    row = f"| {slug} | {name} | {status} | {created} | {updated} |"
    pattern = rf"^\| {re.escape(slug)} \|.*$"
    if re.search(pattern, content, re.MULTILINE):
        return re.sub(pattern, row, content, count=1, flags=re.MULTILINE)
    marker = "|-----------|------|------|----------|----------|"
    if marker in content:
        return content.replace(marker, marker + "\n" + row, 1)
    return content.rstrip() + "\n" + row + "\n"


def update_index_status(content: str, slug: str, status: str, updated: str) -> str:
    pattern = rf"^\| {re.escape(slug)} \| ([^|]+) \| [^|]+ \| ([^|]+) \| [^|]+ \|$"
    match = re.search(pattern, content, re.MULTILINE)
    if not match:
        return content
    name = match.group(1).strip()
    created = match.group(2).strip()
    row = f"| {slug} | {name} | {status} | {created} | {updated} |"
    return re.sub(pattern, row, content, count=1, flags=re.MULTILINE)


def build_tracker(root: str, slug: str, name: str, now: str, old_content: str) -> str:
    pause_running_task(root, old_content, now)
    content = old_content
    old_running = parse_tracker_field(old_content, "状态") == "运行中"
    old_slug = parse_tracker_field(old_content, "task_slug") if old_running else ""
    if old_slug and old_slug != slug:
        content = update_index_status(content, old_slug, "已暂停", now)

    content = update_index_row(content, slug, name, "运行中", now, now)

    active = f"""## 当前活跃任务

- 状态：运行中
- task_slug：{slug}
- 任务名称：{name}
- 任务类型：autoui
- 当前阶段：discuss
- 最后更新：{now}
- planning_path：.gsd/{slug}/.planning/
- 备注：autoui
"""
    content = re.sub(
        r"## 当前活跃任务\n\n(?:- .+\n)+",
        active,
        content,
        count=1,
    )
    return content


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task-slug", required=True)
    parser.add_argument("--task-name", required=True)
    parser.add_argument("--user-brief", default="")
    parser.add_argument("--project-root", required=True)
    args = parser.parse_args()

    slug = args.task_slug
    name = args.task_name
    brief = args.user_brief or "待 discuss 阶段补充"
    root = os.path.abspath(args.project_root)
    now = now_iso()

    task_dir = os.path.join(root, ".gsd", slug)
    planning_dir = os.path.join(task_dir, ".planning")
    screenshot_dir = os.path.join(root, ".gsd", slug, "evidence", "screenshots")
    tracker_path = os.path.join(root, ".gsd", "TRACKER.md")

    task_md = f"""# {name}

- task_slug: {slug}
- 任务类型: autoui
- 状态: 运行中
- 创建时间: {now}
- 最后更新: {now}
- 简述: {brief}

## 备注

本任务由 bootstrap-autoui-task.ps1 创建。编排与恢复走 GSD；UI 规范见 yiui-auto-ui。
"""

    paths_md = f"""# 证据路径约定

- task_slug: {slug}
- 项目根: {root}

## evidence（AI 证据，按需建子目录）

- logs: .gsd/{slug}/evidence/logs/
- uivision: .gsd/{slug}/evidence/uivision/
- tool-results: .gsd/{slug}/evidence/tool-results/
- screenshots: .gsd/{slug}/evidence/screenshots/

## milestones（用户向里程碑，非 AI 恢复源）

- MILESTONES.md: .gsd/{slug}/milestones/MILESTONES.md
- AUTOUI-RECORD.md: .gsd/{slug}/milestones/AUTOUI-RECORD.md
- images: .gsd/{slug}/milestones/images/

## notes

- RUNTIME-ENTRY.md: 主界面/OpenYIUI 跑通后填写
- SERVER-GAPS.md: 上游协议/字段缺失时填写
- AI-LIMITATIONS.md: 需人工验收项

## 截图工具默认 outputDirectory

{screenshot_dir}

## git 约定

- markdown 与证据路径索引提交到 .gsd 本地 git
- 大二进制截图默认只 commit 路径引用
"""

    milestones_md = f"""# {name} — 里程碑记录

> 用户向回顾文档；**不作为 AI 恢复入口**。
> 进度真相源：.planning/STATE.md、phase PLAN/SUMMARY。

## 基本信息

| 项目 | 内容 |
|---|---|
| task_slug | {slug} |
| 进度源 | ../TASK.md、.planning/STATE.md |
| 图片目录 | images/ |
| 当前状态 | 进行中 |

## 关键节点总览

| 时间 | 阶段 | 用户向说明 | 做了什么 | 当前效果 | 图片/素材 | 下一步 |
|---|---|---|---|---|---|---|
"""

    project_md = f"""# {name}

## What This Is

AutoUI 长任务：{brief}

任务类型：autoui。编排与恢复走 GSD；UI 闸门、证据与验收规范见 yiui-auto-ui。

## Core Value

在 AutoUI 规范下完成可运行、可验证、可恢复的 UI 交付闭环。

## Requirements

### Active

- [ ] discuss：明确任务模式、ROADMAP、需求边界
- [ ] plan：可执行准备闸门、验收用例、VERIFICATION 骨架
- [ ] execute：按 phase PLAN 实现 UI / 逻辑 / 编译
- [ ] verify：验证矩阵、经验写入 extra-ui-learnings（如适用）
- [ ] ship：Done 总闸门与用户向 MILESTONES

### Out of Scope

- 未在 discuss 确认的协议/服务端改动
- 未在 plan 写入边界的文件范围外修改

## Context

- 用户简述：{brief}
- 证据目录：.gsd/{slug}/evidence/
- 里程碑记录：.gsd/{slug}/milestones/MILESTONES.md

## Constraints

- **Git**: `.gsd/` 不进 projectx 主仓库
- **并发**: 同时仅 1 个运行中 GSD 任务
- **AutoUI**: 须遵循 yiui-auto-ui（`extra-ui-strategies.md` + 任务经验写入 `extra-ui-learnings.md`）

---
*Created: {now} by bootstrap-autoui-task*
"""

    write_utf8_sig(os.path.join(task_dir, "TASK.md"), task_md)
    write_utf8_sig(os.path.join(task_dir, "notes", "PATHS.md"), paths_md)
    write_utf8_sig(os.path.join(task_dir, "milestones", "MILESTONES.md"), milestones_md)
    write_utf8_sig(os.path.join(planning_dir, "PROJECT.md"), project_md)

    tracker_old = read_text(tracker_path)
    if not tracker_old.strip():
        tracker_old = """# GSD 任务跟踪

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
"""
    tracker_new = build_tracker(root, slug, name, now, tracker_old)
    write_utf8_sig(tracker_path, tracker_new)
    print(slug)
    return 0


if __name__ == "__main__":
    sys.exit(main())
