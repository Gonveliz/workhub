// What the phone shows of a file it fetched from the desktop, without leaving the chat: an image,
// a Markdown document rendered, or any other text as it is. Everything else only downloads.
import type { RemoteFile } from '../shared/remote-api'

/** Text above this is not shown in the chat (it still downloads): a long log would bury the conversation. */
export const PREVIEW_TEXT_MAX_BYTES = 256 * 1024

/** Images drawn inline; SVG is left out because it can carry scripts. */
const INLINE_IMAGE = /^image\/(png|jpeg|gif|webp)$/

export type FilePreview = { kind: 'image' } | { kind: 'markdown'; text: string } | { kind: 'text'; text: string } | { kind: 'tooLong' }

/** The bytes of a base64 string, or null when it is not base64. */
function bytesOf(data: string): Uint8Array | null {
  try {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/** The text of `bytes` when they are UTF-8 text (no NUL byte, which only binary files have), else null. */
function textOf(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * How a fetched file is shown in the chat, or null when it only downloads (a PDF, an archive, an
 * SVG, any binary). The content decides whether a file is text, not its extension, so source
 * files and configuration of any kind preview too.
 */
export function filePreview(file: RemoteFile): FilePreview | null {
  if (INLINE_IMAGE.test(file.mime)) return { kind: 'image' }
  if (file.mime.startsWith('image/') || file.mime === 'application/pdf') return null
  const bytes = bytesOf(file.data)
  if (!bytes) return null
  // Too long to show: say so when it is text (judged by its start), stay quiet for a binary.
  if (bytes.length > PREVIEW_TEXT_MAX_BYTES) return textOf(bytes.subarray(0, lastWholeChar(bytes, 4096))) === null ? null : { kind: 'tooLong' }
  const text = textOf(bytes)
  if (text === null) return null
  return file.mime === 'text/markdown' ? { kind: 'markdown', text } : { kind: 'text', text }
}

/** `end` moved back so it does not cut a multi-byte UTF-8 character in two. */
function lastWholeChar(bytes: Uint8Array, end: number): number {
  let i = Math.min(end, bytes.length)
  while (i > 0 && (bytes[i]! & 0xc0) === 0x80) i--
  return i
}
