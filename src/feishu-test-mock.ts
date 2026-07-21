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
export const urgentPushes: Array<[string, string[]]> = []
/** [projects.<name>] 项目 profile 替身,测试往里 set 后 Session 构造时可查到。 */
export const projectProfiles = new Map<string, { cwd?: string; watchdogMode?: WatchdogMode }>()
/** chatIdForSession 替身返回值,测试可改。 */
export const feishuMockState = {
  chatIdForSession: null as string | null,
  sendCard: null as null | ((chatId: string, card: object) => Promise<string | null>),
}

export function resetFeishuMock(): void {
  for (const arr of [sentCards, sentTexts, sentRawTexts, updatedCards, addedReactions, deletedReactions, boundResumes, clearedTurnAnchors, urgentPushes]) {
    arr.length = 0
  }
  projectProfiles.clear()
  feishuMockState.chatIdForSession = null
  feishuMockState.sendCard = null
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
  // 临时群 / fork / back / rs 恢复相关 stub(测试不验证这些路径,no-op / 空返回)
  tempProjectName: () => null,
  tempChatName: (project: string) => `${project}*0000-0000`,
  appendTurnAnchor: () => {},
  getTurnAnchors: () => [],
  truncateTurnAnchors: () => {},
  seedTurnAnchors: () => {},
  clearTurnAnchors: (sessionName: string) => { clearedTurnAnchors.push(sessionName) },
  ensureChatForSession: async (chatName: string) => ({ chatId: `oc_${chatName}`, created: true, joined: true }),
  disbandChatForSession: async () => ({ chatId: null, disbanded: true }),
}))
