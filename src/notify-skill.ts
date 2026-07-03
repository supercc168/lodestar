/**
 * Auto-install the `feishu-notify` skill so the user's main Codex
 * session (the one they type into at the terminal) can push to any
 * bound group via `/notify` without the user manually placing the
 * skill file.
 *
 * Why daemon writes this file:
 *
 * Skills are discovered from `~/.codex/skills/<name>/SKILL.md` at startup.
 * So the only way to
 * "ship with the daemon" without making the user run `cp` is to have
 * the daemon write the file itself.
 *
 * Idempotent: re-runs on every daemon boot. If the on-disk content
 * matches what we'd write, no I/O. If different (daemon upgraded with
 * a new skill body, or the user hand-edited it), overwrite with the
 * daemon's canonical version. The user's edits are not preserved by
 * design — daemon owns this skill, version-locked.
 *
 * Reasonable opt-out: setting `LODESTAR_DISABLE_SKILL_SYNC=1` skips
 * the sync, for users who want to maintain the skill content
 * themselves.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { log } from './log'
import { config } from './config'

const SKILL_FRONTMATTER_NAME = 'feishu-notify'

function skillBody(port: number): string {
  return `---
name: ${SKILL_FRONTMATTER_NAME}
description: Push a one-shot notification card to a Feishu (Lark) group via the local lodestar daemon's HTTP endpoint. Auto-trigger whenever the user asks to "通知飞书", "推送到飞书", "推到飞书群", "飞书推送", "发到飞书", "脚本跑完通知我", "进程完成发个消息", "send to feishu", "feishu notify", "lodestar notify", "post to lark group", or wants any local script / cron / long-running process to ping a Feishu group (build done, deploy finished, trade filled, monitor alert, error caught). Encodes the call shape — POST http://127.0.0.1:${port}/notify with \`{project, text, level}\` — so consumers do not have to re-derive it.
---

# feishu-notify

Push a one-shot card into a Feishu (Lark) group via the local lodestar
daemon. The daemon binds each group to a project name (= group name);
once the daemon has seen at least one inbound message in that group,
\`POST /notify\` with the project name routes a card to it.

## Endpoint

\`POST http://127.0.0.1:${port}/notify\` (loopback only)

Body (JSON):

| field | required | meaning |
|---|---|---|
| \`project\` | ✅ | Feishu group name (= session name = working-directory name) |
| \`text\` | ✅ | Feishu schema-2.0 markdown — \`**bold**\`, \`\` \`code\` \`\`, \`[link](url)\`, \`<font color='red'>…</font>\` |
| \`title\` |   | Card header, defaults to \`project\` |
| \`level\` |   | \`info\` (blue, default) / \`warn\` (yellow) / \`error\` (red) |
| \`images\` |   | Array of local image paths \`["/abs/a.png"]\` — uploaded to Feishu and embedded above the text (failed uploads surface inline in red, never dropped silently) |

Response: \`200 {ok, chat_id, message_id}\` / \`400\` bad params / \`404\`
group not bound / \`502\` Feishu API rejected.

## Usage

\`\`\`bash
curl -fsS -X POST http://127.0.0.1:${port}/notify \\
  -H 'content-type: application/json' \\
  -d '{"project":"ops","text":"✅ deploy done","level":"info"}'
\`\`\`

For automation that needs both success and failure paths:

\`\`\`bash
my-build-script.sh \\
  && curl -fsS -X POST http://127.0.0.1:${port}/notify -H 'content-type: application/json' \\
       -d '{"project":"ops","text":"✅ build ok"}' \\
  || curl -fsS -X POST http://127.0.0.1:${port}/notify -H 'content-type: application/json' \\
       -d '{"project":"ops","level":"error","text":"❌ build FAILED"}'
\`\`\`

## Notes

- The group must have received at least one message after the daemon
  started (the daemon learns chat_id → name binding from inbound
  events). If you see \`404\` send any message in the group and retry.
- This skill is auto-installed by the lodestar daemon on every boot.
  Hand-edits will be overwritten — set
  \`LODESTAR_DISABLE_SKILL_SYNC=1\` and restart the daemon if you want
  to maintain the file yourself.
`
}

export function ensureFeishuNotifySkill(): void {
  if (process.env.LODESTAR_DISABLE_SKILL_SYNC === '1') {
    log('skill: sync disabled via LODESTAR_DISABLE_SKILL_SYNC, skip')
    return
  }
  const skillFile = join(homedir(), '.codex', 'skills', SKILL_FRONTMATTER_NAME, 'SKILL.md')
  const desired = skillBody(config.notify.port)
  try {
    const current = existsSync(skillFile) ? readFileSync(skillFile, 'utf8') : null
    if (current === desired) return  // already up to date
    mkdirSync(dirname(skillFile), { recursive: true })
    writeFileSync(skillFile, desired)
    log(`skill: ${current === null ? 'installed' : 'updated'} ${skillFile}`)
  } catch (e) {
    log(`skill: sync failed (${skillFile}): ${e}`)
  }
}
