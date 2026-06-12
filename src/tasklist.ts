import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { DATA_DIR, TASKLIST_MAP_FILE } from './paths'
import * as feishu from './feishu'
import { log } from './log'

export interface TasklistBinding {
  guid: string
  name: string
  url: string
  projectName: string
  ownerOpenId: string
  createdAt?: string
}

const bindings = new Map<string, TasklistBinding>()

loadTasklistMap()

export function tasklistNameForProject(projectName: string): string {
  return `${projectName}[lodestar]`
}

export function getTasklistBinding(projectName: string): TasklistBinding | null {
  return bindings.get(projectName) ?? null
}

export async function enableTasklist(projectName: string, chatId: string): Promise<TasklistBinding> {
  const existing = getTasklistBinding(projectName)
  if (existing) return existing

  const name = tasklistNameForProject(projectName)
  if (name.length > 100) throw new Error(`tasklist name is too long (${name.length}/100): ${name}`)

  const ownerOpenId = await feishu.fetchChatOwnerOpenId(chatId)
  const tasklist = await feishu.createTasklistWithOwner(name, ownerOpenId)

  const binding: TasklistBinding = {
    guid: tasklist.guid,
    name: tasklist.name,
    url: tasklist.url,
    projectName,
    ownerOpenId,
    createdAt: tasklist.createdAt,
  }
  bindings.set(projectName, binding)
  saveTasklistMap()
  return binding
}

export async function deleteTasklist(projectName: string, expectedGuid: string): Promise<TasklistBinding> {
  const binding = getTasklistBinding(projectName)
  if (!binding) throw new Error('tasklist is not enabled')
  if (binding.guid !== expectedGuid) {
    throw new Error(`tasklist binding changed: current=${binding.guid} requested=${expectedGuid}`)
  }
  await feishu.deleteTasklistByGuid(binding.guid)
  bindings.delete(projectName)
  saveTasklistMap()
  return binding
}

function loadTasklistMap(): void {
  if (!existsSync(TASKLIST_MAP_FILE)) return
  try {
    const obj = JSON.parse(readFileSync(TASKLIST_MAP_FILE, 'utf8'))
    if (!obj || typeof obj !== 'object') return
    for (const [projectName, raw] of Object.entries(obj)) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Partial<TasklistBinding>
      if (typeof item.guid !== 'string' || !item.guid) continue
      if (typeof item.name !== 'string' || !item.name) continue
      bindings.set(projectName, {
        guid: item.guid,
        name: item.name,
        url: typeof item.url === 'string' ? item.url : '',
        projectName,
        ownerOpenId: typeof item.ownerOpenId === 'string' ? item.ownerOpenId : '',
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : undefined,
      })
    }
    log(`tasklist: loaded ${bindings.size} project bindings`)
  } catch (e) {
    log(`tasklist: load map failed: ${e}`)
  }
}

function saveTasklistMap(): void {
  try {
    const obj: Record<string, TasklistBinding> = {}
    for (const [projectName, binding] of bindings) obj[projectName] = binding
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(TASKLIST_MAP_FILE, JSON.stringify(obj, null, 2))
  } catch (e) {
    log(`tasklist: save map failed: ${e}`)
  }
}
