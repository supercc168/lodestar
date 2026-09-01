/**
 * 共享的 ./feishu 测试替身(仅供 *.test.ts import)。
 *
 * bun 的 mock.module 是进程级注册:多个测试文件各自 mock('./feishu')
 * 时,后加载的会就地覆盖先加载的 —— cardkit.test.ts 的窄 mock(只有
 * getTenantToken)曾把 session.test.ts 的全量 mock 顶掉,导致
 * `bun test src/` 单进程全跑时 Session 构造函数炸
 * getSessionModelSelection。收敛为这一个模块后,模块缓存保证
 * mock.module 只注册一次,加载顺序不再影响结果。
 *
 * 捕获数组是共享可变状态,测试文件在 beforeEach 里调 resetFeishuMock()。
 */
import { mock } from 'bun:test'
import type { WatchdogMode } from './turn-watchdog'

export const sentCards: object[] = []
export const sentTexts: string[] = []
export const sentRawTexts: string[] = []
export const updatedCards: Array<[string, object]> = []
export const addedReactions: Array<[string, string]> = []
export const deletedReactions: Array<[string, string]> = []
export const boundResumes: Array<[string, string, string | undefined]> = []
export const clearedTurnAnchors: string[] = []
/** truncateTurnAnchors 调用捕获(01-10 / ec149d7 主题 I:bk 回滚成功才截断,
 *  失败零截断是 D-02 保护线判据)。beforeEach 调 resetFeishuMock() 清空。 */
export const truncatedTurnAnchors: Array<[string, number]> = []
export const urgentPushes: Array<[string, string[]]> = []
/** task v2 list 调用捕获(测 tasklist-worker 的 scanTaskSections 调用预算:每个 section
 *  只能拉一次,防双重拉取回归——上游 2026-07-30 配额审查)。beforeEach 调 resetFeishuMock() 清空。 */
export const listSectionTasksCalls: Array<[string, boolean | undefined]> = []
export const listTasklistSectionsCalls: string[] = []
export const listTasklistTasksCalls: Array<[string, boolean | undefined]> = []
/** tasklist 生命周期调用捕获(01-06 / 上游 ec149d7:删除墓碑、幂等远端删除、
 *  section 迁移与评论)。beforeEach 调 resetFeishuMock() 清空。 */
export const deleteTasklistCalls: string[] = []
export const movedTasks: Array<[string, string, string]> = []
export const addedTaskComments: Array<[string, string]> = []
/** [projects.<name>] 项目 profile 替身,测试往里 set 后 Session 构造时可查到。 */
export const projectProfiles = new Map<string, { cwd?: string; watchdogMode?: WatchdogMode }>()
/** chatIdForSession 替身返回值,测试可改。 */
export const feishuMockState = {
  chatIdForSession: null as string | null,
  sendCard: null as null | ((chatId: string, card: object) => Promise<string | null>),
  /** 远端删除替身覆盖:抛错模拟删除失败(如 code=1470404 already deleted)。 */
  deleteTasklistByGuid: null as null | ((guid: string) => Promise<void>),
  /** listSectionTasks 覆盖:测试可让扫描挂起(轮转上限用例)或返回定制任务。 */
  listSectionTasks: null as null | ((guid: string, completed?: boolean) => Promise<unknown[]>),
  /** getTurnAnchors 替身返回值(01-10:fk/bk 选择处理需要非空锚点走成功路径)。 */
  turnAnchors: [] as Array<{ uuid: string; sid: string; preview: string; ts: number; writes: unknown[] }>,
}

export function resetFeishuMock(): void {
  for (const arr of [sentCards, sentTexts, sentRawTexts, updatedCards, addedReactions, deletedReactions, boundResumes, clearedTurnAnchors, truncatedTurnAnchors, urgentPushes]) {
    arr.length = 0
  }
  for (const arr of [listSectionTasksCalls, listTasklistSectionsCalls, listTasklistTasksCalls]) {
    arr.length = 0
  }
  for (const arr of [deleteTasklistCalls, movedTasks, addedTaskComments]) {
    arr.length = 0
  }
  projectProfiles.clear()
  feishuMockState.chatIdForSession = null
  feishuMockState.sendCard = null
  feishuMockState.deleteTasklistByGuid = null
  feishuMockState.listSectionTasks = null
  feishuMockState.turnAnchors = []
}

mock.module('./feishu', () => ({
  PROJECTS_ROOT: '/tmp/lodestar-projects',
  getSessionResume: () => null,
  getSessionModelSelection: () => null,
  getTenantToken: async () => 'tenant-token',
  preferredChatForSession: new Map(),
  sendCard: async (chatId: string, card: object) => {
    sentCards.push(card)
    if (feishuMockState.sendCard) return await feishuMockState.sendCard(chatId, card)
    return `om_status_${sentCards.length}`
  },
  sendText: async (_chatId: string, text: string) => {
    sentTexts.push(text)
    return 'om_text'
  },
  sendTextRaw: async (_chatId: string, text: string) => {
    sentRawTexts.push(text)
    return 'om_raw'
  },
  deleteReaction: async (messageId: string, reactionId: string) => {
    deletedReactions.push([messageId, reactionId])
  },
  addReaction: async (messageId: string, reactionType: string) => {
    addedReactions.push([messageId, reactionType])
    return `reaction-${messageId}`
  },
  urgentApp: async (messageId: string, openIds: string[]) => {
    urgentPushes.push([messageId, openIds])
  },
  listSectionTasks: async (guid: string, completed?: boolean) => {
    listSectionTasksCalls.push([guid, completed])
    if (feishuMockState.listSectionTasks) return await feishuMockState.listSectionTasks(guid, completed)
    return []
  },
  listTasklistSections: async (guid: string) => {
    listTasklistSectionsCalls.push(guid)
    return []
  },
  listTasklistTasks: async (guid: string, completed?: boolean) => {
    listTasklistTasksCalls.push([guid, completed])
    return []
  },
  bindSessionResume: (sessionName: string, sessionId: string, provider?: string) => {
    boundResumes.push([sessionName, sessionId, provider])
  },
  bindSessionModel: () => {},
  provisionProject: () => {},
  projectProfile: (name: string) => projectProfiles.get(name),
  updateCard: async (messageId: string, card: object) => {
    updatedCards.push([messageId, card])
  },
  chatIdForSession: (_sessionName: string) => feishuMockState.chatIdForSession,
  // tasklist 生命周期(01-06 / ec149d7:enable/delete/reconcile 全流程可在测试内走真实 tasklist.ts)
  resolveProjectDir: (projectName: string) => `/tmp/lodestar-projects/${projectName}`,
  fetchChatOwnerOpenId: async (_chatId: string) => 'ou_owner',
  createTasklistWithOwner: async (name: string, _ownerOpenId: string) => ({
    guid: `tl_${name}`, name, url: '', createdAt: '2026-09-01T00:00:00Z',
  }),
  deleteTasklistByGuid: async (guid: string) => {
    deleteTasklistCalls.push(guid)
    if (feishuMockState.deleteTasklistByGuid) return await feishuMockState.deleteTasklistByGuid(guid)
  },
  discoverTasklistDefaultSectionGuid: async (tasklistGuid: string) => `sec_design_${tasklistGuid}`,
  getTasklistSection: async (sectionGuid: string) => ({ guid: sectionGuid, name: '设计中', isDefault: true }),
  patchTasklistSectionName: async (sectionGuid: string, name: string) => ({ guid: sectionGuid, name, isDefault: true }),
  createTasklistSection: async (opts: { tasklistGuid: string; name: string; insertAfter?: string }) =>
    `sec_${opts.name}_${opts.tasklistGuid}`,
  deleteTasklistSection: async (_sectionGuid: string) => {},
  moveTaskToSection: async (taskGuid: string, tasklistGuid: string, sectionGuid: string) => {
    movedTasks.push([taskGuid, tasklistGuid, sectionGuid])
  },
  getTask: async (taskGuid: string) => ({ guid: taskGuid, summary: `task ${taskGuid}` }),
  listTaskComments: async (_taskGuid: string) => [],
  addTaskComment: async (taskGuid: string, content: string) => {
    addedTaskComments.push([taskGuid, content])
    return `comment_${addedTaskComments.length}`
  },
  // 临时群 / fork / back / rs 恢复相关 stub(测试不验证这些路径,no-op / 空返回)
  tempProjectName: () => null,
  tempChatName: (project: string) => `${project}*0000-0000`,
  appendTurnAnchor: () => {},
  getTurnAnchors: () => feishuMockState.turnAnchors,
  truncateTurnAnchors: (sessionName: string, fromIdx: number) => {
    truncatedTurnAnchors.push([sessionName, fromIdx])
  },
  seedTurnAnchors: () => {},
  clearTurnAnchors: (sessionName: string) => { clearedTurnAnchors.push(sessionName) },
  ensureChatForSession: async (chatName: string) => ({ chatId: `oc_${chatName}`, created: true, joined: true }),
  disbandChatForSession: async () => ({ chatId: null, disbanded: true }),
}))
