// Long lists a paired device reads a page at a time: every answer must fit one relay frame, and a
// profile with thousands of pull requests (or a desktop with many sessions, each carrying its
// agent's commands) would not fit in one.
import type { RemotePage, RemotePageRequest } from '../../shared/remote-api'

/** Items in a page when the device names no limit, and the most it may ask for. */
export const PAGE_DEFAULT = 50
export const PAGE_MAX = 200
/** A page stops before this many bytes of JSON, well under the relay's frame once sealed. */
export const PAGE_BYTES = 192 * 1024
/** A cursor longer than this is not one the desktop made. */
const CURSOR_MAX_CHARS = 2048
/** Keys of the last items sent a cursor remembers, newest first: the next page resumes after the first one still listed. */
export const CURSOR_KEYS = 5
const KEY_MAX_CHARS = 300

/** Where the previous page ended: the list's length up to there, and the keys of its last items (newest first). */
interface Cursor {
  o: number
  k: string[]
}

export interface PageRequest {
  limit: number
  cursor: Cursor | null
}

export class PageRequestError extends Error {}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(raw: string): Cursor {
  const invalid = () => new PageRequestError('the cursor is not valid')
  if (raw.length > CURSOR_MAX_CHARS || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid()
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw invalid()
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid()
  const c = parsed as { o?: unknown; k?: unknown }
  if (typeof c.o !== 'number' || !Number.isInteger(c.o) || c.o < 0) throw invalid()
  if (!Array.isArray(c.k) || c.k.length === 0 || c.k.length > CURSOR_KEYS || !c.k.every((k) => typeof k === 'string')) throw invalid()
  return { o: c.o, k: c.k as string[] }
}

/** Reads `{ limit, cursor }` as a device sent it; anything else in the object is ignored. */
export function readPageRequest(value: unknown): PageRequest {
  if (value === undefined || value === null) return { limit: PAGE_DEFAULT, cursor: null }
  if (typeof value !== 'object' || Array.isArray(value)) throw new PageRequestError('the page request is not valid')
  const { limit, cursor } = value as RemotePageRequest
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) throw new PageRequestError('the page limit is not valid')
  if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') throw new PageRequestError('the cursor is not valid')
  return { limit: Math.min(limit ?? PAGE_DEFAULT, PAGE_MAX), cursor: cursor ? decodeCursor(cursor) : null }
}

export const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '')

/**
 * Keys that are unique within the list: a key seen before gets its occurrence appended, so a
 * cursor always names one position (two rows with one key would otherwise send it backwards).
 */
function uniqueKeys<T>(all: readonly T[], keyOf: (item: T) => string): string[] {
  const seen = new Map<string, number>()
  return all.map((item) => {
    const key = String(keyOf(item)).slice(0, KEY_MAX_CHARS)
    const n = seen.get(key) ?? 0
    seen.set(key, n + 1)
    return n === 0 ? key : `${key}#${n}`
  })
}

/** Where the page after `cursor` starts in `keys`. */
function resumeAt(keys: readonly string[], cursor: Cursor, limit: number): number {
  const [last] = cursor.k
  // The list did not move before the cursor: the usual case.
  if (cursor.o > 0 && cursor.o <= keys.length && keys[cursor.o - 1] === last) return cursor.o
  // It moved: after the newest of the items sent that is still listed.
  for (const key of cursor.k) {
    const at = keys.indexOf(key)
    if (at >= 0) return at + 1
  }
  // None of them is left: a page back, so nothing is skipped (the device drops what it already has).
  return Math.min(keys.length, Math.max(0, cursor.o - limit))
}

export interface PageOptions<T> {
  /** The most bytes of JSON the page's items may take (`PAGE_BYTES` by default). */
  maxBytes?: number
  /** What stands for an item too large for a page on its own, so the page can still be sent. */
  stub?: (item: T) => T
}

/**
 * The page of `all` after the cursor: at most `limit` items and `maxBytes` (always at least one
 * item, or its stub). Keys must identify items across reads; the device drops repeats by key.
 */
export function pageOf<T>(all: readonly T[], request: PageRequest, keyOf: (item: T) => string, options: PageOptions<T> = {}): RemotePage<T> {
  const maxBytes = options.maxBytes ?? PAGE_BYTES
  const keys = uniqueKeys(all, keyOf)
  const start = request.cursor ? resumeAt(keys, request.cursor, request.limit) : 0
  const items: T[] = []
  let bytes = 0
  let end = start
  while (end < all.length && items.length < request.limit) {
    let item: T = all[end] as T
    let size = sizeOf(item)
    if (size > maxBytes && options.stub) {
      item = options.stub(item)
      size = sizeOf(item)
    }
    if (items.length > 0 && bytes + size > maxBytes) break
    items.push(item)
    bytes += size
    end++
  }
  const nextCursor = end < all.length && end > start ? encodeCursor({ o: end, k: keys.slice(Math.max(start, end - CURSOR_KEYS), end).reverse() }) : null
  return { items, nextCursor, total: all.length }
}
