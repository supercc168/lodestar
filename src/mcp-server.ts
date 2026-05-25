/**
 * Lodestar MCP server — daemon-hosted, project-scoped.
 *
 * Exposes 4 scheduling tools to whichever Codex thread connects:
 *   schedule_create  — recurring cron-based schedule
 *   schedule_once    — one-shot delayed schedule
 *   schedule_list    — list this project's schedules
 *   schedule_delete  — remove one by id (project-scoped, can't delete others)
 *
 * Transport: MCP Streamable HTTP, response body always plain JSON (no
 * SSE — our tools are all request/response, no server→client push).
 * Project scoping is encoded in the URL path: `/mcp/<project>` —
 * daemon hands each spawned Codex thread an `mcp_servers` config pointing at
 * the right path, so the subprocess can't reach other projects' state
 * even if the prompt asks it to.
 *
 * No auth — same security tier as `/notify`: loopback only, trusts
 * anything able to hit 127.0.0.1:9876.
 *
 * Protocol version: `2025-06-18` (or whatever the client requests; we
 * echo back what they sent unless it's unrecognized in which case we
 * pin to a known-good version).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { log } from './log'
import * as feishu from './feishu'
import {
  createSchedule,
  listSchedules,
  deleteSchedule,
  type Schedule,
  type ScheduleMode,
  type ScheduleLevel,
} from './schedule'

const PROTOCOL_VERSION = '2025-06-18'
const SERVER_INFO = { name: 'lodestar', version: '0.4.0' }

// ── JSON-RPC envelope helpers ────────────────────────────────────────
interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: any
}

interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: number | string | null
  result: any
}

interface JsonRpcError {
  jsonrpc: '2.0'
  id: number | string | null
  error: { code: number; message: string; data?: any }
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError

function rpcError(id: number | string | null, code: number, message: string, data?: any): JsonRpcError {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }
}

function rpcSuccess(id: number | string | null, result: any): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result }
}

// ── Tool definitions ────────────────────────────────────────────────
// JSON Schema for each tool's input. Descriptions are user-facing —
// Codex reads them at tools/list time and decides when to call.

const SCHEDULE_CREATE_SCHEMA = {
  type: 'object',
  properties: {
    cron: {
      type: 'string',
      description: '5-field cron expression: "m h dom mon dow". Examples: "0 9 * * *" (every day 9am), "*/15 * * * *" (every 15 min), "0 3 * * 1" (every Monday 3am). Local timezone.',
    },
    prompt: {
      type: 'string',
      description: 'The exact text Codex will see as the first user message when this schedule fires. Each fire spawns a fresh Codex thread (no resumed session, no prior conversation context) — write the prompt as if Codex is seeing this group for the first time.',
    },
    mode: {
      type: 'string',
      enum: ['silent', 'verbose'],
      description: '"silent" (default): only the final assistant text is posted as a single notification card. "verbose": full transcript card (prompt, assistant segments, every tool call with input+output, result meta). Use silent for routine reports; verbose when you want to occasionally inspect what the schedule is actually doing.',
    },
    level: {
      type: 'string',
      enum: ['info', 'warn', 'error'],
      description: 'Card template color. "info" (default, blue), "warn" (yellow), "error" (red). Pure visual hint to the human reader.',
    },
    name: {
      type: 'string',
      description: 'Human-readable label shown in the card header (`⏰ <name>`) and `schedule_list`. Defaults to the first 8 hex chars of the id if omitted.',
    },
  },
  required: ['cron', 'prompt'],
}

const SCHEDULE_ONCE_SCHEMA = {
  type: 'object',
  properties: {
    delaySeconds: {
      type: 'number',
      description: 'Seconds from now until firing. Must be ≥ 0. For "remind me in 10 minutes" use 600.',
    },
    prompt: {
      type: 'string',
      description: 'See schedule_create.prompt — same fresh-process semantics.',
    },
    mode:  { type: 'string', enum: ['silent', 'verbose'], description: 'See schedule_create.mode' },
    level: { type: 'string', enum: ['info', 'warn', 'error'], description: 'See schedule_create.level' },
    name:  { type: 'string', description: 'See schedule_create.name' },
  },
  required: ['delaySeconds', 'prompt'],
}

const SCHEDULE_LIST_SCHEMA = {
  type: 'object',
  properties: {},
}

const SCHEDULE_DELETE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Schedule id (from schedule_list). Can only delete schedules belonging to this project.' },
  },
  required: ['id'],
}

const TOOLS = [
  {
    name: 'schedule_create',
    description: 'Create a recurring scheduled task for this project. The schedule fires on a cron expression and spawns a fresh Codex thread each time (cwd = the project directory, no resumed session, no accumulated context). Use this when you want: (1) the schedule to survive process restarts via daemon persistence, (2) each fire to start from a clean slate rather than accumulating context across runs, (3) the schedule to be visible to humans via the dashboard. Returns the created Schedule with its id.',
    inputSchema: SCHEDULE_CREATE_SCHEMA,
  },
  {
    name: 'schedule_once',
    description: 'Create a one-shot delayed task. Same fresh-process semantics as schedule_create, but fires once after `delaySeconds` and is then deleted. Use this for "remind me later", "check status in 10 minutes", or anywhere ScheduleWakeup would fit but you want the same persistence/freshness guarantees.',
    inputSchema: SCHEDULE_ONCE_SCHEMA,
  },
  {
    name: 'schedule_list',
    description: "List all of this project's schedules. Returns id, name, cron|fireAt, mode, level, prompt, nextFireAt (ms unix), lastFiredAt (ms unix or absent).",
    inputSchema: SCHEDULE_LIST_SCHEMA,
  },
  {
    name: 'schedule_delete',
    description: 'Delete a schedule by id. Project-scoped: returns false if the id belongs to a different project.',
    inputSchema: SCHEDULE_DELETE_SCHEMA,
  },
]

// ── Tool dispatch ────────────────────────────────────────────────────
function formatSchedule(s: Schedule): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    project: s.project,
    prompt: s.prompt,
    mode: s.mode,
    level: s.level,
    cron: s.cron,
    fireAt: s.fireAt,
    nextFireAt: s.nextFireAt,
    nextFireAtIso: new Date(s.nextFireAt).toISOString(),
    lastFiredAt: s.lastFiredAt,
    createdAt: s.createdAt,
  }
}

function textContent(obj: unknown): any {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] }
}

function errorContent(message: string): any {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function callTool(project: string, name: string, args: any): any {
  args = args ?? {}
  try {
    switch (name) {
      case 'schedule_create': {
        const s = createSchedule({
          project,
          prompt: String(args.prompt ?? ''),
          cron: String(args.cron ?? ''),
          mode: (args.mode as ScheduleMode) ?? undefined,
          level: (args.level as ScheduleLevel) ?? undefined,
          name: args.name ? String(args.name) : undefined,
        })
        return textContent(formatSchedule(s))
      }
      case 'schedule_once': {
        const s = createSchedule({
          project,
          prompt: String(args.prompt ?? ''),
          delaySeconds: Number(args.delaySeconds),
          mode: (args.mode as ScheduleMode) ?? undefined,
          level: (args.level as ScheduleLevel) ?? undefined,
          name: args.name ? String(args.name) : undefined,
        })
        return textContent(formatSchedule(s))
      }
      case 'schedule_list': {
        const items = listSchedules(project).map(formatSchedule)
        return textContent({ count: items.length, schedules: items })
      }
      case 'schedule_delete': {
        const id = String(args.id ?? '')
        if (!id) return errorContent('id required')
        const ok = deleteSchedule(id, project)
        return textContent({ ok, id, project })
      }
      default:
        return errorContent(`unknown tool: ${name}`)
    }
  } catch (e: any) {
    // createSchedule throws on bad cron / missing fields — surface as
    // isError so Codex sees the validation message and can retry.
    return errorContent(`${e?.message ?? e}`)
  }
}

// ── JSON-RPC method dispatch ─────────────────────────────────────────
function handleRpc(project: string, req: JsonRpcRequest): JsonRpcResponse | null {
  const id = req.id ?? null
  switch (req.method) {
    case 'initialize': {
      // Echo back the client's requested protocol version when sane;
      // otherwise pin to PROTOCOL_VERSION. The minimal set of
      // capabilities — we expose tools and nothing else (no resources,
      // no prompts, no logging).
      const clientVer = typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : null
      const proto = clientVer && /^\d{4}-\d{2}-\d{2}$/.test(clientVer) ? clientVer : PROTOCOL_VERSION
      return rpcSuccess(id, {
        protocolVersion: proto,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
    }
    case 'notifications/initialized': {
      // No response (notification — no id). Caller will treat null as "skip".
      return null
    }
    case 'tools/list': {
      return rpcSuccess(id, { tools: TOOLS })
    }
    case 'tools/call': {
      const name = String(req.params?.name ?? '')
      const args = req.params?.arguments ?? {}
      if (!name) return rpcError(id, -32602, 'missing tool name')
      const result = callTool(project, name, args)
      return rpcSuccess(id, result)
    }
    case 'ping':
      return rpcSuccess(id, {})
    default:
      // Unknown method — JSON-RPC standard "method not found"
      if (req.id === undefined || req.id === null) return null  // unknown notification, silently drop
      return rpcError(id, -32601, `method not found: ${req.method}`)
  }
}

// ── HTTP entry ───────────────────────────────────────────────────────
export async function handleMcpRequest(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Extract project from path: `/mcp/<project>` — anything after a
  // trailing slash is rejected (we don't support sub-paths).
  const pathTail = url.pathname.slice('/mcp/'.length)
  const projectRaw = decodeURIComponent(pathTail.replace(/\/$/, ''))
  if (!projectRaw || projectRaw.includes('/')) {
    res.statusCode = 404
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end('expected POST /mcp/<project>')
    return
  }
  const project = feishu.sanitizeSessionName(projectRaw)

  if (req.method === 'GET') {
    // Some MCP clients probe with GET. We don't open an SSE stream — no
    // server→client push needed. Return a one-liner so the client
    // doesn't 404 and gives up.
    res.statusCode = 405
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.setHeader('allow', 'POST')
    res.end('lodestar MCP: POST JSON-RPC requests to this URL')
    return
  }
  if (req.method !== 'POST') {
    res.statusCode = 405
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.setHeader('allow', 'POST')
    res.end('use POST')
    return
  }

  let raw = ''
  for await (const chunk of req) raw += chunk.toString()
  let body: any
  try { body = JSON.parse(raw) }
  catch {
    res.statusCode = 400
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(rpcError(null, -32700, 'parse error')))
    return
  }

  const isBatch = Array.isArray(body)
  const reqs: JsonRpcRequest[] = isBatch ? body : [body]
  const responses: JsonRpcResponse[] = []
  for (const r of reqs) {
    if (!r || typeof r !== 'object' || r.jsonrpc !== '2.0' || typeof r.method !== 'string') {
      responses.push(rpcError((r as any)?.id ?? null, -32600, 'invalid request'))
      continue
    }
    try {
      const resp = handleRpc(project, r)
      if (resp) responses.push(resp)
    } catch (e: any) {
      responses.push(rpcError(r.id ?? null, -32603, `internal error: ${e?.message ?? e}`))
    }
  }

  log(`mcp: project=${project} method(s)=[${reqs.map(r => r?.method).join(',')}] → ${responses.length} response(s)`)

  // Batch in → batch out (filtered for non-notifications). All-notifications
  // batch → 202 Accepted with no body, per JSON-RPC 2.0 + MCP HTTP transport.
  res.setHeader('content-type', 'application/json')
  if (responses.length === 0) {
    res.statusCode = 202
    res.end()
    return
  }
  res.statusCode = 200
  res.end(JSON.stringify(isBatch ? responses : responses[0]))
}
