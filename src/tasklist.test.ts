import { describe, expect, test, beforeEach } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'

import './feishu-test-mock'
import { resetFeishuMock, feishuMockState, deleteTasklistCalls } from './feishu-test-mock'
import { TASKLIST_MAP_FILE } from './paths'
import {
  deleteTasklist,
  deleteTasklistRemoteIdempotently,
  enableTasklist,
  ensureTasklistSections,
  getTasklistBinding,
  isTasklistAlreadyDeletedError,
  markTasklistDeleting,
  mergeEnsuredTasklistSections,
  reconcileTasklistDeletions,
  withTasklistLifecycleLock,
  type TasklistBinding,
} from './tasklist'

function readDiskMap(): Record<string, any> {
  if (!existsSync(TASKLIST_MAP_FILE)) return {}
  return JSON.parse(readFileSync(TASKLIST_MAP_FILE, 'utf8'))
}

beforeEach(() => resetFeishuMock())

describe('tasklist lifecycle lock (upstream ec149d7)', () => {
  test('serializes same-project lifecycles while allowing different projects to overlap', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const events: string[] = []
    const first = withTasklistLifecycleLock('same', async () => {
      events.push('first:start')
      await firstGate
      events.push('first:end')
    })
    await Promise.resolve()
    const second = withTasklistLifecycleLock('same', async () => { events.push('second') })
    const other = withTasklistLifecycleLock('other', async () => { events.push('other') })
    await other
    expect(events).toEqual(['first:start', 'other'])
    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'other', 'first:end', 'second'])
  })

  test('releases the lock after an error so the next lifecycle can enter', async () => {
    await expect(withTasklistLifecycleLock('err-project', async () => {
      throw new Error('lifecycle probe failure')
    })).rejects.toThrow('lifecycle probe failure')
    await expect(withTasklistLifecycleLock('err-project', async () => 'recovered')).resolves.toBe('recovered')
  })
})

describe('tasklist deletion tombstone and idempotent remote delete (upstream ec149d7)', () => {
  test('keeps one durable delete intent and accepts only Feishu code 1470404 as already deleted', async () => {
    const binding: TasklistBinding = {
      guid: 'tl-1', name: 'n', url: '', projectName: 'p', ownerOpenId: 'ou',
    }
    markTasklistDeleting(binding, '2026-08-21T00:00:00Z')
    markTasklistDeleting(binding, '2026-08-22T00:00:00Z')
    expect(binding.deleting).toEqual({ requestedAt: '2026-08-21T00:00:00Z', attempts: 0 })
    expect(isTasklistAlreadyDeletedError(new Error('feishu tasklist.delete failed code=1470404 msg=resource not found'))).toBe(true)
    expect(isTasklistAlreadyDeletedError({ code: 1470404 })).toBe(true)
    expect(isTasklistAlreadyDeletedError(new Error('feishu tasklist.delete failed code=1470405 msg=forbidden'))).toBe(false)
    expect(isTasklistAlreadyDeletedError(new Error('resource not found'))).toBe(false)
    await expect(deleteTasklistRemoteIdempotently('tl-1', async () => {
      throw new Error('feishu tasklist.delete failed code=1470404 msg=resource not found')
    })).resolves.toBe('already_deleted')
    await expect(deleteTasklistRemoteIdempotently('tl-1', async () => {
      throw new Error('feishu tasklist.delete failed code=1470405 msg=forbidden')
    })).rejects.toThrow('1470405')
  })

  test('delete failure persists a durable tombstone and a retry hitting 1470404 finishes it', async () => {
    const projectName = 'tomb-retry'
    const created = await enableTasklist(projectName, 'oc_chat')
    expect(created.sections?.design).toBeTruthy()
    expect(readDiskMap()[projectName]?.guid).toBe(created.guid)

    // 第一次删除:远端失败(非 1470404)→ 墓碑落盘、错误上抛
    feishuMockState.deleteTasklistByGuid = async () => {
      throw new Error('feishu tasklist.delete failed code=99991663 msg=server error')
    }
    await expect(deleteTasklist(projectName, created.guid)).rejects.toThrow('99991663')
    const afterFail = getTasklistBinding(projectName)
    expect(afterFail?.deleting?.attempts).toBe(1)
    expect(afterFail?.deleting?.lastError).toContain('99991663')
    expect(readDiskMap()[projectName]?.deleting?.attempts).toBe(1)

    // 墓碑期间 enable/ensure 拒绝(生命周期互斥的删除挂起守卫)
    await expect(enableTasklist(projectName, 'oc_chat')).rejects.toThrow('deletion is pending')
    await expect(ensureTasklistSections(projectName)).rejects.toThrow('deletion is pending')

    // 重试:远端已删(1470404)→ 幂等成功,墓碑收尾,本地 binding 移除
    feishuMockState.deleteTasklistByGuid = async () => {
      throw new Error('feishu tasklist.delete failed code=1470404 msg=resource not found')
    }
    const finished = await deleteTasklist(projectName, created.guid)
    expect(finished.deleting?.attempts).toBe(2)
    expect(getTasklistBinding(projectName)).toBeNull()
    expect(readDiskMap()[projectName]).toBeUndefined()
  })

  test('reconcileTasklistDeletions retries pending tombstones at startup', async () => {
    const projectName = 'tomb-reconcile'
    const created = await enableTasklist(projectName, 'oc_chat')

    feishuMockState.deleteTasklistByGuid = async () => {
      throw new Error('feishu tasklist.delete failed code=99991663 msg=server error')
    }
    await expect(deleteTasklist(projectName, created.guid)).rejects.toThrow('99991663')
    expect(getTasklistBinding(projectName)?.deleting).toBeTruthy()

    // 重启后 worker 启动即重放墓碑:这次远端删除成功
    feishuMockState.deleteTasklistByGuid = null
    deleteTasklistCalls.length = 0
    await reconcileTasklistDeletions()
    expect(deleteTasklistCalls).toEqual([created.guid])
    expect(getTasklistBinding(projectName)).toBeNull()
    expect(readDiskMap()[projectName]).toBeUndefined()
  })

  test('reconcileTasklistDeletions keeps the tombstone and surfaces failures', async () => {
    const projectName = 'tomb-stuck'
    const created = await enableTasklist(projectName, 'oc_chat')
    feishuMockState.deleteTasklistByGuid = async () => {
      throw new Error('feishu tasklist.delete failed code=99991663 msg=server error')
    }
    await expect(deleteTasklist(projectName, created.guid)).rejects.toThrow('99991663')

    await expect(reconcileTasklistDeletions()).rejects.toThrow('tasklist deletion reconcile failed')
    expect(getTasklistBinding(projectName)?.deleting?.attempts).toBe(2)
    expect(readDiskMap()[projectName]?.deleting?.attempts).toBe(2)

    // 清理:成功收尾,避免跨用例状态残留
    feishuMockState.deleteTasklistByGuid = null
    await deleteTasklist(projectName, created.guid)
    expect(getTasklistBinding(projectName)).toBeNull()
  })
})

describe('tasklist section merge safety (upstream ec149d7)', () => {
  test('merges ensured sections into the latest binding without erasing concurrent task/process state', () => {
    const latest: TasklistBinding = {
      guid: 'tl-1', name: 'n', url: '', projectName: 'p', ownerOpenId: 'ou',
      sections: { design: 'old-design' },
      tasks: { task1: { guid: 'task1', summary: 'concurrent update' } },
      processes: {
        run1: {
          runId: 'run1', projectName: 'p', tasklistGuid: 'tl-1', kind: 'codex-plan',
          command: ['codex'], cwd: '/tmp', status: 'running', startedAt: '2026-08-21T00:00:00Z',
        },
      },
      worker: { lastScanAt: '2026-08-21T00:00:01Z' },
    }

    mergeEnsuredTasklistSections(latest, 'tl-1', { design: 'new-design', aiTodo: 'todo' })

    expect(latest.sections).toEqual({ design: 'new-design', aiTodo: 'todo' })
    expect(latest.tasks?.task1?.summary).toBe('concurrent update')
    expect(latest.processes?.run1?.status).toBe('running')
    expect(latest.worker?.lastScanAt).toBe('2026-08-21T00:00:01Z')
  })

  test('rejects merges when the binding changed or a deletion is pending', () => {
    const changed: TasklistBinding = {
      guid: 'tl-2', name: 'n', url: '', projectName: 'p', ownerOpenId: 'ou',
    }
    expect(() => mergeEnsuredTasklistSections(changed, 'tl-1', {})).toThrow('binding changed')
    const deleting: TasklistBinding = {
      guid: 'tl-1', name: 'n', url: '', projectName: 'p', ownerOpenId: 'ou',
      deleting: { requestedAt: '2026-08-21T00:00:00Z', attempts: 0 },
    }
    expect(() => mergeEnsuredTasklistSections(deleting, 'tl-1', {})).toThrow('deletion is pending')
  })
})
