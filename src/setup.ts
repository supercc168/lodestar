/**
 * Interactive setup wizard — runs after `npm i -g @leviyuan/lodestar`,
 * triggered either by the postinstall hook (via /dev/tty on unix,
 * \\.\CON{IN,OUT}$ on Windows) or manually via `lodestar-setup`.
 *
 * Flow:
 *   1. Ensure claude CLI is on PATH (npm i -g @anthropic-ai/claude-code
 *      if missing).
 *   2. Pick LLM backend — user's existing auth (subscription / API
 *      key / pre-set env) OR DeepSeek (auto-configures the 8 env vars
 *      per DeepSeek's official Claude Code integration docs).
 *   3. Feishu app — opens https://open.feishu.cn/app, lists every
 *      permission scope + event subscription step, and verifies the
 *      pasted app_id / app_secret against tenant_access_token endpoint
 *      before accepting. Loop on failure.
 *   4. projects_root — default = user home.
 *   5. Write config.toml, then auto-spawn `lodestar-daemon` detached
 *      so it survives setup exit.
 *
 * No background detection of claude auth state — it's fragile across
 * versions. Wizard just asks the user, much more reliable.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_DIR, CONFIG_FILE } from './paths'

const C = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  dim:   '\x1b[2m',
  green: '\x1b[32m',
  yellow:'\x1b[33m',
  cyan:  '\x1b[36m',
  red:   '\x1b[31m',
}

const rl = createInterface({ input: process.stdin, output: process.stdout })

// ── prompts ────────────────────────────────────────────────────────
async function ask(prompt: string, opts: { required?: boolean; default?: string } = {}): Promise<string> {
  while (true) {
    const def = opts.default ? `${C.dim} [${opts.default}]${C.reset}` : ''
    const answer = (await rl.question(`${C.cyan}? ${C.reset}${prompt}${def}\n${C.green}>${C.reset} `)).trim()
    if (!answer && opts.default !== undefined) return opts.default
    if (!answer && opts.required) {
      console.log(`${C.red}必填,请重新输入${C.reset}`)
      continue
    }
    return answer
  }
}

async function chooseOne(prompt: string, options: { label: string; value: string }[]): Promise<string> {
  while (true) {
    console.log(`${C.cyan}? ${C.reset}${prompt}`)
    for (let i = 0; i < options.length; i++) {
      console.log(`  ${C.bold}[${i + 1}]${C.reset} ${options[i]!.label}`)
    }
    const ans = (await rl.question(`${C.green}选择 [1-${options.length}]:${C.reset} `)).trim()
    const idx = parseInt(ans, 10) - 1
    if (idx >= 0 && idx < options.length) return options[idx]!.value
    console.log(`${C.red}无效选择${C.reset}`)
  }
}

function header(title: string): void {
  const line = '═'.repeat(58)
  console.log(`\n${C.bold}${C.cyan}╔${line}╗${C.reset}`)
  console.log(`${C.bold}${C.cyan}║  ${title.padEnd(54)}  ║${C.reset}`)
  console.log(`${C.bold}${C.cyan}╚${line}╝${C.reset}\n`)
}

function step(n: number, total: number, title: string): void {
  console.log(`\n${C.bold}${C.yellow}[${n}/${total}] ${title}${C.reset}\n`)
}

function escapeTomlString(s: string): string {
  // Mirrors the unescape in src/config.ts parseToml — \ → \\, " → \".
  // Windows paths (C:\Users\...) round-trip correctly through both.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// ── claude CLI detection / install ─────────────────────────────────
function whichBin(name: string): string | null {
  const PATH = process.env.PATH ?? ''
  if (!PATH) return null
  const candidates = process.platform === 'win32'
    ? [`${name}.cmd`, `${name}.bat`, `${name}.exe`, name]
    : [name]
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue
    for (const cand of candidates) {
      const p = join(dir, cand)
      if (existsSync(p)) return p
    }
  }
  return null
}

async function installClaudeCli(): Promise<boolean> {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return new Promise((resolve) => {
    const child = spawn(npm, ['install', '-g', '@anthropic-ai/claude-code'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    child.on('exit', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}

// ── browser launcher (best-effort, never throws) ───────────────────
function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn(process.env.ComSpec ?? 'cmd.exe', ['/c', 'start', '""', url], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch {
    // 终端环境 / 无浏览器, 静默, 用户照着控制台 URL 手动开就行
  }
}

// ── Feishu credential check ────────────────────────────────────────
async function testFeishuCreds(appId: string, appSecret: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    })
    const data = await res.json() as { code?: number; msg?: string; tenant_access_token?: string }
    if (data.tenant_access_token) return { ok: true }
    return { ok: false, error: `飞书拒绝: code=${data.code} msg=${data.msg ?? '(no msg)'}` }
  } catch (e: any) {
    return { ok: false, error: `网络错误: ${e?.message ?? String(e)}` }
  }
}

// ── daemon auto-start ──────────────────────────────────────────────
function spawnDaemonDetached(): { pid?: number; error?: string } {
  // 入口是 dist/lodestar-setup.js, daemon 是同目录的 dist/lodestar.js。
  // 用 process.execPath (= 当前 node) 跑那个 bundle, 避开 Windows .cmd
  // shim 的 spawn 引号坑 —— 这样 detached + stdio:'ignore' 行为在
  // 三个平台一致。
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const daemonBundle = join(here, 'lodestar.js')
    if (!existsSync(daemonBundle)) {
      return { error: `找不到 daemon bundle: ${daemonBundle}` }
    }
    const child = spawn(process.execPath, [daemonBundle], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return { pid: child.pid }
  } catch (e: any) {
    return { error: e?.message ?? String(e) }
  }
}

// ── main flow ──────────────────────────────────────────────────────
export async function runSetup(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error(`${C.red}lodestar-setup: stdin 不是 TTY,无法交互式输入。${C.reset}`)
    console.error('请直接在 cmd / PowerShell / Terminal 里跑,不要 pipe 或重定向 stdin。')
    process.exit(1)
  }

  if (existsSync(CONFIG_FILE)) {
    console.log(`${C.yellow}发现已有配置: ${CONFIG_FILE}${C.reset}`)
    const overwrite = await ask('覆盖? (y/N)', { default: 'n' })
    if (overwrite.toLowerCase() !== 'y') {
      console.log('已取消')
      rl.close()
      return
    }
  }

  header('Lodestar 安装向导')
  console.log('Lodestar 把 Feishu (飞书) 群聊接到 Claude Code。')
  console.log('每个群对应一个项目目录, Claude 在那里跑、能读写文件。')
  console.log()
  console.log('本向导依次做 4 件事:')
  console.log(`  ${C.dim}1) 确保 claude CLI 已装好${C.reset}`)
  console.log(`  ${C.dim}2) 选 LLM 后端 (订阅 / API key / DeepSeek)${C.reset}`)
  console.log(`  ${C.dim}3) Feishu 自建应用 (含权限 / 事件 / 发版 + 凭据测试)${C.reset}`)
  console.log(`  ${C.dim}4) 工作目录, 自动启动 daemon${C.reset}`)
  console.log()
  await rl.question(`${C.dim}按 Enter 开始 (Ctrl+C 退出)...${C.reset}`)

  // ── Step 1/4 ──────────────────────────────────────────────────
  step(1, 4, '准备 Claude Code')
  let claudeBin = whichBin('claude')
  if (claudeBin) {
    console.log(`${C.green}✓ claude CLI 已就位${C.reset}: ${C.dim}${claudeBin}${C.reset}`)
  } else {
    console.log(`${C.yellow}未在 PATH 找到 claude CLI, 自动安装...${C.reset}`)
    console.log(`${C.dim}运行: npm install -g @anthropic-ai/claude-code${C.reset}`)
    console.log()
    const ok = await installClaudeCli()
    if (!ok) {
      console.error(`\n${C.red}安装失败。${C.reset}`)
      console.error('请手动运行后再开向导:')
      console.error(`  ${C.cyan}npm install -g @anthropic-ai/claude-code${C.reset}`)
      console.error(`  ${C.cyan}lodestar-setup${C.reset}`)
      rl.close()
      process.exit(1)
    }
    claudeBin = whichBin('claude')
    console.log(`${C.green}✓ 安装完成${C.reset}: ${C.dim}${claudeBin ?? '(应该装好了, 但 PATH 找不到 — 重开终端再试)'}${C.reset}`)
  }

  // ── Step 2/4 ──────────────────────────────────────────────────
  step(2, 4, 'LLM 后端')
  console.log('claude CLI 默认走 Anthropic 官方, 需要 claude.ai 订阅或 API key。')
  console.log('国内访问 anthropic.com 不一定通, 也可以让 claude 走 DeepSeek 后端。')
  console.log()

  const backend = await chooseOne('你的 claude 怎么走?', [
    { label: '已经配过 (订阅 / API key / 已设环境变量), 直接用', value: 'existing' },
    { label: `${C.bold}用 DeepSeek${C.reset}${C.dim} (国内可用, 人民币计费, 推荐)${C.reset}`, value: 'deepseek' },
  ])

  const claudeEnv: Record<string, string> = {}
  if (backend === 'deepseek') {
    console.log()
    console.log('打开浏览器拿 DeepSeek API key:')
    const dsKeyUrl = 'https://platform.deepseek.com/api_keys'
    console.log(`  ${C.cyan}${dsKeyUrl}${C.reset}`)
    openBrowser(dsKeyUrl)
    console.log(`${C.dim}(如果浏览器没自动开, 复制上面 URL 粘到浏览器)${C.reset}`)
    console.log()
    const dsKey = await ask('DeepSeek API key (以 sk- 开头)', { required: true })

    // 完全按 DeepSeek 官方 claude_code 集成文档:
    // https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code
    claudeEnv.ANTHROPIC_BASE_URL          = 'https://api.deepseek.com/anthropic'
    claudeEnv.ANTHROPIC_AUTH_TOKEN        = dsKey
    claudeEnv.ANTHROPIC_MODEL             = 'deepseek-v4-pro'
    claudeEnv.ANTHROPIC_DEFAULT_OPUS_MODEL   = 'deepseek-v4-pro'
    claudeEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-v4-pro'
    claudeEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL  = 'deepseek-v4-flash'
    claudeEnv.CLAUDE_CODE_SUBAGENT_MODEL  = 'deepseek-v4-flash'
    claudeEnv.CLAUDE_CODE_EFFORT_LEVEL    = 'max'
    console.log()
    console.log(`${C.green}✓ DeepSeek 配置已记录${C.reset} (写到 [claude.env] 节, daemon 拉起 claude 时自动注入)`)
  } else {
    console.log(`${C.dim}OK, 跳过 LLM 后端配置 — daemon 启动时会继承当前环境 + claude 自带 auth。${C.reset}`)
  }

  // ── Step 3/4 ──────────────────────────────────────────────────
  step(3, 4, 'Feishu 自建应用')
  const feishuUrl = 'https://open.feishu.cn/app'
  console.log('打开飞书开放平台 (浏览器):')
  console.log(`  ${C.cyan}${feishuUrl}${C.reset}`)
  openBrowser(feishuUrl)
  console.log(`${C.dim}(如果浏览器没自动开, 复制上面 URL 粘到浏览器)${C.reset}`)
  console.log()
  console.log(`${C.bold}详细操作步骤:${C.reset}`)
  console.log()
  console.log(`  ${C.bold}① 创建应用${C.reset}`)
  console.log(`     点 "创建企业自建应用", 填名字 (如 ${C.dim}Lodestar${C.reset}), logo 随意。`)
  console.log()
  console.log(`  ${C.bold}② 添加机器人能力${C.reset}`)
  console.log(`     左侧菜单 "${C.cyan}添加应用能力${C.reset}" → 找到 "机器人" → 点 "${C.bold}添加${C.reset}" 按钮。`)
  console.log()
  console.log(`  ${C.bold}③ 申请权限 (左侧 "${C.cyan}权限管理${C.reset}" → "${C.bold}开通权限${C.reset}")${C.reset}`)
  console.log(`     ${C.yellow}缺一个都会让 daemon 启动后默默丢消息, 一定要全开。${C.reset}`)
  console.log(`     ${C.dim}消息类:${C.reset}`)
  console.log(`       • ${C.bold}im:message:send_as_bot${C.reset}      ${C.dim}# 以机器人身份发消息${C.reset}`)
  console.log(`       • ${C.bold}im:message${C.reset}                  ${C.dim}# 接收/操作消息 (核心)${C.reset}`)
  console.log(`       • ${C.bold}im:chat:readonly${C.reset}            ${C.dim}# 读群信息 (匹配群名 ↔ 项目目录)${C.reset}`)
  console.log(`       • ${C.bold}im:resource${C.reset}                 ${C.dim}# 上传/下载附件 (图文双向)${C.reset}`)
  console.log(`       • ${C.bold}im:message.urgent${C.reset}           ${C.dim}# 加急推送 (锁屏通知 / Ask)${C.reset}`)
  console.log(`     ${C.dim}卡片类 (Card Kit):${C.reset}`)
  console.log(`       • ${C.bold}cardkit:card:read${C.reset}`)
  console.log(`       • ${C.bold}cardkit:card:write${C.reset}`)
  console.log()
  console.log(`  ${C.bold}④ 订阅事件 (左侧 "${C.cyan}事件与回调${C.reset}", 拆两个子页:)${C.reset}`)
  console.log(`     ${C.dim}a)${C.reset} ${C.bold}事件配置${C.reset} 页:`)
  console.log(`        ${C.yellow}• "订阅方式" → 选 "长连接" → 点保存${C.reset}`)
  console.log(`        • 添加事件: ${C.bold}im.message.receive_v1${C.reset}   ${C.dim}# 收群消息${C.reset}`)
  console.log(`     ${C.dim}b)${C.reset} ${C.bold}回调配置${C.reset} 页:`)
  console.log(`        ${C.yellow}• "订阅方式" → 选 "长连接" → 点保存${C.reset}`)
  console.log(`        • 添加事件: ${C.bold}card.action.trigger${C.reset}     ${C.dim}# 卡片按钮点击回调${C.reset}`)
  console.log()
  console.log(`  ${C.bold}⑤ 发布版本${C.reset}`)
  console.log(`     页面顶部 "${C.bold}创建版本${C.reset}" → 滚到底点 "${C.bold}保存${C.reset}" → 弹框点 "${C.bold}发布${C.reset}"。`)
  console.log(`     ${C.yellow}没发版的应用收不到任何事件 — 这步九成新手会忘!${C.reset}`)
  console.log()
  console.log(`  ${C.bold}⑥ 拿凭据${C.reset}`)
  console.log(`     左侧 "凭证与基础信息" → 顶部 ${C.bold}App ID${C.reset} (${C.dim}cli_...${C.reset}) 和 ${C.bold}App Secret${C.reset}, 待会粘到下面。`)
  console.log()
  console.log(`  ${C.bold}⑦ 把机器人拉进群${C.reset}`)
  console.log(`     想用的飞书群 → 群设置 → 群机器人 → 添加机器人 → 选你的应用。`)
  console.log(`     ${C.yellow}群名要等于 projects_root 下的项目目录名${C.reset} (下一步设, 默认是用户主目录)。`)
  console.log()

  let appId = '', appSecret = ''
  while (true) {
    appId = await ask('App ID (以 cli_ 开头)', { required: true })
    appSecret = await ask('App Secret', { required: true })
    console.log(`${C.dim}测试中... (调 tenant_access_token endpoint)${C.reset}`)
    const test = await testFeishuCreds(appId, appSecret)
    if (test.ok) {
      console.log(`${C.green}✓ Feishu 凭据测试通过${C.reset}`)
      break
    }
    console.log(`${C.red}✗ 测试失败:${C.reset} ${test.error}`)
    console.log(`${C.dim}最常见原因: app_id / app_secret 抄错, 或应用还没 "发布上线" (步骤 ⑤)。${C.reset}`)
    console.log()
    const retry = await ask('重新填? (Y/n)', { default: 'y' })
    if (retry.toLowerCase() === 'n') {
      console.log(`${C.yellow}已取消, 配置未写盘。${C.reset}`)
      rl.close()
      process.exit(1)
    }
  }

  // ── Step 4/4 ──────────────────────────────────────────────────
  step(4, 4, '工作目录 + 启动')
  console.log('每个 Feishu 群对应 projects_root 下同名的目录。')
  console.log()
  const defaultRoot = process.platform === 'win32'
    ? (process.env.USERPROFILE ?? 'C:\\Users\\Default')
    : (process.env.HOME ?? '/root')
  const projectsRoot = await ask('projects_root', { default: defaultRoot })

  // ── Write config.toml ─────────────────────────────────────────
  mkdirSync(CONFIG_DIR, { recursive: true })
  const toml: string[] = [
    '# Lodestar config — generated by `lodestar-setup`',
    '# Edit by hand or re-run setup to overwrite.',
    '',
    '[feishu]',
    `app_id = "${escapeTomlString(appId)}"`,
    `app_secret = "${escapeTomlString(appSecret)}"`,
    '',
    '[runtime]',
    `projects_root = "${escapeTomlString(projectsRoot)}"`,
    '',
  ]
  if (Object.keys(claudeEnv).length > 0) {
    toml.push('# Env vars injected into the spawned claude CLI subprocess.')
    toml.push('# Used to redirect claude to DeepSeek / GLM / other anthropic-compatible')
    toml.push('# backends without touching system env vars.')
    toml.push('[claude.env]')
    for (const [k, v] of Object.entries(claudeEnv)) {
      toml.push(`${k} = "${escapeTomlString(v)}"`)
    }
    toml.push('')
  }
  writeFileSync(CONFIG_FILE, toml.join('\n'), { mode: 0o600 })

  console.log(`\n${C.green}${C.bold}✓ 配置已写入${C.reset}`)
  console.log(`  ${C.cyan}${CONFIG_FILE}${C.reset}`)

  // ── Auto-start daemon ─────────────────────────────────────────
  console.log(`\n${C.bold}启动 daemon...${C.reset}`)
  const r = spawnDaemonDetached()
  const sep = process.platform === 'win32' ? '\\' : '/'
  const logPath = process.platform === 'win32'
    ? `${process.env.LOCALAPPDATA ?? '%LOCALAPPDATA%'}\\Lodestar\\daemon.log`
    : `${process.env.HOME ?? '~'}/.local/share/lodestar/daemon.log`

  if (r.pid) {
    console.log(`${C.green}✓ daemon 已在后台启动${C.reset} (pid ${r.pid})`)
    console.log()
    console.log(`${C.bold}最后一步: 在 Feishu 验证${C.reset}`)
    console.log(`  ① 把机器人拉进任意飞书群`)
    console.log(`  ② 群名 = ${C.cyan}${projectsRoot}${sep}<群名>${C.reset} 下的目录名 (新群第一条消息会自动建)`)
    console.log(`  ③ 在群里发任意一条消息, Claude 上线`)
    console.log()
    console.log(`日志:`)
    console.log(`  ${C.cyan}${logPath}${C.reset}`)
    console.log()
    console.log(`${C.dim}若长期跑后台, 参考 README "7×24 守护" 一节配 systemd / Task Scheduler。${C.reset}`)
  } else {
    console.log(`${C.yellow}启动失败: ${r.error}${C.reset}`)
    console.log(`手动运行: ${C.cyan}lodestar-daemon${C.reset}`)
  }
  console.log()

  rl.close()
}
