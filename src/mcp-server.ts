/**
 * Lodestar schedule MCP server — daemon-hosted, project-scoped.
 *
 * Exposes 4 scheduling tools to whichever Codex thread connects. These are
 * intentionally narrow: create/list/delete daemon-owned future Codex runs for
 * this project. The MCP server name is `lodestar_schedule`.
 *
 * Scheduled runs execute like a normal Lodestar/Codex turn in the same project
 * directory: Codex starts a fresh thread with cwd set to the project folder,
 * reads the same AGENTS.md instructions, has the same installed skills, and
 * receives the same MCP server injection. The only thing not carried over is
 * the current chat history, so scheduled prompts must be self-contained.
 *
 * These tools are not a general job runner and should only be used when the
 * user explicitly asks for a reminder, recurring run, delayed check, or
 * schedule management.
 *
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
const SERVER_INFO = { name: 'lodestar_schedule', version: '0.4.3' }

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
// JSON Schema for each tool's input. Descriptions are model-facing: Codex reads
// them at tools/list time and uses them as the operating contract for when and
// how to call each scheduling tool.

const SCHEDULE_CREATE_SCHEMA = {
  type: 'object',
  properties: {
    cron: {
      type: 'string',
      description: 'Required. Five-field cron expression in the daemon local timezone: "minute hour day-of-month month day-of-week". No seconds, year, or named months/weekdays. Examples: "0 9 * * *" daily at 09:00, "*/15 * * * *" every 15 minutes, "0 3 * * 1" Mondays at 03:00.',
    },
    prompt: {
      type: 'string',
      description: 'Required. Self-contained first user message for each future run. Scheduled runs execute with the same project environment as this Codex session: same cwd/project folder, same AGENTS.md instructions, same installed skills, and same MCP servers including lodestar_schedule. They start a fresh Codex thread with no chat history, so include all instructions, paths, expected output, and notification wording needed to complete the job. For recurring checks, tell Codex to inspect .lodestar/schedule-runs.jsonl when previous run status matters.',
    },
    mode: {
      type: 'string',
      enum: ['silent', 'verbose'],
      description: 'Output detail. Use "silent" for routine reminders or reports: only the final assistant text is posted. Use "verbose" when the human needs audit details: prompt, assistant segments, tool calls with input/output, and result metadata. Defaults to "silent".',
    },
    level: {
      type: 'string',
      enum: ['info', 'warn', 'error'],
      description: 'Visual severity for the Feishu card only: "info" blue, "warn" yellow, "error" red. This does not change execution behavior. Defaults to "info".',
    },
    name: {
      type: 'string',
      description: 'Optional short human-readable label shown in schedule cards and schedule_list. Use a stable name that explains the job, such as "daily-report" or "check-build". Defaults to the schedule id prefix.',
    },
  },
  required: ['cron', 'prompt'],
}

const SCHEDULE_ONCE_SCHEMA = {
  type: 'object',
  properties: {
    delaySeconds: {
      type: 'number',
      minimum: 0,
      description: 'Required finite number of seconds from now until the one-shot run fires. Must be >= 0. For "remind me in 10 minutes" use 600.',
    },
    prompt: {
      type: 'string',
      description: 'Required. Same as schedule_create.prompt: a self-contained first user message for the future run. The run has the same cwd, AGENTS.md, skills, and MCP servers as this project, but starts a fresh Codex thread with no chat history.',
    },
    mode:  { type: 'string', enum: ['silent', 'verbose'], description: 'Optional output detail. See schedule_create.mode. Defaults to "silent".' },
    level: { type: 'string', enum: ['info', 'warn', 'error'], description: 'Optional visual severity. See schedule_create.level. Defaults to "info".' },
    name:  { type: 'string', description: 'Optional short human-readable label. See schedule_create.name.' },
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
    description: 'Create a recurring scheduled Codex run for this project. Use only when the user explicitly asks for a recurring schedule, cron job, daily/weekly/hourly report, repeated check, or other future repeated automation. Each fire is daemon-persistent and runs Codex in the same project folder with the same AGENTS.md instructions, installed skills, and MCP servers as a normal Lodestar turn. It starts a fresh thread and does not resume the current conversation, so the prompt must be self-contained. The daemon appends execution records to .lodestar/schedule-runs.jsonl; for inspection-style recurring jobs, include instructions to read that log before deciding what to do. Returns the created schedule, including its id and nextFireAt.',
    inputSchema: SCHEDULE_CREATE_SCHEMA,
  },
  {
    name: 'schedule_once',
    description: 'Create a one-shot delayed Codex run for this project. Use only when the user explicitly asks to be reminded later, check something after a delay, or run a task once in the future. It fires once after delaySeconds, runs Codex in the same project folder with the same AGENTS.md instructions, installed skills, and MCP servers as a normal Lodestar turn, then deletes itself. The prompt must be self-contained because no current chat history is carried into the future run. The daemon appends the result to .lodestar/schedule-runs.jsonl for later inspection.',
    inputSchema: SCHEDULE_ONCE_SCHEMA,
  },
  {
    name: 'schedule_list',
    description: "List this project's scheduled Codex runs. Use when the user asks what reminders, scheduled jobs, cron tasks, or delayed checks exist for this project, or before deleting a schedule whose id is unknown. Execution history is not returned here; scheduled run records are appended in the project file .lodestar/schedule-runs.jsonl. Returns count and schedules with id, name, cron or fireAt, mode, level, prompt, nextFireAt, nextFireAtIso, lastFiredAt, and createdAt.",
    inputSchema: SCHEDULE_LIST_SCHEMA,
  },
  {
    name: 'schedule_delete',
    description: 'Delete one scheduled Codex run by id for this project. Use when the user asks to cancel/remove/delete a reminder, cron job, or scheduled task. If the id is unknown, call schedule_list first. Project-scoped: returns ok=false if the id does not exist or belongs to a different project.',
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
        const delaySeconds = args.delaySeconds
        if (typeof delaySeconds !== 'number' || !Number.isFinite(delaySeconds)) {
          return errorContent('delaySeconds must be a finite number')
        }
        const s = createSchedule({
          project,
          prompt: String(args.prompt ?? ''),
          delaySeconds,
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
    res.end('lodestar_schedule MCP: POST JSON-RPC requests to this URL')
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
