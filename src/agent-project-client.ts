import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { AGENT_OPERATOR_CLIENT_FILE, AGENT_PROJECT_CLIENT_FILE } from './paths'
import { writeJsonStateAtomic } from './state-store'

export interface AgentProjectClient { baseUrl: string; capability: string }
export interface AgentOperatorClient { baseUrl: string; capability: string }

export function createAgentProjectClient(baseUrl: string, path = AGENT_PROJECT_CLIENT_FILE): AgentProjectClient {
  const client = { baseUrl, capability: randomBytes(32).toString('base64url') }
  writeJsonStateAtomic(path, client)
  return client
}

export function createAgentOperatorClient(baseUrl: string, path = AGENT_OPERATOR_CLIENT_FILE): AgentOperatorClient {
  const client = { baseUrl, capability: randomBytes(32).toString('base64url') }
  writeJsonStateAtomic(path, client)
  return client
}

export function readAgentProjectClient(path = AGENT_PROJECT_CLIENT_FILE): AgentProjectClient {
  return readLocalClient(path, '项目调用')
}

export function readAgentOperatorClient(path = AGENT_OPERATOR_CLIENT_FILE): AgentOperatorClient {
  return readLocalClient(path, '本机操作员')
}

function readLocalClient(path: string, label: string): AgentProjectClient {
  let raw: string
  try { raw = readFileSync(path, 'utf8') }
  catch (error) { throw new Error(`无法读取${label}凭据 ${path}；请确认 daemon 已启动并支持项目调用: ${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
  const client = JSON.parse(raw)
  if (!client || typeof client.baseUrl !== 'string' || typeof client.capability !== 'string' || !client.capability) {
    throw new Error(`${label}凭据文件无效`)
  }
  const url = new URL(client.baseUrl)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${label}只支持本机 loopback daemon 地址`)
  }
  return { baseUrl: client.baseUrl.replace(/\/+$/, ''), capability: client.capability }
}

export function acceptsProjectCapability(client: AgentProjectClient, value: string): boolean {
  return acceptsLocalCapability(client, value)
}

export function acceptsOperatorCapability(client: AgentOperatorClient, value: string): boolean {
  return acceptsLocalCapability(client, value)
}

function acceptsLocalCapability(client: AgentProjectClient, value: string): boolean {
  const actual = Buffer.from(value)
  const expected = Buffer.from(client.capability)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
