/** Message freshness is measured when the daemon accepts the WS event, not
 * when a per-chat FIFO eventually gets around to processing it. */
export function isStaleAtReceipt(
  createTime: number,
  receivedAt: number,
  thresholdMs: number,
): boolean {
  return createTime > 0 && receivedAt - createTime > thresholdMs
}

/** One incoming text is consumed by exactly one pending interaction. Lower
 * priority Agent routing runs only when this returns false. */
export async function consumePendingTextInput(handlers: {
  reply(): Promise<boolean>
  hasQuestion(): boolean
  answerQuestion(): Promise<void>
}): Promise<boolean> {
  if (await handlers.reply()) return true
  if (!handlers.hasQuestion()) return false
  await handlers.answerQuestion()
  return true
}

/** 通知回复消费门控:text 与 post 都可能承载"一条文字"(post 已按 markdown 解码),
 *  带附件的 post 另有普通新轮路径。 */
export function acceptsPendingReplyText(
  messageType: unknown,
  text: unknown,
  postHasAttachments: boolean,
): boolean {
  return (messageType === 'text' || messageType === 'post') && !!text && !postHasAttachments
}

/** 提问回答只认 text-only 消息 —— 与本文件下方 daemon 的保留注释一致:post / 图片 /
 *  文件 / 视频附件都按一次新轮处理(02-REVIEW WR-04)。 */
export function acceptsPendingQuestionText(messageType: unknown, text: unknown): boolean {
  return messageType === 'text' && !!text
}

export interface InboundMessageResource {
  key: string
  type: 'image' | 'file'
  name?: string
  displayText: string
}

export function inboundResourceDownloadFailureText(messageType: unknown): string {
  const label = messageType === 'media' ? '视频' : messageType === 'image' ? '图片' : '文件'
  return `❌ 收到的${label}下载失败，未转交给 Agent。备注：可能是${label}超过飞书消息资源 100 MB 下载上限。`
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Map Feishu's native attachment message types onto the resource download
 * API. Video messages arrive as `media`, but their binary payload is fetched
 * with `type=file`; `image_key` is only the video's preview thumbnail. */
export function inboundMessageResource(
  messageType: unknown,
  content: unknown,
): InboundMessageResource | null {
  if (!content || typeof content !== 'object') return null
  const body = content as Record<string, unknown>

  if (messageType === 'image') {
    const key = nonEmptyString(body.image_key)
    return key ? { key, type: 'image', displayText: '' } : null
  }

  if (messageType !== 'file' && messageType !== 'media') return null
  const key = nonEmptyString(body.file_key)
  if (!key) return null
  const name = nonEmptyString(body.file_name)
  const kind = messageType === 'media' ? 'video' : 'file'
  return {
    key,
    type: 'file',
    ...(name ? { name } : {}),
    displayText: name ? `(${kind}: ${name})` : '',
  }
}
