import { accountAgentId, knownAgents, matchesHistory, type AgentDefinition, type HistoryEntry, type SessionHistorySource, type WorkhubConfig } from '@workhub/core'
import { historyIndexKey, type HistoryScope, type HistorySnippets } from '@workhub/adapters/sqlite-store'
import type { HistoryIndexProgress, HistoryItem, HistoryMatch, HistoryResult, HistorySearchOptions, HistorySearchResult } from '../shared/api'
import { claudeAccounts } from './claude-accounts'

/** One place an agent keeps sessions: its default folder (`accountId` null) or an account's config folder. */
export interface HistoryAccountRef {
  accountId: string | null
  /** Empty for the default folder. */
  name: string
  configDir?: string
}

/**
 * The folders to list for an agent. Claude: its accounts plus the default folder. Agents with a
 * per-account config folder (Codex): the default folder plus each account that sets one. Agents
 * with a single data folder (Kiro, OpenCode): that folder once.
 */
export function historyAccounts(config: WorkhubConfig, agent: AgentDefinition, home: string): HistoryAccountRef[] {
  if (agent.id === 'claude') return claudeAccounts(config, home)
  const refs: HistoryAccountRef[] = [{ accountId: null, name: '' }]
  if (!agent.accountConfigEnv) return refs
  for (const a of config.accounts) {
    if (a.agentId === accountAgentId(agent) && a.configDir) refs.push({ accountId: a.id, name: a.name, configDir: a.configDir })
  }
  return refs
}

/** An agent account as `HistoryResult.listed` and `accounts` name it. */
export function historyAccountKey(agentId: string, accountId: string | null | undefined): string {
  return `${agentId}\u0000${accountId ?? ''}`
}

/** Whether a past session of the agent can be opened again from the history. */
export function canResume(agent: AgentDefinition): boolean {
  return agent.adapter === 'native' || agent.console !== undefined
}

/** Sessions listed per account at first, and how many more each "older sessions" request adds. */
export const HISTORY_LIST_DEPTH = 400

export interface ListHistoryOptions {
  /** Most sessions read from each account's files (`HISTORY_LIST_DEPTH` by default). */
  depth?: number
  /** The sessions of an account the search index holds (`SqliteHistoryIndex.entries`). */
  indexed?: (agentId: string, accountId: string | null) => HistoryEntry[]
}

/**
 * The newest `depth` sessions of an account. When it has more, the account is `truncated`, and the
 * older sessions the index holds whose transcript is still on disk are listed too, read from the
 * index rather than from their files; the listing then still has every session the index may keep
 * (`complete`). A source that cannot tell which transcripts exist leaves its older sessions out of
 * the listing but in the index: a cut listing never drops anything.
 */
async function listAccount(source: SessionHistorySource, account: { agentId: string; accountId: string | null; configDir?: string }, options: ListHistoryOptions): Promise<{ entries: HistoryEntry[]; truncated: boolean; complete: boolean }> {
  const depth = options.depth ?? HISTORY_LIST_DEPTH
  // One more than shown: whether the account has more is then known without a second read.
  const listed = (await source.list(account, { limit: depth + 1 })).sort((x, y) => y.lastModified - x.lastModified)
  if (listed.length <= depth) return { entries: listed, truncated: false, complete: true }
  const entries = listed.slice(0, depth)
  if (!source.sessionIds || !options.indexed) return { entries, truncated: true, complete: false }
  let onDisk: ReadonlySet<string>
  try {
    onDisk = await source.sessionIds(account)
  } catch {
    return { entries, truncated: true, complete: false }
  }
  const shown = new Set(entries.map((e) => e.agentSessionId))
  const older = options.indexed(account.agentId, account.accountId).filter((e) => !shown.has(e.agentSessionId) && onDisk.has(e.agentSessionId))
  return { entries: [...entries, ...older], truncated: true, complete: true }
}

/**
 * Every past session of every known agent that has a history source, newest first, up to
 * `options.depth` per account plus the older ones the index holds (see `listAccount`). An agent or
 * account that fails is reported, not fatal.
 */
export async function listAllHistory(config: WorkhubConfig, home: string, sources: Partial<Record<string, SessionHistorySource>>, options: ListHistoryOptions = {}): Promise<HistoryResult> {
  const result: HistoryResult = { entries: [], errors: [], listed: [], accounts: [], truncated: [] }
  const agents = knownAgents(config).filter((a) => a.capabilities.history && !a.accountsOf && sources[a.id])
  for (const agent of agents) for (const a of historyAccounts(config, agent, home)) result.accounts!.push(historyAccountKey(agent.id, a.accountId))
  await Promise.all(
    agents.flatMap((agent) =>
      historyAccounts(config, agent, home).map(async (a) => {
        try {
          const { entries, truncated, complete } = await listAccount(sources[agent.id]!, { agentId: agent.id, accountId: a.accountId, configDir: a.configDir }, options)
          const resumable = canResume(agent)
          result.entries.push(...entries.map((e): HistoryItem => ({ ...e, agentName: agent.name, resumable, accountName: a.name || undefined })))
          if (complete) result.listed!.push(historyAccountKey(agent.id, a.accountId))
          if (truncated) result.truncated!.push(historyAccountKey(agent.id, a.accountId))
        } catch (err) {
          // Claude names its accounts in the message; the other agents say which agent failed.
          const label = agent.id === 'claude' ? a.name : [agent.name, a.name].filter(Boolean).join(' · ')
          result.errors.push({ account: label, message: err instanceof Error ? err.message : String(err) })
        }
      })
    )
  )
  result.entries.sort((x, y) => y.lastModified - x.lastModified)
  return result
}

/** What History search needs of the index (`SqliteHistoryIndex`). */
export interface HistorySearchIndex {
  match(query: string, scope: HistoryScope): string[]
  snippets(query: string, keys: readonly string[]): Map<string, HistorySnippets>
}

/** Matches per page when the caller does not say, and at most. */
export const HISTORY_SEARCH_PAGE = { default: 50, max: 200 } as const

/** The index scope of the search options (`cwdPrefix` joins `cwdPrefixes`). */
function scopeOf(o: HistorySearchOptions): HistoryScope {
  const folders = o.cwdPrefixes || o.cwdPrefix ? [...(o.cwdPrefixes ?? []), ...(o.cwdPrefix ? [o.cwdPrefix] : [])] : undefined
  return {
    ...(o.agent ? { agent: o.agent } : {}),
    ...(o.accountIds ? { accountIds: o.accountIds } : {}),
    ...(folders ? { cwdPrefixes: folders } : {}),
    ...(o.keys ? { keys: o.keys } : {}),
    ...(o.since !== undefined ? { since: o.since } : {}),
    ...(o.until !== undefined ? { until: o.until } : {})
  }
}

/** Whether a session is in the search's scope (the same rules the index applies). */
function inScope(e: HistoryItem, s: HistoryScope, keys: ReadonlySet<string> | null): boolean {
  const folders = s.cwdPrefixes?.map((f) => f.replace(/[\\/]+$/, '')).filter(Boolean)
  return (
    (!s.agent || e.agentId === s.agent) &&
    (!s.accountIds || s.accountIds.includes(e.accountId ?? '')) &&
    (!folders || folders.some((f) => e.cwd === f || Boolean(e.cwd?.startsWith(`${f}/`)))) &&
    (!keys || keys.has(historyIndexKey(e))) &&
    (s.since === undefined || e.lastModified >= s.since) &&
    (s.until === undefined || e.lastModified <= s.until)
  )
}

/**
 * History search over the sessions the listing has, in scope: the index's matches first, best
 * first, then every other session the plain search matches (title, prompt, folder, branch, id;
 * substrings, any script), which covers sessions not indexed yet. One row per session; paged by
 * an offset into that order, so `total` counts both and pages never repeat a session. Snippets
 * are computed for the page's index matches only.
 */
export function searchAllHistory(listing: HistoryResult, index: HistorySearchIndex | null, query: string, options: HistorySearchOptions, progress: HistoryIndexProgress): HistorySearchResult {
  const scope = scopeOf(options)
  const keys = scope.keys ? new Set(scope.keys) : null
  const byKey = new Map<string, HistoryItem>()
  for (const e of listing.entries) {
    if (!inScope(e, scope, keys)) continue
    const key = historyIndexKey(e)
    const prev = byKey.get(key)
    if (!prev || e.lastModified > prev.lastModified) byKey.set(key, e)
  }
  let ranked: string[] = []
  if (index) {
    try {
      ranked = index.match(query, scope).filter((k) => byKey.has(k))
    } catch {
      // A closed or damaged index: the plain search answers alone.
    }
  }
  const fromIndex = new Set(ranked)
  const plain = [...byKey].filter(([key, e]) => !fromIndex.has(key) && matchesHistory(e, query)).map(([key]) => key)
  const order = [...ranked, ...plain]
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? HISTORY_SEARCH_PAGE.default)), HISTORY_SEARCH_PAGE.max)
  const start = Math.min(order.length, Math.max(0, Number.parseInt(options.cursor ?? '0', 10) || 0))
  const page = order.slice(start, start + limit)
  let snippets = new Map<string, HistorySnippets>()
  if (index) {
    try {
      snippets = index.snippets(query, page.filter((k) => fromIndex.has(k)))
    } catch {
      // Listed without a snippet.
    }
  }
  const entries: HistoryMatch[] = page.map((key) => {
    const s = snippets.get(key)
    return { ...byKey.get(key)!, ...(s?.snippet ? { snippet: s.snippet } : {}), ...(s?.titleSnippet ? { titleSnippet: s.titleSnippet } : {}) }
  })
  return { entries, total: order.length, start, errors: listing.errors, progress, ...(start + limit < order.length ? { nextCursor: String(start + limit) } : {}) }
}

/** Search options from an untrusted caller (a window, a paired device, the control endpoint): known fields of the right type only. */
export function historySearchOptions(raw: unknown): HistorySearchOptions {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined)
  const texts = (v: unknown, max: number, count: number) => (Array.isArray(v) && v.length <= count && v.every((x) => typeof x === 'string' && x.length <= max) ? (v as string[]) : undefined)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const out: HistorySearchOptions = {}
  const agent = text(o['agent'], 100)
  const cwdPrefix = text(o['cwdPrefix'], 4096)
  // A folder list that is not well-formed narrows to nothing rather than widening to everything.
  const cwdPrefixes = o['cwdPrefixes'] === undefined ? undefined : (texts(o['cwdPrefixes'], 4096, 1000) ?? [])
  const accountIds = texts(o['accountIds'], 200, 200)
  const keys = texts(o['keys'], 400, 20_000)
  const cursor = typeof o['cursor'] === 'string' && /^\d{1,9}$/.test(o['cursor']) ? o['cursor'] : undefined
  const since = num(o['since'])
  const until = num(o['until'])
  const limit = num(o['limit'])
  if (agent) out.agent = agent
  if (cwdPrefix) out.cwdPrefix = cwdPrefix
  if (cwdPrefixes) out.cwdPrefixes = cwdPrefixes
  if (accountIds) out.accountIds = accountIds
  if (keys) out.keys = keys
  if (since !== undefined) out.since = since
  if (until !== undefined) out.until = until
  if (limit !== undefined) out.limit = Math.max(1, Math.min(HISTORY_SEARCH_PAGE.max, Math.floor(limit)))
  if (cursor) out.cursor = cursor
  return out
}
