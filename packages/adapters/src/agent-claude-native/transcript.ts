/**
 * Incremental reading of a Claude transcript (`<config dir>/projects/<project>/<id>.jsonl`) for the
 * replayed conversation. A file is parsed once: what is kept per file is the lines the chain walk
 * needs (only links for system lines, sidechains and meta lines; the content only for main-thread
 * user and assistant lines), the byte offset parsed up to, its size and modification time, and its
 * first 4 KB. A file that grew is parsed from that offset; one whose head changed or that shrank was
 * rewritten and is parsed again from the start. Reads are synchronous: this runs in the transcript
 * worker's process (`main/transcript-worker.ts`), or in tests.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/** The fields of a transcript line the replay needs. */
export interface TranscriptLine extends Obj {
  uuid: string
}

/** What a file's parse has gathered so far. */
export interface TranscriptState {
  byId: Map<string, TranscriptLine>
  tip: TranscriptLine | undefined
  tipAt: number
}

export function emptyTranscriptState(): TranscriptState {
  return { byId: new Map(), tip: undefined, tipAt: -Infinity }
}

/** Keys every line keeps: what walks the chain and decides whether a line is replayed. */
const LINK_KEYS = ['type', 'subtype', 'parentUuid', 'logicalParentUuid', 'isSidechain', 'isMeta', 'timestamp']
/** Keys a main-thread user or assistant line keeps besides: what `toHistoryMessages` reads. */
const CONTENT_KEYS = ['parent_tool_use_id', 'isCompactSummary', 'toolUseResult', 'tool_use_result']

function compact(line: Obj, uuid: string): TranscriptLine {
  const out: TranscriptLine = { uuid }
  for (const k of LINK_KEYS) if (line[k] !== undefined) out[k] = line[k]
  const replayed = (line['type'] === 'user' || line['type'] === 'assistant') && line['isSidechain'] !== true && line['isMeta'] !== true
  if (!replayed) return out
  for (const k of CONTENT_KEYS) if (line[k] !== undefined) out[k] = line[k]
  const message = obj(line['message'])
  if (message && message['content'] !== undefined) out['message'] = { content: message['content'] }
  return out
}

/** Adds one line of the file, in file order; a line that is not JSON is skipped. */
export function feedTranscriptLine(state: TranscriptState, row: string): void {
  if (!row.includes('"uuid"')) return
  let parsed: unknown
  try {
    parsed = JSON.parse(row)
  } catch {
    return
  }
  const line = obj(parsed)
  const uuid = str(line?.['uuid'])
  if (!line || !uuid) return
  const kept = compact(line, uuid)
  state.byId.set(uuid, kept)
  if ((line['type'] !== 'user' && line['type'] !== 'assistant') || line['isSidechain'] === true || line['isMeta'] === true) return
  const at = Date.parse(str(line['timestamp']) ?? '')
  if (!Number.isNaN(at) && at >= state.tipAt) {
    state.tip = kept
    state.tipAt = at
  }
}

/**
 * The conversation's lines, oldest first. The SDK only returns the chain since the last compaction,
 * so this takes the newest main-thread message, walks `parentUuid` back and crosses each
 * `compact_boundary` through its `logicalParentUuid`; null when there is no main-thread message.
 */
export function transcriptChain(state: TranscriptState): TranscriptLine[] | null {
  if (!state.tip) return null
  const chain: TranscriptLine[] = []
  const seen = new Set<string>()
  for (let cur: TranscriptLine | undefined = state.tip; cur && !seen.has(cur.uuid); ) {
    seen.add(cur.uuid)
    if (cur['type'] === 'user' || cur['type'] === 'assistant') chain.push(cur)
    const parent: string | undefined = str(cur['parentUuid']) ?? (cur['subtype'] === 'compact_boundary' ? str(cur['logicalParentUuid']) : undefined)
    cur = parent ? state.byId.get(parent) : undefined
  }
  return chain.reverse().filter((l) => l['isSidechain'] !== true && l['isMeta'] !== true)
}

/** The whole text of a transcript, parsed at once. */
export function parseTranscriptText(text: string): TranscriptState {
  const state = emptyTranscriptState()
  for (const row of text.split('\n')) feedTranscriptLine(state, row)
  return state
}

/** Bytes of a file's start compared to tell a file that grew from one that was rewritten. */
export const TRANSCRIPT_HEAD_BYTES = 4096
/** Bytes parsed per call when the caller does not say. */
export const TRANSCRIPT_CHUNK_BYTES = 8 * 1024 * 1024

interface CachedFile {
  state: TranscriptState
  size: number
  mtimeMs: number
  /** Bytes parsed: the file up to here is in `state`. */
  offset: number
  /** The file's first bytes, up to `TRANSCRIPT_HEAD_BYTES`, as they were when parsed. */
  head: Buffer
  /** The last call read up to the end of the file as it was then (`size`, `mtimeMs`). */
  complete: boolean
}

export interface TranscriptAdvance {
  /** The parse reached the end of the file: `state` holds all of it. */
  done: boolean
  /** Bytes parsed so far, and the file's size. */
  offset: number
  size: number
  /** Bytes parsed by this call (0 when the file had not changed). */
  parsed: number
  state: TranscriptState
}

function wholeJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function readRange(fd: number, from: number, to: number): Buffer {
  const buf = Buffer.allocUnsafe(Math.max(0, to - from))
  let got = 0
  while (got < buf.length) {
    const n = readSync(fd, buf, got, buf.length - got, from + got)
    if (n === 0) break
    got += n
  }
  return buf.subarray(0, got)
}

/**
 * Parsed transcripts by path, keyed by size and modification time. Holds at most `maxBytes` of
 * parsed files (by their size on disk), the least recently read dropped first; the file just read
 * always stays.
 */
export class ClaudeTranscriptCache {
  private readonly files = new Map<string, CachedFile>()

  constructor(private readonly maxBytes = 256 * 1024 * 1024) {}

  /** Paths cached, least recently read first (tests). */
  paths(): string[] {
    return [...this.files.keys()]
  }

  /**
   * Parses at most about `chunkBytes` more of the file (a line longer than that is read whole);
   * `done` once the end is reached. A file that is unchanged since it was parsed to its end is not
   * read at all. Throws when the file cannot be read.
   */
  advance(path: string, chunkBytes = TRANSCRIPT_CHUNK_BYTES): TranscriptAdvance {
    const st = statSync(path)
    let file = this.files.get(path)
    this.files.delete(path)
    if (file && file.complete && file.size === st.size && file.mtimeMs === st.mtimeMs) {
      this.files.set(path, file)
      return { done: true, offset: file.offset, size: file.size, parsed: 0, state: file.state }
    }
    const fd = openSync(path, 'r')
    try {
      // Rewritten (shorter than what was parsed, or another start): parse it again from the start.
      if (file && (st.size < file.offset || !readRange(fd, 0, file.head.length).equals(file.head))) file = undefined
      file ??= { state: emptyTranscriptState(), size: 0, mtimeMs: 0, offset: 0, head: Buffer.alloc(0), complete: false }
      file.size = st.size
      file.mtimeMs = st.mtimeMs
      const start = file.offset
      let end = Math.min(st.size, start + Math.max(1, chunkBytes))
      let buf = readRange(fd, start, end)
      let cut = buf.lastIndexOf(0x0a)
      // A line longer than the chunk: read on until its end.
      while (cut < 0 && end < st.size) {
        end = Math.min(st.size, end + Math.max(1, chunkBytes))
        buf = readRange(fd, start, end)
        cut = buf.lastIndexOf(0x0a)
      }
      const atEnd = end >= st.size
      let consumed = cut + 1
      const text = buf.toString('utf8', 0, consumed)
      for (const row of text.split('\n')) feedTranscriptLine(file.state, row)
      // The last line without its newline yet: kept only once it is whole JSON (an agent still writing it is read next time).
      if (atEnd && consumed < buf.length) {
        const rest = buf.toString('utf8', consumed)
        if (wholeJson(rest)) {
          feedTranscriptLine(file.state, rest)
          consumed = buf.length
        }
      }
      file.offset = start + consumed
      file.complete = atEnd
      if (file.head.length < TRANSCRIPT_HEAD_BYTES && file.offset > file.head.length) file.head = readRange(fd, 0, Math.min(TRANSCRIPT_HEAD_BYTES, file.offset))
      this.files.set(path, file)
      this.evict(path)
      return { done: atEnd, offset: file.offset, size: st.size, parsed: consumed, state: file.state }
    } finally {
      closeSync(fd)
    }
  }

  /** Forgets a file (it could not be read). */
  drop(path: string): void {
    this.files.delete(path)
  }

  private evict(keep: string): void {
    let total = 0
    for (const f of this.files.values()) total += f.offset
    for (const [path, f] of this.files) {
      if (total <= this.maxBytes) break
      if (path === keep) continue
      this.files.delete(path)
      total -= f.offset
    }
  }
}
