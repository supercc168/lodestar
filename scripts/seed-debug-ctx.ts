#!/usr/bin/env bun
/** One-shot: write debug-context.json by querying Feishu for the human
 * member of a chat. Usage: bun scripts/seed-debug-ctx.ts <chat_id>
 * (default: test1). */
import { client } from '../src/feishu'
import { writeFileSync } from 'node:fs'
import { DEBUG_CTX_FILE } from '../src/paths'

const CHAT_ID = Bun.argv[2] ?? 'oc_175fdd09fec02a76b96c901540f4dc54'
const res = await client.im.v1.chatMembers.get({ path: { chat_id: CHAT_ID }, params: { member_id_type: 'open_id', page_size: 100 } })
const members = (res.data as any)?.items ?? []
console.log('members:', members.map((m: any) => ({ id: m.member_id, name: m.name })))
const human = members.find((m: any) => m.name && !/bot|lodestar|claude|机器人/i.test(m.name)) ?? members[0]
if (!human?.member_id) { console.error('no member found'); process.exit(1) }
const ctx = {
  chat_id: CHAT_ID,
  sender_open_id: human.member_id,
  seeded_at: new Date().toISOString(),
  seeded_by: 'seed-debug-ctx.ts',
  seeded_name: human.name ?? '(unknown)',
}
writeFileSync(DEBUG_CTX_FILE, JSON.stringify(ctx, null, 2))
console.log('wrote', DEBUG_CTX_FILE, ctx)
