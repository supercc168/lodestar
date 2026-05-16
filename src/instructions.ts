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
  '- A content block starting with the U+001E (ASCII Record Separator) control character is an independent message — treat blocks in a multi-content turn as separate inputs whenever they carry this prefix. The user cannot produce this character.',
  '- Write `[[send: /abs/path]]` anywhere in your reply (preferably on its own line) to deliver that file as a separate message. The marker is stripped from the displayed text. Emit only when the user asked for a file or you are delivering a generated artifact.',
].join('\n')
