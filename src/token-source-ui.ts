/**
 * 飞书 config 命令的 UI 层 —— 让用户在飞书里增删 token source,不 SSH 改 config.toml。
 *
 * - `config` / `cfg` → 列出当前所有 token source(从 registry)+ 每个带 [🗑 删] + 新增引导
 * - `config add <id> claude <base_url> <token> [model]` → 新增 claude 第三方 source
 * - `config add <id> codex login [model]` → 新增 codex 订阅 source
 * - 点 [🗑 删] → onTokenSourceDelete → 写 config.toml + 热更新 registry + 刷新面板
 *
 * 持久化走 token-source-config.ts(写 config.toml + reloadTokenSources + buildTokenSourcesFromConfig),
 * daemon 不重启即生效。
 */

import * as feishu from './feishu'
import { listTokenSources } from './token-source'
import { addTokenSource, removeTokenSource } from './token-source-config'
import type { Session } from './session'

/** config 面板卡:列 token source + 删按钮 + 新增引导 */
export function configPanelCard(sessionName: string): object {
  const sources = listTokenSources()
  const rows = sources.length
    ? sources.map(s => `- \`${s.id}\` — ${s.display} · ${s.agent}/${s.defaultModel}`).join('\n')
    : '_无 token source(用 config add 新增)_'
  const buttons = sources.map(s => ({
    tag: 'button',
    text: { tag: 'plain_text', content: `🗑 删 ${s.id}` },
    type: 'danger',
    behaviors: [{ type: 'callback', value: { kind: 'token_source_delete', id: s.id } }],
  }))
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `⚙️ token source · ${sessionName}` },
      template: 'indigo',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            `**当前 token source:**\n${rows}\n\n` +
            `**➕ 新增(发文本):**\n` +
            `- 第三方:\`config add <id> claude <base_url> <token> [model]\`\n` +
            `- Codex 订阅:\`config add <id> codex login [model]\``,
        },
        ...buttons,
      ],
    },
  }
}

export async function showConfigPanel(s: Session): Promise<void> {
  const messageId = await feishu.sendCard(s.chatId, configPanelCard(s.sessionName))
  if (!messageId) await feishu.sendTextRaw(s.chatId, '❌ config 面板发送失败')
}

/** 卡片 [🗑 删] 回调:删 config.toml 节 + 热更新 registry + 刷新面板 */
export async function onTokenSourceDelete(s: Session, id: string): Promise<void> {
  const ok = removeTokenSource(id)
  await feishu.sendText(s.chatId, ok ? `✅ 已删除 token source \`${id}\`` : `❌ 未找到 \`${id}\``)
  if (ok) await showConfigPanel(s)
}

const ADD_USAGE =
  '用法:\n' +
  '- 第三方:`config add <id> claude <base_url> <token> [model]`\n' +
  '- Codex 订阅:`config add <id> codex login [model]`'

/** `config add ...` 文本命令:解析参数 + addTokenSource + 刷新面板 */
export async function runConfigAddCommand(s: Session, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/)
  if (parts.length < 3) {
    await feishu.sendText(s.chatId, ADD_USAGE)
    return
  }
  const [id, agent, third, fourth, fifth] = parts
  if (agent !== 'claude' && agent !== 'codex') {
    await feishu.sendText(s.chatId, `❌ agent 必须是 claude 或 codex(收到 ${agent})\n${ADD_USAGE}`)
    return
  }
  try {
    if (agent === 'codex') {
      // config add <id> codex login [model]
      if (third !== 'login') {
        await feishu.sendText(s.chatId, `❌ codex 用法:config add <id> codex login [model]`)
        return
      }
      addTokenSource(id, {
        agent: 'codex',
        auth: 'chatgpt-login',
        display: `Codex · ${id}`,
        model: fourth,
        effort: 'xhigh',
        usage: 'codex-rate-limit',
      })
    } else {
      // config add <id> claude <base_url> <token> [model]
      if (parts.length < 4) {
        await feishu.sendText(s.chatId, `❌ claude 第三方需要 base_url 和 token\n${ADD_USAGE}`)
        return
      }
      addTokenSource(id, {
        agent: 'claude',
        base_url: third,
        auth_token: fourth,
        display: `Claude · ${id}`,
        model: fifth,
        effort: 'max',
        usage: 'none',
      })
    }
    await feishu.sendText(s.chatId, `✅ 已新增 token source \`${id}\`,发 \`model\` 可选`)
    await showConfigPanel(s)
  } catch (e: any) {
    await feishu.sendText(s.chatId, `❌ 新增失败: ${e?.message ?? e}`)
  }
}
