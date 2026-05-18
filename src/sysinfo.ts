/**
 * Lightweight host snapshot for the `hi` console panel —— CPU 负载、
 * 内存、根/家目录磁盘、以及当前用户下的 cc-* 系列 systemd 服务。
 *
 * 服务前缀约定: claude code 自己起的常驻进程统一走
 *   systemd-run --user --unit=cc-<project>-<purpose> -- <cmd>
 * (见全局 CLAUDE.md 的 background_process_safety 段)。`hi` 面板只列
 * `cc-*` 是要让 daemon 这台机器上的"AI 拉起来的活儿"一眼可见,跟
 * 系统自带 / 第三方服务区分开。
 *
 * 所有数据源都是本机文件 / 系统调用,没有网络往返:
 *   /proc/loadavg          —— 1m / 5m / 15m
 *   /proc/meminfo          —— Total / Available
 *   statfsSync(path)       —— 各挂载点容量
 *   /proc/uptime           —— monotonic seconds since boot (uptime 推算)
 *   systemctl --user show  —— cc-* 服务的状态与启动时间
 *
 * 失败可见: 任何一段读不到就把对应字段标 null,卡片层按 null 渲染
 * `_n/a_`,绝不假数据 (no_fallbacks)。
 */

import { execFile } from 'node:child_process'
import { readFileSync, statfsSync, statSync } from 'node:fs'
import { cpus, homedir } from 'node:os'
import { promisify } from 'node:util'
import { log } from './log'

const execFileAsync = promisify(execFile)

export interface CpuInfo {
  cores: number
  load1: number
  load5: number
  load15: number
}

export interface MemInfo {
  /** Bytes — MemTotal 来自 /proc/meminfo */
  totalBytes: number
  /** Bytes — MemAvailable;比 free + buffers + cached 更准 (考虑 reclaimable) */
  availBytes: number
  usedBytes: number
  /** 0–100 */
  percent: number
}

export interface DiskInfo {
  /** 显示用的标签 ('/' 或 '$HOME') */
  label: string
  /** 实际查询的路径 */
  path: string
  totalBytes: number
  availBytes: number
  usedBytes: number
  /** 0–100;按 used / total */
  percent: number
}

export interface ServiceInfo {
  /** 不带 .service 后缀,贴卡片用 */
  name: string
  /** systemd ActiveState: active | inactive | failed | activating | deactivating */
  active: string
  /** SubState: running | exited | dead | start | stop-sigterm | ... */
  sub: string
  /** 自最近一次进入 active 状态起的秒数。从未活跃过则为 null。
   * 对 active 服务等于 "已运行 X 秒";对 inactive/failed 等于
   * "上次跑起来到现在过了 X 秒"。 */
  lastActiveAgoSec: number | null
  /** 当前 ActiveState 的持续秒数 (StateChangeTimestamp → 现在)。
   * 对 active 服务等于 lastActiveAgoSec;对 inactive 服务等于
   * "已停了多久";对 activating/deactivating 等于"切换中多久"。 */
  stateAgoSec: number | null
}

export interface SysInfo {
  cpu: CpuInfo | null
  mem: MemInfo | null
  disks: DiskInfo[]
  services: ServiceInfo[]
  /** 真的查不到时(systemctl 不存在 / 拒绝)就 null;空数组表示"没有 cc-* 服务"。 */
  servicesError: string | null
}

/** 用户态 systemd-run 服务的统一前缀。改这里要同步改 CLAUDE.md。 */
export const SERVICE_PREFIX = 'cc-'

function readCpu(): CpuInfo | null {
  try {
    const raw = readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/)
    return {
      cores: cpus().length,
      load1: parseFloat(raw[0] ?? '0'),
      load5: parseFloat(raw[1] ?? '0'),
      load15: parseFloat(raw[2] ?? '0'),
    }
  } catch (e) {
    log(`sysinfo: read /proc/loadavg failed: ${e}`)
    return null
  }
}

function readMem(): MemInfo | null {
  try {
    const raw = readFileSync('/proc/meminfo', 'utf8')
    const find = (k: string): number => {
      const m = raw.match(new RegExp(`^${k}:\\s+(\\d+)\\s*kB`, 'm'))
      return m ? parseInt(m[1]!, 10) * 1024 : 0
    }
    const totalBytes = find('MemTotal')
    const availBytes = find('MemAvailable')
    if (!totalBytes) return null
    const usedBytes = Math.max(0, totalBytes - availBytes)
    return {
      totalBytes, availBytes, usedBytes,
      percent: Math.round((usedBytes / totalBytes) * 100),
    }
  } catch (e) {
    log(`sysinfo: read /proc/meminfo failed: ${e}`)
    return null
  }
}

/** statfsSync 拿到的 blocks/bavail 都按 f_frsize 计算 bytes —— 注意
 * `usedBytes` 用 total - avail (不是 total - free),跟 `df` 的 Use% 列
 * 一致 (排除 root 保留块)。 */
function readDiskFor(label: string, path: string): DiskInfo | null {
  try {
    const s = statfsSync(path, { bigint: false }) as {
      bsize: number; blocks: number; bavail: number
    }
    const totalBytes = s.blocks * s.bsize
    const availBytes = s.bavail * s.bsize
    const usedBytes = Math.max(0, totalBytes - availBytes)
    if (!totalBytes) return null
    return {
      label, path, totalBytes, availBytes, usedBytes,
      percent: Math.round((usedBytes / totalBytes) * 100),
    }
  } catch (e) {
    log(`sysinfo: statfs ${path} failed: ${e}`)
    return null
  }
}

/** 取 `/` 和 `$HOME`;如果两者属于同一文件系统(同一 device id),
 * 只返回 `/`,避免面板上挂两条一样的数据 (用户在 AskUserQuestion
 * 时知情的选择)。 */
function readDisks(): DiskInfo[] {
  const out: DiskInfo[] = []
  const root = readDiskFor('/', '/')
  if (root) out.push(root)
  const home = homedir()
  if (home && home !== '/') {
    let homeOnSameFs = false
    try {
      const rs = statSync('/')
      const hs = statSync(home)
      homeOnSameFs = rs.dev === hs.dev
    } catch {}
    if (!homeOnSameFs) {
      const homeDisk = readDiskFor('$HOME', home)
      if (homeDisk) out.push(homeDisk)
    }
  }
  return out
}

/** /proc/uptime 第一个数是 monotonic 自启动以来的秒数。 */
function readMonotonicSec(): number | null {
  try {
    const raw = readFileSync('/proc/uptime', 'utf8').trim().split(/\s+/)
    return parseFloat(raw[0] ?? '0')
  } catch {
    return null
  }
}

/** 用 `node:child_process.execFile` 跑 `systemctl --user` —— 跨 Bun /
 * Node 通用,超时(默认 2s)由 execFile 内置 timeout 处理,非零退出码
 * execFile 会 reject,被外层 catch 统一兜成 null,跟旧版 Bun.spawn 行为
 * 一致(调用方拿 null 走 error 分支)。Linux-only:Windows 在 readSysInfo
 * 入口已经 early-return,这里不会被命中。 */
async function runSystemctl(args: string[], timeoutMs = 2000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('systemctl', ['--user', ...args], {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    })
    return stdout
  } catch (e) {
    log(`sysinfo: systemctl ${args.join(' ')} failed: ${e}`)
    return null
  }
}

/** 列 `${SERVICE_PREFIX}*` 服务并解析:第 1 步用 list-units 拿名字,
 * 第 2 步用单次 show -p 拿状态 + ActiveEnterTimestampMonotonic。两步
 * 都是本地调用,加起来 < 100ms。 */
async function readServices(): Promise<{ services: ServiceInfo[]; error: string | null }> {
  // list-units 输出每行: "<unit> <load> <active> <sub> <description>"。
  // --all 把 inactive 也列出来 (用户停过的服务也值得在面板看到)。
  // 加 --plain --no-legend 关掉表格修饰和 footer,方便机器解析。
  const listOut = await runSystemctl([
    'list-units', '--type=service', '--all', '--no-legend', '--plain', `${SERVICE_PREFIX}*`,
  ])
  if (listOut === null) {
    return { services: [], error: 'systemctl 不可用' }
  }
  const lines = listOut.split('\n').map(l => l.trim()).filter(l => l.length > 0)
  if (lines.length === 0) return { services: [], error: null }

  const names: string[] = []
  for (const line of lines) {
    // 第一列是 unit 全名,可能带前缀●;.service 后缀去掉。
    const cols = line.replace(/^●\s*/, '').split(/\s+/)
    const unit = cols[0]
    if (!unit) continue
    if (!unit.startsWith(SERVICE_PREFIX)) continue
    if (!unit.endsWith('.service')) continue
    names.push(unit)
  }
  if (names.length === 0) return { services: [], error: null }

  // 一次性 show 多个 unit:每个 unit 输出一段属性,段之间空行分隔。
  // ActiveEnter = 最近一次进入 active 的时刻 (即使现在已 inactive 也保留);
  // StateChange = 当前 ActiveState 进入时刻。两者对 active 服务相同,
  // 对 inactive 服务分别是"上次活跃"与"停了多久"。
  const showOut = await runSystemctl([
    'show', ...names,
    '-p', 'Id',
    '-p', 'ActiveState',
    '-p', 'SubState',
    '-p', 'ActiveEnterTimestampMonotonic',
    '-p', 'StateChangeTimestampMonotonic',
  ])
  if (showOut === null) return { services: [], error: 'systemctl show 失败' }

  const monotonicNowSec = readMonotonicSec()
  const blocks = showOut.split(/\n\s*\n/)
  const services: ServiceInfo[] = []
  const ageFrom = (microStr: string | undefined): number | null => {
    const micro = parseInt(microStr ?? '0', 10)
    if (micro <= 0 || monotonicNowSec === null) return null
    return Math.max(0, monotonicNowSec - micro / 1_000_000)
  }
  for (const block of blocks) {
    const props: Record<string, string> = {}
    for (const line of block.split('\n')) {
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      props[line.slice(0, eq)] = line.slice(eq + 1)
    }
    const id = props.Id ?? ''
    if (!id.startsWith(SERVICE_PREFIX) || !id.endsWith('.service')) continue
    services.push({
      name: id.replace(/\.service$/, ''),
      active: props.ActiveState ?? 'unknown',
      sub: props.SubState ?? '',
      lastActiveAgoSec: ageFrom(props.ActiveEnterTimestampMonotonic),
      stateAgoSec: ageFrom(props.StateChangeTimestampMonotonic),
    })
  }
  services.sort((a, b) => a.name.localeCompare(b.name))
  return { services, error: null }
}

export async function readSysInfo(): Promise<SysInfo> {
  // Linux 专属:CPU/mem/disks 全靠 /proc + statfs,services 走
  // `systemctl --user`。Windows 上这套全不可用,直接返回空 SysInfo,
  // 让 `hi` 面板按 no_fallbacks 的约定渲染 `_n/a_`,不假数据也不
  // 在日志里刷 systemctl/proc 的 ENOENT 噪音。Windows 真实指标
  // (wmic / PowerShell Get-CimInstance) 留给以后用 Windows 真机
  // spike,这里只做最低限度的"不崩"。
  if (process.platform === 'win32') {
    return { cpu: null, mem: null, disks: [], services: [], servicesError: 'Windows: sysinfo 暂未支持' }
  }
  const cpu = readCpu()
  const mem = readMem()
  const disks = readDisks()
  const { services, error } = await readServices()
  return { cpu, mem, disks, services, servicesError: error }
}
