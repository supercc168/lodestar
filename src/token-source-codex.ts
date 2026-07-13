/**
 * Codex 订阅 token source(ChatGPT login)—— 自包含 provider 模块。
 *
 * 模型 = app-server `model/list` 动态拉(per-model effort、过滤 hidden);
 * 额度 = account/rateLimits/read(真);enabled = ~/.codex/auth.json 在。
 * 模块加载时 registerTokenSourceFactory 声明式登记。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { config, type TokenSourceConfig } from './config'
import {
  type TokenSource,
  type UsageSnapshotUnified,
  type UsageWindowUnified,
  scrubAnthropicEnv,
  registerTokenSourceFactory,
} from './token-source'
import { readUsage, type UsageSnapshot, type UsageWindow } from './usage'
import { fetchCodexModels } from './token-source-models'
import { log } from './log'

type Env = Record<string, string | undefined>

function windowToUnified(w: UsageWindow, kind: string, label: string): UsageWindowUnified {
  return { kind, label, percent: w.percent, resetsAt: w.resetsAt }
}

function codexUsageToUnified(s: UsageSnapshot): UsageSnapshotUnified {
  if (s.state !== 'ok') {
    return {
      state: s.state === 'auth_failed' ? 'no_credentials'
        : s.state === 'no_credentials' ? 'no_credentials'
        : s.state === 'rate_limited' ? 'rate_limited'
        : 'network',
      windows: [],
    }
  }
  const windows: UsageWindowUnified[] = []
  if (s.fiveHour) windows.push(windowToUnified(s.fiveHour, 'fiveHour', '5h 窗口'))
  if (s.weekly) windows.push(windowToUnified(s.weekly, 'weekly', '周配额'))
  return { state: 'ok', planLabel: s.subscriptionType, windows, fetchedAt: s.fetchedAt }
}

/** codex 本地登录态:~/.codex/auth.json 存在即视为已配置(廉价同步信号;
 *  订阅是否有效在 account/rateLimits 查询时如实暴露 MISS)。 */
function codexLoggedIn(): boolean {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
  return existsSync(join(codexHome, 'auth.json'))
}

registerTokenSourceFactory({
  kind: 'codex-subscription',
  // codex 走本地 ChatGPT login,无 config 节。
  build: (_cfg: TokenSourceConfig): TokenSource => {
    const enabled = codexLoggedIn()
    const ts: TokenSource = {
      id: 'codex-sub',
      kind: 'codex-subscription',
      agent: 'codex',
      display: 'Codex 订阅',
      capabilities: { resumeSessionAt: false, fork: false, hostAsk: true },
      enabled,
      models: [],
      defaultModel: 'gpt-5.5',
      async refreshModels(): Promise<void> {
        if (!ts.enabled) { ts.models = []; return }
        try {
          ts.models = await fetchCodexModels()
          if (ts.models.length) ts.defaultModel = ts.models[0].model
        } catch (e: any) {
          log(`codex-sub refreshModels MISS: ${e?.message ?? e}`)
          ts.models = []
        }
      },
      spawnEnv(base: Env): Env {
        const out = scrubAnthropicEnv(base)
        Object.assign(out, config.codex.env)
        return out
      },
      resolveSpawnModel(model: string): string {
        return model
      },
      async readUsage(): Promise<UsageSnapshotUnified> {
        return codexUsageToUnified(await readUsage())
      },
    }
    return ts
  },
})
