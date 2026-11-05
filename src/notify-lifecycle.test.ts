import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'

import './feishu-test-mock'
import { handleNotifyRequest } from './notify'
import {
  __setStoreFileForTest,
  buildNotifyResult,
  get,
  loadCallbacks,
} from './notify-callbacks'
import { createNotifyReplyRuntime } from './notify-replies'

type SendFailure = (error: unknown) => void

interface FakeTransport {
  cards: object[]
  uuids: Array<string | undefined>
  updates: Array<{ messageId: string; card: object }>
  sendResults: Array<string | null>
  sendFailures: unknown[]
  failPatches: number
  sanitizeSessionName(name: string): string
  chatIdForSession(name: string): string | null
  uploadImageKey(path: string): Promise<string>
  sendCard(chatId: string, card: object, onFailure?: SendFailure, uuid?: string): Promise<string | null>
  updateCard(messageId: string, card: object): Promise<void>
}

function fakeTransport(): FakeTransport {
  return {
    cards: [],
    uuids: [],
    updates: [],
    sendResults: ['om_original'],
    sendFailures: [],
    failPatches: 0,
    sanitizeSessionName: name => name,
    chatIdForSession: () => 'oc_project',
    uploadImageKey: async path => `img_${path.split('/').at(-1)}`,
    async sendCard(_chatId, card, onFailure, uuid) {
      this.cards.push(structuredClone(card))
      this.uuids.push(uuid)
      const result = this.sendResults.shift() ?? null
      if (!result) onFailure?.(this.sendFailures.shift() ?? new Error('response lost'))
      return result
    },
    async updateCard(messageId, card) {
      this.updates.push({ messageId, card: structuredClone(card) })
      if (this.failPatches > 0) {
        this.failPatches--
        throw new Error('patch response lost')
      }
    },
  }
}

async function invoke(
  transport: FakeTransport,
  method: 'POST' | 'PUT' | 'GET',
  path: string,
  body?: object,
): Promise<{ status: number; json: any; raw: string }> {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as IncomingMessage
  req.method = method
  req.url = path
  req.headers = { host: 'localhost' }
  let raw = ''
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader() {},
    end(value?: string) { raw += value ?? '' },
  } as unknown as ServerResponse
  await handleNotifyRequest(req, res, transport as any)
  let json: any
  try { json = JSON.parse(raw) } catch { json = null }
  return { status: res.statusCode, json, raw }
}

let tempDir = ''
let storeFile = ''

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'lodestar-notify-lifecycle-'))
  storeFile = join(tempDir, 'notify-callbacks.json')
  __setStoreFileForTest(storeFile)
})

afterEach(() => {
  __setStoreFileForTest(storeFile)
  rmSync(tempDir, { recursive: true, force: true })
})

describe('versioned notify lifecycle', () => {
  test('stable request identity serializes creation and becomes unknown instead of sending outside the dedupe window', async () => {
    const transport = fakeTransport()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const sendEntered = new Promise<void>(resolve => { entered = resolve })
    transport.sendCard = async function (_chatId, card, _onFailure, uuid) {
      this.cards.push(structuredClone(card))
      this.uuids.push(uuid)
      entered()
      await gate
      return 'om_original'
    }
    const body = { request_id: 'hub:instance:card-1', version: 1, project: 'project', text: 'Approve?', buttons: [{ id: 'yes', text: 'Yes' }] }
    const first = invoke(transport, 'POST', '/notify', body)
    const concurrent = invoke(transport, 'POST', '/notify', body)
    await sendEntered
    expect(transport.cards).toHaveLength(1)
    release()
    const [created, replayed] = await Promise.all([first, concurrent])
    expect(created.status).toBe(200)
    expect(replayed.status).toBe(200)
    expect(replayed.json).toEqual(created.json)
    expect(created.json).toMatchObject({
      ok: true,
      request_id: body.request_id,
      transport_state: 'applied',
      version: 1,
      applied_version: 1,
      message_id: 'om_original',
    })
    expect(created.json.notify_id).toStartWith('nf_')
    expect(transport.uuids[0]?.length).toBeLessThanOrEqual(50)

    __setStoreFileForTest(storeFile)
    loadCallbacks()
    const afterRestart = await invoke(transport, 'POST', '/notify', body)
    expect(afterRestart.json).toEqual(created.json)
    expect(transport.cards).toHaveLength(1)
    const conflict = await invoke(transport, 'POST', '/notify', { ...body, text: 'Different' })
    expect(conflict.status).toBe(409)
    expect(conflict.json.error).toBe('request_id_conflict')

    const recovered = fakeTransport()
    recovered.sendResults = [null]
    recovered.sendFailures = [new Error('response lost')]
    const recoverBody = {
      request_id: 'hub:instance:card-recover', version: 1, project: 'project', text: 'Recover send',
    }
    expect((await invoke(recovered, 'POST', '/notify', recoverBody)).json.transport_state).toBe('pending')
    const firstUuid = recovered.uuids[0]
    __setStoreFileForTest(storeFile)
    loadCallbacks()
    recovered.sendResults = ['om_recovered']
    const recoveredResult = await invoke(recovered, 'POST', '/notify', recoverBody)
    expect(recoveredResult.status).toBe(200)
    expect(recoveredResult.json.message_id).toBe('om_recovered')
    expect(recovered.uuids).toEqual([firstUuid, firstUuid])

    const expired = fakeTransport()
    expired.sendResults = [null]
    expired.sendFailures = [new Error('network unavailable')]
    const expiredBody = {
      request_id: 'hub:instance:card-expired', version: 1, project: 'project', text: 'Expired send',
    }
    const expiredFirst = await invoke(expired, 'POST', '/notify', expiredBody)
    expect(expiredFirst.status).toBe(502)
    const attemptedAt = get(expiredFirst.json.notify_id)?.createAttemptedAt
    expect(attemptedAt).toBeNumber()
    setSystemTime(new Date(attemptedAt! + 60 * 60 * 1000 + 1))
    try {
      const expiredRetry = await invoke(expired, 'POST', '/notify', expiredBody)
      expect(expiredRetry.status).toBe(202)
      expect(expiredRetry.json.transport_state).toBe('unknown')
      expect(expired.cards).toHaveLength(1)
    } finally {
      setSystemTime()
    }

    const ambiguous = fakeTransport()
    ambiguous.sendResults = [null]
    ambiguous.sendFailures = [{ code: 200770, message: 'UUID consumed without message id' }]
    const unknown = await invoke(ambiguous, 'POST', '/notify', {
      request_id: 'hub:instance:card-unknown', version: 1, project: 'project', text: 'Unknown send',
    })
    expect(unknown.status).toBe(202)
    expect(unknown.json).toMatchObject({ transport_state: 'unknown', applied_version: 0 })
    expect(ambiguous.cards).toHaveLength(1)
    const unknownReplay = await invoke(ambiguous, 'POST', '/notify', {
      request_id: 'hub:instance:card-unknown', version: 1, project: 'project', text: 'Unknown send',
    })
    expect(unknownReplay.json.transport_state).toBe('unknown')
    expect(ambiguous.cards).toHaveLength(1)
  })

  test('higher versions patch the original message monotonically and freeze an ambiguous update across restart', async () => {
    const transport = fakeTransport()
    const created = await invoke(transport, 'POST', '/notify', {
      request_id: 'hub:instance:card-2', version: 1, project: 'project', text: 'v1',
      buttons: [{ id: 'approve', text: 'Approve' }],
    })
    const notifyId = created.json.notify_id
    const updateBody = {
      project: 'project', version: 2, text: 'v2', title: 'Review v2',
      buttons: [{ id: 'approve', text: 'Approve v2' }],
    }
    transport.chatIdForSession = () => 'oc_rebound'
    const rebound = await invoke(transport, 'PUT', `/notify/${notifyId}`, updateBody)
    expect(rebound.status).toBe(409)
    expect(rebound.json.error).toBe('notify_binding_changed')
    expect(transport.updates).toHaveLength(0)
    transport.chatIdForSession = () => 'oc_project'
    const updated = await invoke(transport, 'PUT', `/notify/${notifyId}`, updateBody)
    expect(updated.status).toBe(200)
    expect(updated.json).toMatchObject({
      notify_id: notifyId,
      message_id: 'om_original',
      transport_state: 'applied',
      version: 2,
      applied_version: 2,
    })
    expect(transport.updates).toHaveLength(1)
    expect(transport.updates[0].messageId).toBe('om_original')
    expect(JSON.stringify(transport.updates[0].card)).toContain('"version":2')

    expect((await invoke(transport, 'PUT', `/notify/${notifyId}`, updateBody)).json.applied_version).toBe(2)
    expect(transport.updates).toHaveLength(1)
    const conflicting = await invoke(transport, 'PUT', `/notify/${notifyId}`, { ...updateBody, text: 'conflict' })
    expect(conflicting.status).toBe(409)
    const stale = await invoke(transport, 'PUT', `/notify/${notifyId}`, { ...updateBody, version: 1, text: 'stale' })
    expect(stale.status).toBe(200)
    expect(stale.json.applied_version).toBe(2)
    expect(transport.updates).toHaveLength(1)

    transport.failPatches = 1
    const desiredV3 = { ...updateBody, version: 3, text: 'v3' }
    const failed = await invoke(transport, 'PUT', `/notify/${notifyId}`, desiredV3)
    expect(failed.status).toBe(202)
    expect(failed.json).toMatchObject({ transport_state: 'unknown', version: 3, applied_version: 2 })
    const patchAttempts = transport.updates.length
    __setStoreFileForTest(storeFile)
    loadCallbacks()
    const retried = await invoke(transport, 'PUT', `/notify/${notifyId}`, desiredV3)
    expect(retried.status).toBe(202)
    expect(retried.json).toMatchObject({ transport_state: 'unknown', version: 3, applied_version: 2 })
    expect(transport.updates).toHaveLength(patchAttempts)
  })

  test('version-bound text replies preserve the original operator/message result and stale controls cannot reopen it', async () => {
    const transport = fakeTransport()
    const created = await invoke(transport, 'POST', '/notify', {
      request_id: 'hub:instance:card-3', version: 4, project: 'project', text: 'Reply required', allow_reply: true,
      callback: 'http://127.0.0.1:9999/hook',
    })
    const notifyId = created.json.notify_id as string
    const reg = get(notifyId)!
    const dispatches: any[] = []
    const runtime = createNotifyReplyRuntime({
      sendCard: async () => 'om_prompt',
      updateCard: async () => {},
      sendText: async () => 'om_notice',
      dispatch: async (_registration, response, openId) => {
        dispatches.push({ response, openId })
        return { ok: true, detail: '200' }
      },
      onWaitingChanged: () => {},
      logError: () => {},
    })
    expect((await runtime.open(notifyId, reg.chatId, 'ou_operator', 3)).ok).toBe(false)
    expect((await runtime.open(notifyId, reg.chatId, 'ou_operator', 4)).ok).toBe(true)
    expect(await runtime.consume({
      chatId: reg.chatId,
      openId: 'ou_operator',
      messageId: 'om_user_reply',
      text: 'Use option B',
      createTime: Date.now(),
    })).toBe(true)
    expect(dispatches).toHaveLength(1)
    expect((await runtime.open(notifyId, reg.chatId, 'ou_operator', 4)).ok).toBe(false)
    const result = buildNotifyResult(get(notifyId)!) as any
    expect(result).toMatchObject({
      notify_id: notifyId,
      message_id: 'om_original',
      version: 4,
      applied_version: 4,
      resolved: true,
      resolved_by: 'ou_operator',
      response: {
        type: 'text',
        text: 'Use option B',
        message_id: 'om_user_reply',
        prompt_message_id: 'om_prompt',
      },
    })
    __setStoreFileForTest(storeFile)
    loadCallbacks()
    expect(buildNotifyResult(get(notifyId)!)).toMatchObject({
      resolved: true,
      resolved_by: 'ou_operator',
      message_id: 'om_original',
      version: 4,
      applied_version: 4,
    })
  })
})
