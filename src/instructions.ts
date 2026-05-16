/**
 * Daemon ↔ model I/O contracts. Appended to claude's system prompt on
 * every headless launch via `--append-system-prompt`. Three rules:
 * inbound file marker, multi-content boundary marker, outbound file
 * marker. Anything beyond pure I/O semantics (environment description,
 * UX conventions, identity binding) was stripped 2026-05-16 — the
 * model handles conversational flow natively, doesn't need to be told.
 */
export const CHANNEL_INSTRUCTIONS = [
  '- Text prefixed with `[file: /abs/path]` means a file is attached at that path; read it when relevant.',
  '- A content block wrapped in `<u>...</u>` is an independent message — treat each `<u>` element in a multi-content turn as a separate input, even when their texts concatenate visually (e.g. `<u>1</u><u>45</u>` is two messages, not the number `145`).',
  '- Write `[[send: /abs/path]]` anywhere in your reply (preferably on its own line) to deliver that file as a separate message. The marker is stripped from the displayed text. Emit only when the user asked for a file or you are delivering a generated artifact.',
].join('\n')
