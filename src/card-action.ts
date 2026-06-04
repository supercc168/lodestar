export interface ActionCardUpdateDeps {
  updateCard: (messageId: string, card: object) => Promise<void>
  sendText: (chatId: string, text: string) => Promise<unknown>
  log: (message: string) => void
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function updateActionCard(
  messageId: string,
  chatId: string,
  card: object,
  message: string,
  deps: ActionCardUpdateDeps,
): Promise<void> {
  // WSClient sends the dispatcher return value back to Feishu. Returning
  // a toast/card after message.patch can race with, and visually revert,
  // the actively patched card, so this path intentionally returns void.
  if (!messageId) {
    await deps.sendText(chatId, `❌ 卡片更新失败: 缺少 message_id\n${message}`)
    return
  }
  try {
    await deps.updateCard(messageId, card)
  } catch (e) {
    const err = messageOf(e)
    deps.log(`card action update failed message=${messageId}: ${err}`)
    await deps.sendText(chatId, `❌ 卡片更新失败: ${err}\n${message}`)
  }
}
