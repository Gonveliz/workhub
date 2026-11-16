/**
 * Text waiting in the composer of a session that does not exist on screen yet (Investigate with
 * Claude): the draft is written for a new session and taken by its chat the first time it shows.
 * It is never sent by the app.
 */
const drafts = new Map<string, string>()
const listeners = new Set<(sessionId: string) => void>()

export function setComposerDraft(sessionId: string, text: string): void {
  drafts.set(sessionId, text)
  for (const l of listeners) l(sessionId)
}

/** Takes the draft of a session (once). */
export function takeComposerDraft(sessionId: string): string | undefined {
  const text = drafts.get(sessionId)
  drafts.delete(sessionId)
  return text
}

export function onComposerDraft(cb: (sessionId: string) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/**
 * The text of each session's composer, kept across the pane unmounting: detaching a session to
 * its own window, or docking it back, remounts its chat. Stored in `localStorage`, which the
 * app's windows share, so the draft follows the session. Text only; pasted images stay in memory.
 */
const KEY = 'workhub.composerDrafts'
const WRITE_DELAY_MS = 400

function storage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

function readAll(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''))
  } catch {
    return {}
  }
}

function writeAll(all: Record<string, string>): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(all))
  } catch {
    // Storage full or unavailable: the draft is only lost on a remount.
  }
}

const pending = new Map<string, string>()
let timer: ReturnType<typeof setTimeout> | undefined

/** Writes what typing left waiting (debounced), merged into what other windows stored. */
export function flushStoredDrafts(): void {
  if (timer) clearTimeout(timer)
  timer = undefined
  if (pending.size === 0) return
  const all = readAll()
  for (const [id, text] of pending) {
    if (text === '') delete all[id]
    else all[id] = text
  }
  pending.clear()
  writeAll(all)
}

/** Remembers the composer text of a session; an empty text forgets it. Written after typing pauses. */
export function saveStoredDraft(sessionId: string, text: string): void {
  pending.set(sessionId, text)
  if (timer) clearTimeout(timer)
  timer = setTimeout(flushStoredDrafts, WRITE_DELAY_MS)
}

/** The stored composer text of a session ('' when none). */
export function loadStoredDraft(sessionId: string): string {
  const waiting = pending.get(sessionId)
  return waiting ?? readAll()[sessionId] ?? ''
}

/** Forgets a session's draft: it was sent, or the session is gone. */
export function clearStoredDraft(sessionId: string): void {
  saveStoredDraft(sessionId, '')
  flushStoredDrafts()
}
