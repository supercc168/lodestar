/**
 * temp-session leases + 群 API 两件测试(上游 ff44afb feishu-temp-lease.test.ts
 * 3 例近原样 + 本地叠加:重复租约守卫、createTempChatForSession 同名拒绝、
 * disbandChatForSessionExact 删除前复核)。
 *
 * Harness 同 feishu-turns-map.test.ts:子进程 fresh-state(bunfig [test].preload
 * 的 feishu mock 使进程内锚模式无法触达真实模块,开放问题 3 例外通道)。
 * 群 API 失败路径经 exported `client` 的 im.chat.* 方法子进程内 monkey-patch
 * 驱动(真 throw/真拒,零真实出网)。
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function runFresh(work: string, leases?: object) {
  const root = mkdtempSync(join(tmpdir(), 'lodestar-temp-lease-'))
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  if (leases) writeFileSync(join(dataDir, 'temp-session-leases.json'), JSON.stringify(leases))
  const configFile = join(root, 'config.toml')
  writeFileSync(configFile, [
    '[feishu]',
    'app_id = "t"',
    'app_secret = "t"',
    '',
    '[runtime]',
    `projects_root = "${root.replace(/\\/g, '\\\\')}"`,
    '',
  ].join('\n'))
  const feishuModule = pathToFileURL(join(import.meta.dir, 'feishu.ts')).href
  const script = `
    import * as feishu from ${JSON.stringify(feishuModule)}
    import { readFileSync } from 'node:fs'
    import { join } from 'node:path'
    const dataDir = ${JSON.stringify(dataDir)}
    const out = value => process.stdout.write('@@@' + JSON.stringify(value) + '@@@')
    ${work}
  `
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, '--eval', script],
      env: { ...process.env, LODESTAR_DATA_DIR: dataDir, LODESTAR_CONFIG: configFile },
    })
    const stdout = result.stdout.toString()
    const marker = stdout.match(/@@@([\s\S]*?)@@@/)
    if (!marker) throw new Error(`missing result marker\nstdout=${stdout}\nstderr=${result.stderr.toString()}`)
    return { exitCode: result.exitCode, value: JSON.parse(marker[1]), stderr: result.stderr.toString() }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('temporary-session leases', () => {
  test('persists and reloads exact chat/name ownership', () => {
    const result = runFresh(`
      feishu.registerTempSessionLease('project*0821-1337', 'oc_temp')
      feishu.loadTempSessionLeases()
      out({
        leased: feishu.hasTempSessionLease('project*0821-1337', 'oc_temp'),
        wrongChat: feishu.hasTempSessionLease('project*0821-1337', 'oc_other'),
        persisted: JSON.parse(readFileSync(join(dataDir, 'temp-session-leases.json'), 'utf8')),
      })
    `)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.value.leased).toBe(true)
    expect(result.value.wrongChat).toBe(false)
    expect(result.value.persisted.oc_temp).toMatchObject({
      sessionName: 'project*0821-1337', chatId: 'oc_temp',
    })
  })

  test('permanent session cleanup removes the exact persisted lease', () => {
    const result = runFresh(`
      feishu.loadTempSessionLeases()
      feishu.clearSessionConversationState('project*0821-1337')
      out({
        leased: feishu.hasTempSessionLease('project*0821-1337', 'oc_temp'),
        persisted: JSON.parse(readFileSync(join(dataDir, 'temp-session-leases.json'), 'utf8')),
      })
    `, {
      oc_temp: { sessionName: 'project*0821-1337', chatId: 'oc_temp', createdAt: 1 },
    })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.value).toEqual({ leased: false, persisted: {} })
  })

  test('rejects ordinary groups that merely look temporary', () => {
    const result = runFresh(`
      let error = ''
      try { feishu.registerTempSessionLease('ordinary-project', 'oc_normal') }
      catch (value) { error = value instanceof Error ? value.message : String(value) }
      out({ error, leased: feishu.hasTempSessionLease('ordinary-project', 'oc_normal') })
    `)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.value.error).toContain('non-temporary')
    expect(result.value.leased).toBe(false)
  })

  test('rejects re-leasing a name that is already leased to another chat', () => {
    const result = runFresh(`
      feishu.registerTempSessionLease('project*0821-1337', 'oc_first')
      let error = ''
      try { feishu.registerTempSessionLease('project*0821-1337', 'oc_second') }
      catch (value) { error = value instanceof Error ? value.message : String(value) }
      out({
        error,
        first: feishu.hasTempSessionLease('project*0821-1337', 'oc_first'),
        second: feishu.hasTempSessionLease('project*0821-1337', 'oc_second'),
      })
    `)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.value.error).toContain('already leased')
    expect(result.value.first).toBe(true)
    expect(result.value.second).toBe(false)
  })
})

describe('temporary-session chat API guards', () => {
  test('createTempChatForSession throws for an existing same-name chat and never creates/joins', () => {
    const result = runFresh(`
      const name = 'project*0821-1337'
      feishu.preferredChatForSession.set(name, 'oc_exist')
      feishu.chatNameCache.set('oc_exist', name)
      const calls = { create: 0 }
      feishu.client.im.chat.get = async () => ({ code: 0, data: { name, chat_status: 'normal' } })
      feishu.client.im.chat.create = async () => { calls.create++; return { code: 0, data: { chat_id: 'oc_new' } } }
      let error = ''
      try { await feishu.createTempChatForSession(name, 'ou_user') }
      catch (value) { error = value instanceof Error ? value.message : String(value) }
      out({ error, createCalls: calls.create })
    `)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.value.error).toContain('temporary group name already exists')
    expect(result.value.createCalls).toBe(0)
  })

  test('createTempChatForSession creates a brand-new chat when no same-name chat exists', () => {
    const result = runFresh(`
      const name = 'project*0821-1337'
      feishu.client.im.chat.list = async () => ({ code: 0, data: { items: [] } })
      feishu.client.im.chat.create = async () => ({ code: 0, data: { chat_id: 'oc_new' } })
      const created = await feishu.createTempChatForSession(name, 'ou_user')
      out({ created, bound: feishu.preferredChatForSession.get(name) ?? null })
    `)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.value.created).toEqual({ chatId: 'oc_new', created: true, joined: true })
    expect(result.value.bound).toBe('oc_new')
  })

  test('disbandChatForSessionExact re-verifies name and status before deleting', () => {
    const result = runFresh(`
      const name = 'project*0821-1337'
      const calls = { delete: 0 }
      feishu.client.im.chat.delete = async () => { calls.delete++; return { code: 0 } }

      // 名字不匹配 → 拒删
      feishu.client.im.chat.get = async () => ({ code: 0, data: { name: 'other-group', chat_status: 'normal' } })
      let nameError = ''
      try { await feishu.disbandChatForSessionExact(name, 'oc_temp') }
      catch (value) { nameError = value instanceof Error ? value.message : String(value) }

      // 状态异常 → 拒删
      feishu.client.im.chat.get = async () => ({ code: 0, data: { name, chat_status: 'dissolved' } })
      let statusError = ''
      try { await feishu.disbandChatForSessionExact(name, 'oc_temp') }
      catch (value) { statusError = value instanceof Error ? value.message : String(value) }

      const deletesBeforeMatch = calls.delete

      // 复核通过 → 才删
      feishu.client.im.chat.get = async () => ({ code: 0, data: { name, chat_status: 'normal' } })
      const done = await feishu.disbandChatForSessionExact(name, 'oc_temp')
      out({ nameError, statusError, deletesBeforeMatch, done, deleteCalls: calls.delete })
    `)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.value.nameError).toContain('refusing to delete')
    expect(result.value.nameError).toContain('other-group')
    expect(result.value.statusError).toContain('refusing to delete')
    expect(result.value.statusError).toContain('dissolved')
    expect(result.value.deletesBeforeMatch).toBe(0)
    expect(result.value.done).toEqual({ chatId: 'oc_temp', disbanded: true })
    expect(result.value.deleteCalls).toBe(1)
  })
})
