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
import type { TurnAnchor } from './feishu'
import type { ConversationBranchBase, ConversationRef, PendingConversationLaunch } from './conversation'

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
/** clearSessionResume(Checked) 调用捕获(上游 ff44afb fork 面)。 */
export const clearedResumes: Array<[string, string | undefined]> = []
/** session fork/back 测试用内存 turn-map V4 容器与 mutation 记录(上游 ff44afb)。 */
export const turnAnchorsBySession = new Map<string, TurnAnchor[]>()
export const seededTurnAnchors: Array<[string, TurnAnchor[]]> = []
export const branchBaseBySession = new Map<string, ConversationBranchBase>()
export const pendingConversationLaunchBySession = new Map<string, PendingConversationLaunch>()
/** resume map ConversationRef 容器,key = `${sessionName}:${provider}`(上游 ff44afb)。 */
export const resumeRefs = new Map<string, ConversationRef>()
/** 写失败注入缝(挂账 #6,上游 ff44afb + 4185808 终态):checked stub 首行
 *  `if (xxxWriteError) throw xxxWriteError`,供 'result still terminalizes…'
 *  类用例驱动持久化失败路径。resetFeishuMock() 复位为 null。 */
let resumeWriteError: Error | null = null
export function setResumeWriteError(error: Error | null): void { resumeWriteError = error }
let turnAnchorWriteError: Error | null = null
export function setTurnAnchorWriteError(error: Error | null): void { turnAnchorWriteError = error }
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
/** 持久化 model selection 替身(4185808 constructor 恢复区用例:构造期 provider
 *  由此决定;既有用例不 set → null,行为零变化)。 */
export const modelSelections = new Map<string, { provider: string; model: string | null; effort: string | null }>()
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
  /** updateCard 替身钩子(01-14 / 上游 7c14677 setUpdateCardHandler:迁移快照
   *  竞态用例在 updateCard await 窗口内注入 task 终态)。 */
  updateCard: null as null | ((messageId: string, card: object) => Promise<void>),
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
  for (const arr of [clearedResumes, seededTurnAnchors]) {
    arr.length = 0
  }
  projectProfiles.clear()
  modelSelections.clear()
  resumeRefs.clear()
  turnAnchorsBySession.clear()
  branchBaseBySession.clear()
  pendingConversationLaunchBySession.clear()
  resumeWriteError = null
  turnAnchorWriteError = null
  feishuMockState.chatIdForSession = null
  feishuMockState.sendCard = null
  feishuMockState.deleteTasklistByGuid = null
  feishuMockState.listSectionTasks = null
  feishuMockState.turnAnchors = []
  feishuMockState.updateCard = null
}

/** bindSessionResume(Checked) 双形态入参归一(与真实 sessionResumeRefFromArgs 同语义:
 *  string 老签名缺 cwd → cwd:null;ref 对象原样)。 */
function normalizeResumeArgs(
  sessionIdOrRef: string | ConversationRef,
  provider?: string,
  cwd?: string,
): ConversationRef {
  if (typeof sessionIdOrRef !== 'string') return sessionIdOrRef
  return {
    provider: (provider ?? 'codex') as ConversationRef['provider'],
    sessionId: sessionIdOrRef,
    cwd: cwd ?? null,
  }
}

/** getTurnAnchors 容器路径的 uuid/sid 读投影(与真实 feishu.ts PHASE4-TRANSITION
 *  投影同形:uuid=checkpoint.id、sid=checkpoint.source.sessionId)。 */
function projectAnchors(anchors: TurnAnchor[]): Array<TurnAnchor & { uuid: string; sid: string }> {
  return anchors.map(a => ({ ...a, uuid: a.checkpoint.id, sid: a.checkpoint.source.sessionId }))
}

mock.module('./feishu', () => ({
  PROJECTS_ROOT: '/tmp/lodestar-projects',
  getSessionResume: (sessionName: string, provider = 'codex') =>
    resumeRefs.get(`${sessionName}:${provider}`)?.sessionId ?? null,
  getSessionResumeRef: (sessionName: string, provider = 'codex') => {
    const ref = resumeRefs.get(`${sessionName}:${provider}`)
    return ref ? { ...ref } : null
  },
  getSessionModelSelection: (sessionName: string) => modelSelections.get(sessionName) ?? null,
  /** listCodexConversations/start 的登录门替身:默认已登录(与真实导出同名同签名)。 */
  isOpenAIChatGPTAuthenticated: () => true,
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
  bindSessionResume: (sessionName: string, sessionIdOrRef: string | ConversationRef, provider?: string, cwd?: string) => {
    const normalized = normalizeResumeArgs(sessionIdOrRef, provider, cwd)
    boundResumes.push([
      sessionName,
      normalized.sessionId,
      typeof sessionIdOrRef === 'string' ? provider : normalized.provider,
    ])
    resumeRefs.set(`${sessionName}:${normalized.provider}`, normalized)
  },
  bindSessionResumeChecked: (sessionName: string, sessionIdOrRef: string | ConversationRef, provider?: string, cwd?: string) => {
    if (resumeWriteError) throw resumeWriteError
    const normalized = normalizeResumeArgs(sessionIdOrRef, provider, cwd)
    boundResumes.push([
      sessionName,
      normalized.sessionId,
      typeof sessionIdOrRef === 'string' ? provider : normalized.provider,
    ])
    resumeRefs.set(`${sessionName}:${normalized.provider}`, normalized)
  },
  clearSessionResume: (sessionName: string, provider?: string) => {
    clearedResumes.push([sessionName, provider])
    if (provider) resumeRefs.delete(`${sessionName}:${provider}`)
    else for (const p of ['codex', 'claude']) resumeRefs.delete(`${sessionName}:${p}`)
  },
  clearSessionResumeChecked: (sessionName: string, provider?: string) => {
    if (resumeWriteError) throw resumeWriteError
    clearedResumes.push([sessionName, provider])
    if (provider) resumeRefs.delete(`${sessionName}:${provider}`)
    else for (const p of ['codex', 'claude']) resumeRefs.delete(`${sessionName}:${p}`)
  },
  bindSessionModel: () => {},
  bindSessionModelChecked: () => {},
  provisionProject: () => {},
  projectProfile: (name: string) => projectProfiles.get(name),
  updateCard: async (messageId: string, card: object) => {
    updatedCards.push([messageId, card])
    if (feishuMockState.updateCard) await feishuMockState.updateCard(messageId, card)
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
  // 临时群 / fork / back / rs 相关 stub(V4 容器 + checked 系列,上游 ff44afb/4185808;
  // feishuMockState.turnAnchors 为既有 V1 显式替身,优先于容器返回——01-10 用例零改动)
  // 与真实实现同一正则(ff44afb 簇 4 workDir 三形态用例依赖真实剥后缀语义;
  // 既有用例全部使用普通群名 → 恒 null,行为零变化)。
  tempProjectName: (sessionName: string) =>
    /\*[0-9]{4}-[0-9]{4}(-[0-9]+)?$/.test(sessionName)
      ? sessionName.replace(/\*[0-9]{4}-[0-9]{4}(-[0-9]+)?$/, '')
      : null,
  tempChatName: (project: string, additionallyUsed: Iterable<string> = []) => {
    const used = new Set(additionallyUsed)
    let name = `${project}*0000-0000`
    for (let seq = 2; used.has(name); seq++) name = `${project}*0000-0000-${seq}`
    return name
  },
  appendTurnAnchorChecked: (sessionName: string, anchor: TurnAnchor) => {
    if (turnAnchorWriteError) throw turnAnchorWriteError
    const current = turnAnchorsBySession.get(sessionName) ?? []
    turnAnchorsBySession.set(sessionName, [...current, anchor])
  },
  getTurnAnchors: (sessionName: string) => feishuMockState.turnAnchors.length
    ? feishuMockState.turnAnchors
    : projectAnchors(turnAnchorsBySession.get(sessionName) ?? []),
  getSessionBranchBase: (sessionName: string) => branchBaseBySession.get(sessionName) ?? null,
  getPendingConversationLaunch: (sessionName: string) =>
    pendingConversationLaunchBySession.get(sessionName) ?? null,
  setPendingConversationLaunchChecked: (sessionName: string, pending: PendingConversationLaunch | null) => {
    if (turnAnchorWriteError) throw turnAnchorWriteError
    if (pending) pendingConversationLaunchBySession.set(sessionName, pending)
    else pendingConversationLaunchBySession.delete(sessionName)
  },
  truncateTurnAnchors: (sessionName: string, fromIdx: number) => {
    truncatedTurnAnchors.push([sessionName, fromIdx])
    const current = turnAnchorsBySession.get(sessionName)
    if (current && current.length > fromIdx) {
      turnAnchorsBySession.set(sessionName, current.slice(0, fromIdx))
    }
  },
  seedTurnAnchors: (sessionName: string, anchors: TurnAnchor[]) => {
    const copied = anchors.slice()
    seededTurnAnchors.push([sessionName, copied])
    if (copied.length > 0) turnAnchorsBySession.set(sessionName, copied)
  },
  replaceTurnAnchors: (
    sessionName: string,
    anchors: TurnAnchor[],
    base: ConversationBranchBase,
    pending?: PendingConversationLaunch | null,
  ) => {
    if (turnAnchorWriteError) throw turnAnchorWriteError
    clearedTurnAnchors.push(sessionName)
    // 写入口剥回流字段(与真实 canonicalTurnAnchor 同语义):getTurnAnchors 投影
    // (uuid/sid)round-trip 回写时不得污染容器——rollbackTo restore 快照依赖。
    const copied = anchors.map(a => ({ checkpoint: a.checkpoint, preview: a.preview, ts: a.ts, writes: a.writes }))
    seededTurnAnchors.push([sessionName, copied])
    turnAnchorsBySession.set(sessionName, copied)
    branchBaseBySession.set(sessionName, base)
    if (pending !== undefined) {
      if (pending) pendingConversationLaunchBySession.set(sessionName, pending)
      else pendingConversationLaunchBySession.delete(sessionName)
    }
  },
  ensureChatForSession: async (chatName: string) => ({ chatId: `oc_${chatName}`, created: true, joined: true }),
  disbandChatForSession: async () => ({ chatId: null, disbanded: true }),
}))
