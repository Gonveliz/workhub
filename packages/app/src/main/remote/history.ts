import { cutSnippet, type HistoryMessage } from '@workhub/core'
import type { HistoryMatch, HistorySearchResult } from '../../shared/api'
import type { RemoteHistoryPage } from '../../shared/remote-api'

/** One page of a session's conversation stays well under the relay's frame once sealed. */
export const HISTORY_PAGE_BYTES = 160 * 1024
/** And holds at most this many messages, so the phone renders a page at once. */
export const HISTORY_PAGE_MAX = 150
/** A single message larger than this loses its bulk (tool output and diffs, then long text). */
const ONE_MAX_BYTES = 24 * 1024
const TEXT_MAX_CHARS = 12_000

export type HistoryPage = RemoteHistoryPage

const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))
const cut = (text: string): string => (text.length > TEXT_MAX_CHARS ? `${text.slice(0, TEXT_MAX_CHARS)}…` : text)

/** A message as the phone needs it: no image bytes, and nothing so large it crowds out the rest of the page. */
export function slimMessage(m: HistoryMessage): HistoryMessage {
  if (m.kind === 'user') {
    const { imageData: _images, ...rest } = m
    return { ...rest, text: cut(m.text) }
  }
  if (sizeOf(m) <= ONE_MAX_BYTES) return m
  switch (m.kind) {
    case 'agent':
      return { ...m, text: cut(m.text) }
    case 'notice':
      return { ...m, text: cut(m.text) }
    case 'compaction':
      return m.summary === undefined ? m : { ...m, summary: cut(m.summary) }
    case 'tool': {
      const { result: _result, view, ...rest } = m
      const lean = { ...rest, ...(m.detail ? { detail: cut(m.detail) } : {}) }
      return view && sizeOf({ ...lean, view }) <= ONE_MAX_BYTES ? { ...lean, view } : lean
    }
    default:
      return m
  }
}

/**
 * The newest messages before `before` (the whole conversation when omitted) that fit one page.
 * The phone asks for the last page when it opens a chat and for the one before `start` as the
 * person scrolls up. Indexes count from the conversation's first message, which only grows.
 */
export function pageHistory(all: readonly HistoryMessage[], before?: number): HistoryPage {
  const end = before === undefined ? all.length : Math.max(0, Math.min(all.length, Math.floor(before)))
  const page: HistoryMessage[] = []
  let bytes = 0
  let start = end
  while (start > 0 && page.length < HISTORY_PAGE_MAX) {
    const m = slimMessage(all[start - 1]!)
    const size = sizeOf(m)
    if (page.length > 0 && bytes + size > HISTORY_PAGE_BYTES) break
    page.push(m)
    bytes += size
    start--
  }
  return { messages: page.reverse(), start, total: all.length }
}

/** A search answer stays this small (the relay's frame is about 520 KB once sealed). */
export const HISTORY_SEARCH_BYTES = 200 * 1024
const SEARCH_TEXT_MAX = 400

/**
 * History search as a paired device gets it: title, first prompt and snippets shortened (snippets
 * between their parts, never inside a marker), and only as many matches as fit
 * `HISTORY_SEARCH_BYTES`. When some do not fit, `nextCursor` resumes at the first one left out.
 */
export function remoteHistorySearch(result: HistorySearchResult): HistorySearchResult {
  const short = (text: string) => (text.length > SEARCH_TEXT_MAX ? `${text.slice(0, SEARCH_TEXT_MAX - 1)}…` : text)
  const entries: HistoryMatch[] = []
  let bytes = 0
  for (const e of result.entries) {
    const { firstPrompt, snippet, titleSnippet, ...rest } = e
    const slim: HistoryMatch = { ...rest, title: short(e.title) }
    if (firstPrompt) slim.firstPrompt = short(firstPrompt)
    if (snippet) slim.snippet = cutSnippet(snippet, SEARCH_TEXT_MAX)
    if (titleSnippet) slim.titleSnippet = cutSnippet(titleSnippet, SEARCH_TEXT_MAX)
    const size = sizeOf(slim)
    if (entries.length > 0 && bytes + size > HISTORY_SEARCH_BYTES) break
    entries.push(slim)
    bytes += size
  }
  const { nextCursor: _next, ...base } = result
  const cut = entries.length < result.entries.length
  const nextCursor = cut ? String(result.start + entries.length) : result.nextCursor
  return { ...base, entries, ...(nextCursor ? { nextCursor } : {}) }
}
