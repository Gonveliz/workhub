/**
 * The usage reports bridge: spend per bucket and group, totals per group, the sessions table, the
 * weekly summary, the filter values and session tags. Every argument is checked here (the renderer
 * is not trusted with shapes); a malformed query is refused with an error. None of these channels
 * is in the remote allowlist.
 */
import { filterValues, sessionsTable, spendSeries, spendTotals, weeklySummary, type SessionRecords, type WorkhubDb } from '@workhub/adapters/sqlite-store'
import { REPORT_FILTER_KEYS, REPORT_GROUPS, type ReportFilters, type ReportGroupBy, type SessionsQuery, type SpendQuery, type TotalsQuery } from '../shared/analytics-api'
import type { IpcRegistrar } from './ipc-guard'

export interface AnalyticsIpcDeps {
  db: WorkhubDb
  records: Pick<SessionRecords, 'tags' | 'setTags'>
  /** Runs the transcript scan now (token spend, then turns); `analytics:refresh` waits for it. */
  scan?: () => Promise<void>
  /** How long `analytics:refresh` waits for the scan at most (it goes on in the background). */
  refreshCapMs?: number
}

/** How long the Usage screen's Refresh waits for the scan before reading what is there. */
export const REFRESH_CAP_MS = 20_000

/** The longest period a query may span: a little over a year and a half. */
export const MAX_RANGE_MS = 560 * 86_400_000
const MAX_VALUE = 2048
const MAX_TAGS_IN = 100

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 8.64e15
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 500

function invalid(what: string): never {
  throw new Error(`Invalid analytics query: ${what}`)
}

/** The filters of a query: known keys with non-empty strings only; anything else is refused. */
export function parseFilters(raw: unknown): ReportFilters {
  if (raw === undefined || raw === null) return {}
  if (!isObject(raw)) invalid('filters')
  const out: ReportFilters = {}
  for (const key of REPORT_FILTER_KEYS) {
    const v = raw[key]
    if (v === undefined || v === null || v === '') continue
    if (typeof v !== 'string' || v.length > MAX_VALUE) invalid(key)
    out[key] = v
  }
  return out
}

function parseRange(raw: Record<string, unknown>): { since: number; until: number } {
  const { since, until } = raw
  if (!isTime(since) || !isTime(until) || until <= since) invalid('period')
  if (until - since > MAX_RANGE_MS) invalid('period too long')
  return { since, until }
}

function parseGroup(v: unknown): ReportGroupBy {
  if (typeof v !== 'string' || !REPORT_GROUPS.includes(v as ReportGroupBy)) invalid('groupBy')
  return v as ReportGroupBy
}

export function parseSpendQuery(raw: unknown): SpendQuery {
  if (!isObject(raw)) invalid('query')
  const bucket = raw['bucket']
  if (bucket !== 'day' && bucket !== 'week') invalid('bucket')
  return { ...parseRange(raw), bucket, groupBy: parseGroup(raw['groupBy']), filters: parseFilters(raw['filters']) }
}

export function parseTotalsQuery(raw: unknown): TotalsQuery {
  if (!isObject(raw)) invalid('query')
  return { ...parseRange(raw), groupBy: parseGroup(raw['groupBy']), filters: parseFilters(raw['filters']) }
}

export function parseSessionsQuery(raw: unknown): SessionsQuery {
  if (!isObject(raw)) invalid('query')
  const out: SessionsQuery = parseFilters(Object.fromEntries(REPORT_FILTER_KEYS.map((k) => [k, raw[k]])))
  if (raw['since'] !== undefined) {
    if (!isTime(raw['since'])) invalid('since')
    out.since = raw['since']
  }
  if (raw['until'] !== undefined) {
    if (!isTime(raw['until'])) invalid('until')
    out.until = raw['until']
  }
  if (raw['limit'] !== undefined) {
    if (typeof raw['limit'] !== 'number' || !Number.isInteger(raw['limit']) || raw['limit'] < 1 || raw['limit'] > 500) invalid('limit')
    out.limit = raw['limit']
  }
  if (raw['turnsOnly'] !== undefined) {
    if (typeof raw['turnsOnly'] !== 'boolean') invalid('turnsOnly')
    out.turnsOnly = raw['turnsOnly']
  }
  if (raw['cursor'] !== undefined && raw['cursor'] !== null) {
    if (typeof raw['cursor'] !== 'string' || raw['cursor'].length > MAX_VALUE) invalid('cursor')
    out.cursor = raw['cursor']
  }
  return out
}

/** The filter values' query: an optional profile and an optional period (both bounds, or neither). */
export function parseFiltersQuery(raw: unknown): { profileId?: string; since?: number; until?: number } {
  if (raw === undefined || raw === null) return {}
  if (!isObject(raw)) invalid('query')
  const profileId = raw['profileId']
  if (profileId !== undefined && profileId !== null && !isId(profileId)) invalid('profileId')
  const out: { profileId?: string; since?: number; until?: number } = isId(profileId) ? { profileId } : {}
  if (raw['since'] !== undefined || raw['until'] !== undefined) Object.assign(out, parseRange(raw))
  return out
}

export function parseWeeklyQuery(raw: unknown): { weekStart: number; profileId?: string } {
  if (!isObject(raw) || !isTime(raw['weekStart'])) invalid('weekStart')
  const profileId = raw['profileId']
  if (profileId !== undefined && profileId !== null && !isId(profileId)) invalid('profileId')
  return { weekStart: raw['weekStart'], ...(isId(profileId) ? { profileId } : {}) }
}

export function registerAnalyticsIpc(ipc: IpcRegistrar, deps: AnalyticsIpcDeps): void {
  const { db, records } = deps
  ipc.handle('analytics:tags', (_e, sessionId: unknown) => (isId(sessionId) ? records.tags(sessionId) : []))
  // Refused, never answered with [] (the editor would show "no tags" while the database keeps them).
  ipc.handle('analytics:setTags', (_e, sessionId: unknown, tags: unknown) => {
    if (!isId(sessionId)) throw new Error('a session id is required')
    if (!Array.isArray(tags) || tags.length > MAX_TAGS_IN || tags.some((t) => typeof t !== 'string')) throw new Error('tags must be a list of strings')
    return records.setTags(sessionId, tags as string[])
  })
  ipc.handle('analytics:spend', (_e, query: unknown) => spendSeries(db, parseSpendQuery(query)))
  ipc.handle('analytics:totals', (_e, query: unknown) => spendTotals(db, parseTotalsQuery(query)))
  ipc.handle('analytics:sessions', (_e, query: unknown) => {
    const { limit, cursor, turnsOnly, ...filters } = parseSessionsQuery(query)
    return sessionsTable(db, filters, { limit, cursor, turnsOnly })
  })
  ipc.handle('analytics:weekly', (_e, query: unknown) => weeklySummary(db, parseWeeklyQuery(query)))
  ipc.handle('analytics:filters', (_e, query: unknown) => filterValues(db, parseFiltersQuery(query)))
  // New turns reach `turns` with the token spend scan (every 10 minutes): Refresh runs it now.
  ipc.handle('analytics:refresh', async () => {
    if (!deps.scan) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const cap = new Promise<void>((resolve) => (timer = setTimeout(resolve, deps.refreshCapMs ?? REFRESH_CAP_MS)))
    try {
      await Promise.race([deps.scan().catch(() => undefined), cap])
    } finally {
      clearTimeout(timer)
    }
  })
}
