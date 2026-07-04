/**
 * Interactive setup wizard — runs after `源码构建后 npm i -g .`,
 * triggered either by the postinstall hook (via /dev/tty on unix,
 * \\.\CON{IN,OUT}$ on Windows) or manually via `lodestar-setup`.
 *
 * Lodestar 默认后端是 Claude Code (Agent SDK),Codex 是可选第二后端
 * (群里发 `model` 切换)。本向导依次做 4 件事:
 *
 *   1. 确保 Claude Code CLI 在 PATH (npm i -g @anthropic-ai/claude-code)。
 *      特别提醒: 受 Claude 官方限制, Claude 订阅 (Pro/Max OAuth 登录)
 *      不支持本项目; 必须走 API 方式 —— GLM Coding Plan 或 Anthropic API key。
 *   2. GLM Coding Plan API key (推荐, 可选) —— 给了就写进 config.toml 的
 *      [claude.models.glm] 档位 (model=GLM-5.2[1m] 1M context, effort=xhigh)
 *      并设为 [claude] default_model; 不给就用 Anthropic 登录态跑
 *      Fable 5 / Opus。同一歩末尾可选顺带配置 Codex。
 *   3. Feishu 自建应用 —— 打开 https://open.feishu.cn/app, 列出每个
 *      权限 scope + 事件订阅步骤, 粘贴的 app_id / app_secret 先调
 *      tenant_access_token endpoint 验证再收。失败循环重试。
 *   4. projects_root —— 默认 = 用户主目录; 写 config.toml 后 detached
 *      自动拉起 lodestar-daemon, 向导退出后继续跑。
 *
 * GLM 路由的真相源是 config.toml 的 [claude.models.glm] (第三方 per-model
 * token 路由, spawn 时只给 GLM 档位注入 ANTHROPIC_* env; 官方 Fable 5 / Opus
 * 登录档位保持干净)。旧版把 GLM 写进 ~/.claude/settings.json 的做法已废弃 ——
 * 那会经 settingSources:['user'] 污染登录档位, 向导会检测残留并提示清理。
 */

import { execSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { delimiter, dirname, join } from 'node:path'
import { homedir } from 'node:os'
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

// ── bin detection / install ────────────────────────────────────────
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

function npmInstallGlobal(pkg: string): Promise<boolean> {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return new Promise((resolve) => {
    const child = spawn(npm, ['install', '-g', `${pkg}@latest`], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    child.on('exit', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}

// ── Codex CLI (optional second backend) ────────────────────────────
function isCodexChatGPTLoggedIn(codexBin: string): boolean {
  try {
    const out = execSync(`"${codexBin}" login status 2>&1`, { timeout: 10_000 }).toString()
    return /Logged in using ChatGPT/i.test(out)
  } catch { return false }
}

async function runCodexLogin(codexBin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(codexBin, ['login'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    child.on('exit', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}

// ── Claude Code settings.json (GLM 路由迁移检测) ────────────────────
function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** GLM 路由现在的真相源是 config.toml 的 [claude.models.glm](见 setup 头注释
 *  与 docs/claude-agent-backend.md)。旧版本把 GLM env 写进 ~/.claude/settings.json,
 *  而 SDK 经 settingSources:['user'] 会加载它 —— 那会污染官方登录档位(Fable 5 /
 *  Opus 被偷偷路由去 GLM,标签失真)。检测残留并提示用户手动清掉;只读,绝不
 *  改写用户的 settings.json(可能夹带自备 Anthropic API key / 其他配置)。 */
function warnResidualGlmSettings(): void {
  try {
    const settingsPath = join(claudeConfigDir(), 'settings.json')
    if (!existsSync(settingsPath)) return
    let parsed: any
    try {
      parsed = JSON.parse(readFileSync(settingsPath, 'utf8'))
    } catch {
      return // 解析不了就不打扰
    }
    const env = (parsed && typeof parsed === 'object' && !Array.isArray(parsed.env)) ? parsed.env : null
    if (!env || typeof env !== 'object') return
    const baseUrl = String(env.ANTHROPIC_BASE_URL ?? '')
    const looksGlm = /bigmodel|z\.ai|glm/i.test(baseUrl) ||
      /GLM/i.test(String(env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? ''))
    if (!looksGlm && !baseUrl) return
    if (!looksGlm) return
    console.log()
    console.log(`${C.yellow}⚠ 检测到 ~/.claude/settings.json 里有 GLM 路由 env${C.reset}`)
    console.log(`  ${C.dim}(${settingsPath})${C.reset}`)
    console.log(`  新版 GLM 走 config.toml 的 ${C.bold}[claude.models.glm]${C.reset};settings.json 里这些`)
    console.log(`  会被 Claude Code 经 settingSources 加载,把 ${C.bold}Fable 5 / Opus 登录档位也偷偷路由去 GLM${C.reset}。`)
    console.log(`  ${C.dim}建议手动删掉 env 里这些 key(自备 Anthropic API key 的除外):${C.reset}`)
    console.log(`    ${C.dim}ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL${C.reset}`)
  } catch { /* 检测失败不影响向导 */ }
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
  console.log('Lodestar 把 Feishu (飞书) 群聊接到 AI agent。')
  console.log('默认后端是 Claude Code; Codex 是可选第二后端, 群里发 model 一键切换。')
  console.log('每个群对应一个项目目录, agent 在那里跑、能读写文件。')
  console.log()
  console.log(`${C.yellow}⚠ Claude 官方限制:${C.reset}`)
  console.log(`  ${C.bold}Claude 订阅 (Pro/Max OAuth 登录) 不支持本项目${C.reset},`)
  console.log(`  必须走 API 方式 —— 推荐 GLM Coding Plan, 或自备 Anthropic API key。`)
  console.log()
  console.log('本向导依次做 4 件事:')
  console.log(`  ${C.dim}1) 确保 Claude Code CLI 已装好${C.reset}`)
  console.log(`  ${C.dim}2) GLM Coding Plan API key (推荐, 可选) + Codex (可选)${C.reset}`)
  console.log(`  ${C.dim}3) Feishu 自建应用 (含权限 / 事件 / 发版 + 凭据测试)${C.reset}`)
  console.log(`  ${C.dim}4) 工作目录, 自动启动 daemon${C.reset}`)
  console.log()
  await rl.question(`${C.dim}按 Enter 开始 (Ctrl+C 退出)...${C.reset}`)

  // ── Step 1/4 ──────────────────────────────────────────────────
  step(1, 4, '准备 Claude Code CLI')
  let claudeBin = whichBin('claude')
  if (claudeBin) {
    console.log(`${C.green}✓ claude CLI 已就位${C.reset}: ${C.dim}${claudeBin}${C.reset}`)
  } else {
    console.log(`${C.yellow}未在 PATH 找到 claude CLI, 自动安装...${C.reset}`)
    console.log(`${C.dim}运行: npm install -g @anthropic-ai/claude-code@latest${C.reset}`)
    console.log()
    const ok = await npmInstallGlobal('@anthropic-ai/claude-code')
    if (!ok) {
      console.error(`\n${C.red}安装失败。${C.reset}`)
      console.error('请手动运行后再开向导:')
      console.error(`  ${C.cyan}npm install -g @anthropic-ai/claude-code@latest${C.reset}`)
      console.error(`  ${C.cyan}lodestar-setup${C.reset}`)
      rl.close()
      process.exit(1)
    }
    claudeBin = whichBin('claude')
    console.log(`${C.green}✓ 安装完成${C.reset}: ${C.dim}${claudeBin ?? '(应该装好了, 但 PATH 找不到 — 重开终端再试)'}${C.reset}`)
  }
  console.log()
  console.log(`${C.dim}下一步可选配 GLM Coding Plan 自动写入路由; 不配则用本机 Claude Code 现有配置。${C.reset}`)
  console.log(`${C.dim}记住: 别用 \`claude\` 走订阅 OAuth 登录 —— 订阅不支持本项目, 要用 API key。${C.reset}`)

  // ── Step 2/4 ──────────────────────────────────────────────────
  step(2, 4, 'GLM Coding Plan (推荐, 可选)')
  console.log('GLM Coding Plan 给 Claude Code 接 GLM-5.2 (开放 1M token 上下文, 中文友好)。')
  console.log('订阅后在智谱开放平台拿一个 API key, 粘到下面 —— 向导写进 config.toml 的')
  console.log(`${C.bold}[claude.models.glm]${C.reset} 档位并设为默认; 群里发 model 可在 Fable 5 / Opus / GLM 间切换。`)
  console.log(`  ${C.dim}拿 key: https://open.bigmodel.cn → 控制台 → API Keys${C.reset}`)
  console.log(`  ${C.dim}不给也行: 用 Anthropic 登录态跑 Fable 5 / Opus (确保是 API key 方式, 非订阅 OAuth)。${C.reset}`)
  console.log()

  const glmKey = await ask('GLM API key (直接回车跳过)', {})
  if (glmKey) {
    console.log(`${C.green}✓ 已记录 GLM key${C.reset} ${C.dim}(稍后写进 config.toml 的 [claude.models.glm]: model=GLM-5.2[1m] · effort=xhigh · 设为默认档位)${C.reset}`)
  } else {
    console.log(`${C.dim}已跳过 GLM, 用 Anthropic 登录态跑 Fable 5 / Opus。${C.reset}`)
  }
  // 旧版本把 GLM 写进 ~/.claude/settings.json;检测残留并提示清理(只读, 不改写)。
  warnResidualGlmSettings()

  // ── Codex (可选第二后端) ──────────────────────────────────────
  console.log()
  console.log(`${C.bold}Codex (可选第二后端)${C.reset}`)
  console.log(`  ${C.dim}想用 Codex·GPT-5.5 的话, 登录 ChatGPT 订阅即可, 群里发 model 切换。${C.reset}`)
  const wantCodex = await ask('现在顺便配置 Codex 后端吗?', { default: 'n' })
  if (wantCodex.toLowerCase() === 'y') {
    let codexBin = whichBin('codex')
    if (!codexBin) {
      console.log(`${C.dim}未找到 codex CLI, 安装 @openai/codex...${C.reset}`)
      const ok = await npmInstallGlobal('@openai/codex')
      if (ok) codexBin = whichBin('codex')
    }
    if (codexBin && isCodexChatGPTLoggedIn(codexBin)) {
      console.log(`${C.green}✓ Codex 已登录 ChatGPT${C.reset}`)
    } else if (codexBin) {
      console.log(`${C.dim}启动 \`codex login\`...${C.reset}`)
      const ok = await runCodexLogin(codexBin)
      if (ok && isCodexChatGPTLoggedIn(codexBin)) {
        console.log(`${C.green}✓ Codex 已登录 ChatGPT${C.reset}`)
      } else {
        console.log(`${C.yellow}Codex 登录未完成 — 不影响默认 Claude 后端; 需要时随时跑 codex login。${C.reset}`)
      }
    } else {
      console.log(`${C.yellow}Codex 安装失败 — 不影响默认 Claude 后端; 需要时手动 npm i -g @openai/codex。${C.reset}`)
    }
  } else {
    console.log(`${C.dim}已跳过 Codex (需要时随时跑 codex login, 群里发 model 切)。${C.reset}`)
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
  console.log(`       • ${C.bold}im:message:send_as_bot${C.reset}            ${C.dim}# 以机器人身份发消息${C.reset}`)
  console.log(`       • ${C.bold}im:message${C.reset}                        ${C.dim}# 接收/操作消息 (核心)${C.reset}`)
  console.log(`       • ${C.bold}im:chat${C.reset}                           ${C.dim}# 读/写群信息 (匹配群名 ↔ 项目目录)${C.reset}`)
  console.log(`       • ${C.bold}im:chat:create${C.reset}                    ${C.dim}# wt: 自动创建 worktree 群${C.reset}`)
  console.log(`       • ${C.bold}im:chat:delete${C.reset}                    ${C.dim}# wt: 解散 worktree 群${C.reset}`)
  console.log(`       • ${C.bold}im:chat.members:read${C.reset}              ${C.dim}# wt: 判断发起人是否已在群内${C.reset}`)
  console.log(`       • ${C.bold}im:chat.members:write_only${C.reset}        ${C.dim}# wt: 把发起人拉进已有 worktree 群${C.reset}`)
  console.log(`       • ${C.bold}im:resource${C.reset}                       ${C.dim}# 上传/下载附件 (图文双向)${C.reset}`)
  console.log(`       • ${C.bold}im:message.urgent${C.reset}                 ${C.dim}# 加急推送 (锁屏通知 / Ask)${C.reset}`)
  console.log(`       • ${C.bold}im:message.group_msg${C.reset}              ${C.dim}# 敏感: 接收群里所有消息${C.reset}`)
  console.log(`         ${C.dim}└ 关键: 没它机器人只收 @ 自己的消息, 拿不到群里其他对话, 一定要开${C.reset}`)
  console.log(`         ${C.dim}└ 敏感权限要走审批: 申请时填用途, 个人开发者通常秒过${C.reset}`)
  console.log(`       • ${C.bold}im:message.group_at_msg:readonly${C.reset}  ${C.dim}# 读 @ 机器人消息 (兜底)${C.reset}`)
  console.log(`     ${C.dim}卡片类 (Card Kit):${C.reset}`)
  console.log(`       • ${C.bold}cardkit:card:read${C.reset}                 ${C.dim}# 读卡片状态${C.reset}`)
  console.log(`       • ${C.bold}cardkit:card:write${C.reset}                ${C.dim}# 创建/更新卡片 (流式渲染核心)${C.reset}`)
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
    console.log(`${C.red}✗ 测试失败:${C.reset} ${(test as { ok: false; error: string }).error}`)
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
  // GLM 走 [claude.models.glm] 档位路由(第三方 per-model token),SDK spawn 时
  // 注入 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN,且只作用于 GLM 档位 —— 官方
  // Fable 5 / Opus 登录档位保持干净、绝不注入 key。[claude] default_model 让新群
  // 首条消息直接走 GLM,不必先手动切一次。model=GLM-5.2[1m] 开放 1M 上下文,
  // effort=xhigh 复刻 GLM-5.2 最高思维。
  if (glmKey) {
    toml.push(
      '[claude]',
      'default_model = "glm"',
      '',
      '[claude.models.glm]',
      'base_url = "https://open.bigmodel.cn/api/anthropic"',
      `auth_token = "${escapeTomlString(glmKey)}"`,
      'model = "GLM-5.2[1m]"',
      'effort = "xhigh"',
      '',
    )
  }
  // 没配 GLM 就用 Anthropic 登录态跑 Fable 5 / Opus(默认档位),Codex 登录态由
  // codex CLI 管。高级用户可手写 [codex.env] / [claude.env] 注入子进程环境
  // (escape hatch, 通常不需要);GLM 之外的第三方路由照 [claude.models.<名>] 加。
  writeFileSync(CONFIG_FILE, toml.join('\n'), { mode: 0o600 })

  console.log(`\n${C.green}${C.bold}✓ 配置已写入${C.reset}`)
  console.log(`  ${C.cyan}${CONFIG_FILE}${C.reset}`)

  // ── Auto-start daemon ─────────────────────────────────────────
  console.log(`\n${C.bold}启动 daemon...${C.reset}`)
  const r = spawnDaemonDetached()
  const sep = process.platform === 'win32' ? '\\' : '/'
  const logPath = process.platform === 'win32'
    ? `${process.env.LOCALAPPDATA ?? '%LOCALAPPDATA%'}\\Lodestar\\daemon-YYYY-MM-DD.log`
    : `${process.env.HOME ?? '~'}/.local/share/lodestar/daemon-YYYY-MM-DD.log`

  if (r.pid) {
    console.log(`${C.green}✓ daemon 已在后台启动${C.reset} (pid ${r.pid})`)
    console.log()
    console.log(`${C.bold}最后一步: 在 Feishu 验证${C.reset}`)
    console.log(`  ① 把机器人拉进任意飞书群`)
    console.log(`  ② 群名 = ${C.cyan}${projectsRoot}${sep}<群名>${C.reset} 下的目录名 (新群第一条消息会自动建)`)
    console.log(`  ③ 在群里发任意一条消息, 默认由 Claude 接管`)
    console.log(`     ${C.dim}(群里发 model 可切到 Codex·GPT-5.5)${C.reset}`)
    console.log()
    console.log(`日志 (按日滚动, 保留近 7 天):`)
    console.log(`  ${C.cyan}${logPath}${C.reset}`)
    console.log()
    console.log(`${C.dim}若长期跑后台, 参考 README "7×24 守护" 一节配 systemd / Windows 后台托管。${C.reset}`)
  } else {
    console.log(`${C.yellow}启动失败: ${r.error}${C.reset}`)
    console.log(`手动运行: ${C.cyan}lodestar-daemon${C.reset}`)
  }
  console.log()

  rl.close()
}
