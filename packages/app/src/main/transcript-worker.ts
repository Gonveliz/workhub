/**
 * The process that reads Claude transcripts for replayed conversations, away from the main process:
 * Electron's `utilityProcess` in the app (`TranscriptReader` starts it on demand and kills it when a
 * read outlives its budget). A 50 MB transcript takes seconds of JSON parsing, which on the main
 * process froze every window and terminal.
 *
 * It keeps a parse per file (`ClaudeTranscriptCache`, by size and modification time): a file that grew
 * is parsed from where the last read ended. Each `read` parses at most `chunkBytes` more and answers
 * the offset reached; the one that reaches the end also answers the messages (the last `last` only
 * when given), so a long first parse is a series of short requests other reads can come between.
 * Messages: `read` → `read` or `error`.
 */
import { ClaudeTranscriptCache, readTranscriptStep, type TranscriptRead } from '@workhub/adapters/agent-claude-native/history'

export interface TranscriptWorkerRead {
  type: 'read'
  id: number
  path: string
  chunkBytes: number
  last?: number
}
export type TranscriptWorkerReply = { type: 'read'; id: number; value: TranscriptRead } | { type: 'error'; id: number; message: string }

interface Port {
  post(msg: TranscriptWorkerReply): void
  listen(fn: (msg: unknown) => void): void
}

/** Electron's utility process has `process.parentPort`; a forked Node process has `process.send`. */
function port(): Port | null {
  const parent = (process as unknown as { parentPort?: { on(e: 'message', fn: (e: { data: unknown }) => void): void; postMessage(m: unknown): void } }).parentPort
  if (parent) return { post: (m) => parent.postMessage(m), listen: (fn) => parent.on('message', (e) => fn(e.data)) }
  if (typeof process.send === 'function') return { post: (m) => process.send!(m), listen: (fn) => process.on('message', fn) }
  return null
}

const cache = new ClaudeTranscriptCache()
const channel = port()
channel?.listen((raw) => {
  const msg = raw as TranscriptWorkerRead
  if (msg?.type !== 'read') return
  try {
    channel.post({ type: 'read', id: msg.id, value: readTranscriptStep(cache, msg.path, { chunkBytes: msg.chunkBytes, ...(msg.last ? { last: msg.last } : {}) }) })
  } catch (e) {
    channel.post({ type: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) })
  }
})
// A forked Node process outlives a parent that died without killing it; leave with the parent.
if (typeof process.send === 'function') process.on('disconnect', () => process.exit(0))
