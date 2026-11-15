import { historyId } from '../links/history'
import { owningProfile, type FolderProfile } from '../domain/profile-folders'
import type { HistoryEntry } from '../ports'

export interface HistoryGroup<T extends HistoryEntry = HistoryEntry> {
  /** The folder the sessions ran in; empty when the agent did not record one. */
  folder: string
  entries: T[]
  /** Newest `lastModified` of the group, for ordering. */
  lastModified: number
}

/** Lowercased words of a search box; an entry matches when every word is in one of its fields. */
function terms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

export function matchesHistory(entry: HistoryEntry, query: string): boolean {
  const words = terms(query)
  if (!words.length) return true
  const haystack = [entry.title, entry.firstPrompt, entry.cwd, entry.gitBranch, entry.agentSessionId]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  return words.every((w) => haystack.includes(w))
}

/**
 * The session history screen's model: entries that match the search, one group per folder,
 * newest group first and newest session first inside each. The same session listed by two
 * accounts (a copied transcript) is kept once, the most recent copy.
 */
export function groupHistory<T extends HistoryEntry>(entries: T[], query = ''): HistoryGroup<T>[] {
  const unique = new Map<string, T>()
  for (const e of entries) {
    const key = `${e.agentId}\u0000${e.agentSessionId}`
    const prev = unique.get(key)
    if (!prev || e.lastModified > prev.lastModified) unique.set(key, e)
  }
  const groups = new Map<string, T[]>()
  for (const e of unique.values()) {
    if (!matchesHistory(e, query)) continue
    const folder = e.cwd ?? ''
    const list = groups.get(folder)
    if (list) list.push(e)
    else groups.set(folder, [e])
  }
  return [...groups.entries()]
    .map(([folder, list]) => {
      list.sort((a, b) => b.lastModified - a.lastModified)
      return { folder, entries: list, lastModified: list[0]?.lastModified ?? 0 }
    })
    .sort((a, b) => b.lastModified - a.lastModified)
}

/** Folders whose sessions are throwaway runs (scratch checkouts, tests), not work to come back to. */
const THROWAWAY_PREFIXES = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/']

/** Whether a session ran in a temporary folder (Workhub 1 leaves these out of the history). */
export function isThrowawayFolder(cwd: string | undefined): boolean {
  if (!cwd) return false
  const folder = cwd.endsWith('/') ? cwd : `${cwd}/`
  return THROWAWAY_PREFIXES.some((p) => folder.startsWith(p))
}

/**
 * Whether a search box holds exactly this session's id (as Usage and reports asks when it shows one
 * session). Such a search lists the session even from a throwaway folder: the person asked for it.
 */
export function namesSession(entry: Pick<HistoryEntry, 'agentSessionId'>, query: string | undefined): boolean {
  const id = query?.trim().toLowerCase()
  return !!id && !!entry.agentSessionId && entry.agentSessionId.toLowerCase() === id
}

/** Whether History lists a session: never one from a throwaway folder unless the search names it. */
export function listedInHistory(entry: Pick<HistoryEntry, 'cwd' | 'agentSessionId'>, query?: string): boolean {
  return !isThrowawayFolder(entry.cwd) || namesSession(entry, query)
}

/**
 * Whether a past session belongs to a profile: it ran in a folder the profile owns (`owningProfile`:
 * its deepest folder holding the session's folder, else the profile that also owns everything
 * outside every profile's folders), or, in a folder no profile owns, with one of its accounts. Pass every profile
 * so a deeper folder of another profile wins; without them only this profile is considered. A
 * profile with neither folders nor accounts owns every session.
 */
export function historyInProfile(
  entry: Pick<HistoryEntry, 'cwd'> & { accountId?: HistoryEntry['accountId'] },
  profile: Partial<FolderProfile> & { accountIds: readonly string[] },
  scope: { profiles?: readonly FolderProfile[]; home?: string } = {}
): boolean {
  const folders = profile.folders ?? []
  if (!folders.length && !profile.accountIds.length) return true
  const self: FolderProfile = { id: profile.id ?? '\0this', folders: profile.folders, folderOptions: profile.folderOptions, ownsOutside: profile.ownsOutside }
  const all = scope.profiles?.some((p) => p.id === self.id) ? scope.profiles.map((p) => (p.id === self.id ? self : p)) : [self, ...(scope.profiles ?? [])]
  // The folder decides: profiles often share an account, so it only places work no profile owns.
  const owner = owningProfile(entry.cwd, all, scope.home)
  if (owner) return owner.id === self.id
  return Boolean(entry.accountId && profile.accountIds.includes(entry.accountId))
}

/** The history a folder's "Resume session…" sheet offers: sessions run in exactly that folder, newest first, not open now. */
export function sessionsOfFolder<T extends HistoryEntry>(entries: readonly T[], folder: string, open: ReadonlySet<string>, query = ''): T[] {
  const target = folder.replace(/[\\/]+$/, '')
  return groupHistory(entries.filter((e) => (e.cwd ?? '').replace(/[\\/]+$/, '') === target && !open.has(historyId(e))), query).flatMap((g) => g.entries)
}

/**
 * The past sessions whose agent session id is one of `keys` (sidebar group members are keyed by
 * it): what a closed member's name and account are looked up in. Every account's copy is kept;
 * `applyHistory` picks the newest.
 */
export function historyOfSessions<T extends HistoryEntry>(entries: readonly T[], keys: ReadonlySet<string>): T[] {
  return entries.filter((e) => keys.has(e.agentSessionId))
}

/**
 * The markers a History search snippet wraps its matches in: private-use characters, which never
 * appear in indexed text (the index strips them), so text that itself contains `<mark>` stays text.
 * The control endpoint turns them into `<mark>`…`</mark>` (`snippetHtmlMarks`).
 */
export const HISTORY_MARK = { open: '', close: '' } as const

export interface SnippetPart {
  text: string
  marked: boolean
}

/**
 * A search snippet split into plain and marked parts, so a screen renders the matches as elements
 * and the rest as text, never as HTML. A marker left open marks the rest of the text.
 */
export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = []
  let marked = false
  let text = ''
  const flush = () => {
    if (text) parts.push({ text, marked })
    text = ''
  }
  for (const ch of snippet) {
    if (ch === HISTORY_MARK.open || ch === HISTORY_MARK.close) {
      flush()
      marked = ch === HISTORY_MARK.open
    } else text += ch
  }
  flush()
  return parts
}

/** Parts back into a snippet with the private markers. */
export function joinSnippetParts(parts: readonly SnippetPart[]): string {
  return parts.map((p) => (p.marked ? `${HISTORY_MARK.open}${p.text}${HISTORY_MARK.close}` : p.text)).join('')
}

/**
 * A snippet shortened to at most `max` characters of text (markers not counted), cut between
 * parts or inside one, never inside a marker; every marked part stays closed. `…` ends a cut one.
 */
export function cutSnippet(snippet: string, max: number): string {
  const parts = snippetParts(snippet)
  if (parts.reduce((n, p) => n + [...p.text].length, 0) <= max) return joinSnippetParts(parts)
  const out: SnippetPart[] = []
  let left = Math.max(0, max - 1)
  for (const p of parts) {
    const chars = [...p.text]
    if (chars.length <= left) {
      out.push(p)
      left -= chars.length
      continue
    }
    if (left > 0) out.push({ text: chars.slice(0, left).join(''), marked: p.marked })
    break
  }
  out.push({ text: '…', marked: false })
  return joinSnippetParts(out)
}

/** A snippet with `<mark>`…`</mark>` around the matches, for answers read as text (control endpoint, MCP). */
export function snippetHtmlMarks(snippet: string): string {
  return snippetParts(snippet)
    .map((p) => (p.marked ? `<mark>${p.text}</mark>` : p.text))
    .join('')
}
