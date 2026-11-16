/**
 * Read-only queries over the per-turn data (`turns`, `sessions`, `session_links`, `session_tags`,
 * the timelines), for the usage reports and the read-only SQL endpoint. Every value from the caller
 * is a bound parameter; the only SQL picked from input comes from the fixed maps below.
 *
 * Buckets start at local midnight (weeks on Monday) in the process's time zone. Grouping by ticket,
 * pull request or tag counts a session's turns once in every group it is linked to (so the groups
 * can add up to more than `none`), and in a `null` group when it has none. Sub-agents' turns count
 * their tokens and cost, never their time (it runs inside the parent's turn).
 *
 * Turns older than the retention live on as daily summaries (`turns_daily`, see `retention.ts`); the
 * reports read both, so a total over a span that crosses the boundary is what the turns gave.
 */
import type { WorkhubDb } from './db'

/**
 * What the queries need of the database: its connection only, so the app's report worker can run
 * them on its own read-only connection. This file keeps to type imports (the worker loads it as is).
 */
export type AnalyticsDb = Pick<WorkhubDb, 'raw'>

export type SpendBucket = 'day' | 'week'
export type SpendGroupBy = 'project' | 'agent' | 'model' | 'account' | 'ticket' | 'pr' | 'tag' | 'none'

export interface SpendFilters {
  profileId?: string
  /** A folder: turns whose project or folder is it or below it (either separator, case as stored). */
  cwdPrefix?: string
  /** A project exactly (the resolved project folder, or the folder when none was resolved). */
  project?: string
  agent?: string
  account?: string
  model?: string
  ticket?: string
  pr?: string
  tag?: string
}

export interface SpendSeriesQuery {
  /** Epoch ms, inclusive. */
  since: number
  /** Epoch ms, exclusive. */
  until: number
  bucket: SpendBucket
  groupBy: SpendGroupBy
  filters?: SpendFilters
}

export interface SpendRow {
  /** Epoch ms of the bucket's local start. */
  bucketStart: number
  /** The group's value (project, agent, model, account id, ticket key, PR URL, tag); null for none. */
  group: string | null
  tokensIn: number
  tokensOut: number
  cacheRead: number
  cacheWrite: number
  /** Dollars at list prices of the priced turns. */
  usd: number
  /** Tokens (all four kinds) of turns whose model has no price: not in `usd`. */
  unpricedTokens: number
  activeMs: number
  turns: number
  sessions: number
}

type Params = (string | number | null)[]

const BUCKET_SQL: Record<SpendBucket, string> = {
  day: `CAST(strftime('%s', t.at / 1000, 'unixepoch', 'localtime', 'start of day', 'utc') AS INTEGER) * 1000`,
  // Back to the last Monday: `weekday 1` moves forward to a Monday, so step back six days first.
  week: `CAST(strftime('%s', t.at / 1000, 'unixepoch', 'localtime', 'start of day', '-6 days', 'weekday 1', 'utc') AS INTEGER) * 1000`
}

const GROUP_SQL: Record<SpendGroupBy, { expr: string; join?: string }> = {
  project: { expr: 'COALESCE(t.project, t.cwd)' },
  agent: { expr: 's.agent' },
  model: { expr: 't.model' },
  account: { expr: 's.account_id' },
  ticket: { expr: 'g.ref', join: `LEFT JOIN session_links g ON g.session_id = t.session_id AND g.kind = 'ticket'` },
  pr: { expr: 'g.ref', join: `LEFT JOIN session_links g ON g.session_id = t.session_id AND g.kind = 'pr'` },
  tag: { expr: 'g.tag', join: 'LEFT JOIN session_tags g ON g.session_id = t.session_id' },
  none: { expr: 'NULL' }
}

/**
 * What the reports read as `t`: the turns, then the daily summaries with the same columns. A summary
 * stands at its first turn's time for `n` turns; its turn_ms already leaves sub-agents out (so it
 * reads as sidechain 0) and its usd is null exactly when its turns were unpriced. Time and folder
 * conditions on `t` reach both tables' indexes.
 */
const TURNS = `(SELECT session_id, at, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, usd, cwd, project, turn_ms, sidechain, 1 AS n FROM turns
  UNION ALL SELECT session_id, at, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, usd, cwd, project, turn_ms, 0, turns FROM turns_daily)`

const SUMS = `SUM(t.input_tokens) AS tokens_in, SUM(t.output_tokens) AS tokens_out, SUM(t.cache_read_tokens) AS cache_read,
  SUM(t.cache_write_tokens) AS cache_write, TOTAL(t.usd) AS usd,
  SUM(CASE WHEN t.usd IS NULL THEN t.input_tokens + t.output_tokens + t.cache_write_tokens + t.cache_read_tokens ELSE 0 END) AS unpriced,
  SUM(CASE WHEN t.sidechain = 0 THEN t.turn_ms ELSE 0 END) AS active_ms, SUM(t.n) AS turns, COUNT(DISTINCT t.session_id) AS sessions`

/**
 * A folder without its trailing separators. A loop rather than `/[\\/]+$/`, which rescans every run
 * of separators that is not at the end (quadratic on a crafted folder).
 */
function trimSeparators(path: string): string {
  let end = path.length
  while (end > 0 && (path[end - 1] === '/' || path[end - 1] === '\\')) end--
  return path.slice(0, end)
}

/** `column` is `prefix` or below it, with either separator; plain comparisons, so case is compared as stored. */
function under(column: string, prefix: string, params: Params): string {
  const p = trimSeparators(prefix)
  params.push(p, `${p}/`, `${p}/`, `${p}\\`, `${p}\\`)
  return `(${column} = ? OR substr(${column}, 1, length(?)) = ? OR substr(${column}, 1, length(?)) = ?)`
}

/** The conditions on turns `t` alone (time, model, folder). */
function turnOnly(filters: SessionFilters, params: Params): string[] {
  const where: string[] = []
  if (filters.since !== undefined) {
    where.push('t.at >= ?')
    params.push(filters.since)
  }
  if (filters.until !== undefined) {
    where.push('t.at < ?')
    params.push(filters.until)
  }
  if (filters.model !== undefined) {
    where.push('t.model = ?')
    params.push(filters.model)
  }
  if (filters.cwdPrefix) {
    const a = under('t.project', filters.cwdPrefix, params)
    const b = under('t.cwd', filters.cwdPrefix, params)
    where.push(`(${a} OR ${b})`)
  }
  if (filters.project !== undefined) {
    where.push('COALESCE(t.project, t.cwd) = ?')
    params.push(filters.project)
  }
  return where
}

/** The conditions on the session `s` (profile, agent, account) and its links and tags. */
function sessionOnly(filters: SpendFilters, sessionColumn: string, params: Params): string[] {
  const where: string[] = []
  if (filters.profileId !== undefined) {
    where.push('s.profile_id = ?')
    params.push(filters.profileId)
  }
  if (filters.agent !== undefined) {
    where.push('s.agent = ?')
    params.push(filters.agent)
  }
  if (filters.account !== undefined) {
    where.push('s.account_id = ?')
    params.push(filters.account)
  }
  if (filters.ticket !== undefined) {
    where.push(`EXISTS (SELECT 1 FROM session_links l WHERE l.session_id = ${sessionColumn} AND l.kind = 'ticket' AND l.ref = ?)`)
    params.push(filters.ticket)
  }
  if (filters.pr !== undefined) {
    where.push(`EXISTS (SELECT 1 FROM session_links l WHERE l.session_id = ${sessionColumn} AND l.kind = 'pr' AND l.ref = ?)`)
    params.push(filters.pr)
  }
  if (filters.tag !== undefined) {
    where.push(`EXISTS (SELECT 1 FROM session_tags x WHERE x.session_id = ${sessionColumn} AND x.tag = ?)`)
    params.push(filters.tag)
  }
  return where
}

const n = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0)

/** Tokens, dollars, agent time, turns and sessions per bucket and group, oldest bucket first, then largest spend. */
export function spendSeries(db: AnalyticsDb, q: SpendSeriesQuery): SpendRow[] {
  if (!Object.hasOwn(GROUP_SQL, q.groupBy) || !Object.hasOwn(BUCKET_SQL, q.bucket)) throw new Error(`unknown grouping ${String(q.groupBy)}/${String(q.bucket)}`)
  const group = GROUP_SQL[q.groupBy]
  const bucket = BUCKET_SQL[q.bucket]
  const params: Params = []
  const where = [...turnOnly({ ...(q.filters ?? {}), since: q.since, until: q.until }, params), ...sessionOnly(q.filters ?? {}, 't.session_id', params)]
  const sql = `
    SELECT ${bucket} AS bucket_start, ${group.expr} AS grp, ${SUMS}
    FROM ${TURNS} t LEFT JOIN sessions s ON s.id = t.session_id ${group.join ?? ''}
    WHERE ${where.join(' AND ')}
    GROUP BY bucket_start, grp
    ORDER BY bucket_start, usd DESC, tokens_in + tokens_out DESC, grp`
  return (db.raw.prepare(sql).all(...params) as Record<string, unknown>[]).map((r) => ({
    bucketStart: n(r['bucket_start']),
    group: r['grp'] === null || r['grp'] === undefined ? null : String(r['grp']),
    tokensIn: n(r['tokens_in']),
    tokensOut: n(r['tokens_out']),
    cacheRead: n(r['cache_read']),
    cacheWrite: n(r['cache_write']),
    usd: n(r['usd']),
    unpricedTokens: n(r['unpriced']),
    activeMs: n(r['active_ms']),
    turns: n(r['turns']),
    sessions: n(r['sessions'])
  }))
}

export interface SpendGroupsQuery {
  /** Epoch ms, inclusive. */
  since: number
  /** Epoch ms, exclusive. */
  until: number
  groupBy: SpendGroupBy
  filters?: SpendFilters
}

/** `SpendRow` over the whole span, one per group (`bucketStart` is `since`); `sessions` counts each session once per group. With `groupBy: 'none'`, one row: the totals, every turn once. */
export function spendGroups(db: AnalyticsDb, q: SpendGroupsQuery): SpendRow[] {
  if (!Object.hasOwn(GROUP_SQL, q.groupBy)) throw new Error(`unknown grouping ${String(q.groupBy)}`)
  const group = GROUP_SQL[q.groupBy]
  const params: Params = []
  const where = [...turnOnly({ ...(q.filters ?? {}), since: q.since, until: q.until }, params), ...sessionOnly(q.filters ?? {}, 't.session_id', params)]
  const sql = `
    SELECT ${group.expr} AS grp, ${SUMS}
    FROM ${TURNS} t LEFT JOIN sessions s ON s.id = t.session_id ${group.join ?? ''}
    WHERE ${where.join(' AND ')}
    GROUP BY grp
    ORDER BY usd DESC, tokens_in + tokens_out DESC, grp`
  return (db.raw.prepare(sql).all(...params) as Record<string, unknown>[])
    .filter((r) => q.groupBy !== 'none' || n(r['turns']) > 0)
    .map((r) => ({
      bucketStart: q.since,
      group: r['grp'] === null || r['grp'] === undefined ? null : String(r['grp']),
      tokensIn: n(r['tokens_in']),
      tokensOut: n(r['tokens_out']),
      cacheRead: n(r['cache_read']),
      cacheWrite: n(r['cache_write']),
      usd: n(r['usd']),
      unpricedTokens: n(r['unpriced']),
      activeMs: n(r['active_ms']),
      turns: n(r['turns']),
      sessions: n(r['sessions'])
    }))
}

export interface SessionFilters extends SpendFilters {
  /** Turns at or after this epoch ms (totals count only those; a session needs one, or to have started then). */
  since?: number
  /** Turns before this epoch ms. */
  until?: number
}

export type SessionSort = 'startedAt' | 'usd' | 'tokens' | 'activeMs' | 'title'

export interface SessionRow {
  id: string
  agent: string
  accountId: string | null
  profileId: string | null
  /** The project most of its turns worked in. */
  project: string | null
  cwd: string | null
  workPath: string | null
  title: string | null
  startedAt: number | null
  endedAt: number | null
  activeMs: number
  lastModel: string | null
  source: 'transcript' | 'workhub'
  tokensIn: number
  tokensOut: number
  cacheRead: number
  cacheWrite: number
  usd: number
  unpricedTokens: number
  turns: number
  links: { kind: string; ref: string }[]
  tickets: string[]
  prs: string[]
  branches: string[]
  tags: string[]
}

export interface SessionPage {
  rows: SessionRow[]
  /** Pass it back as `cursor` (with the same sort) for the next page; null on the last one. */
  nextCursor: string | null
}

/**
 * The sort key of each order, over sessions `s` and (for totals) its turns and daily summaries under
 * the filters `tw`: one lookup per table on its session index (a lookup through `TURNS` would read
 * every turn for each session). Totals orders bind the filters' parameters twice.
 */
function sortKey(by: SessionSort, tw: string): string {
  const of = (expr: string, daily = expr) =>
    `((SELECT ${expr} FROM turns t WHERE t.session_id = s.id${tw ? ` AND ${tw}` : ''}) + (SELECT ${daily} FROM turns_daily t WHERE t.session_id = s.id${tw ? ` AND ${tw}` : ''}))`
  switch (by) {
    case 'title':
      return `COALESCE(s.title, '')`
    case 'usd':
      return of('TOTAL(t.usd)')
    case 'tokens':
      return of('COALESCE(SUM(t.input_tokens + t.output_tokens + t.cache_write_tokens), 0)')
    case 'activeMs':
      return of('COALESCE(SUM(CASE WHEN t.sidechain = 0 THEN t.turn_ms ELSE 0 END), 0)', 'COALESCE(SUM(t.turn_ms), 0)')
    default:
      return 'COALESCE(s.started_at, s.updated_at)'
  }
}

const SORTS: readonly SessionSort[] = ['startedAt', 'usd', 'tokens', 'activeMs', 'title']

/**
 * Sessions a page at a time, in `sort` order (`startedAt` newest first by default) with the id
 * breaking ties. Totals count only the turns the filters keep (time, model, folder). `cursor` is
 * the previous page's `nextCursor`; one made for another sort starts over.
 */
export function sessionsTable(
  db: AnalyticsDb,
  filters: SessionFilters = {},
  page: { limit?: number; cursor?: string | null; sort?: SessionSort; dir?: 'asc' | 'desc'; /** Only sessions with a turn the filters keep (as `spendTotals` counts them): no turn-less ones. */ turnsOnly?: boolean } = {}
): SessionPage {
  const limit = Math.min(Math.max(1, Math.floor(page.limit ?? 50)), 500)
  const by: SessionSort = page.sort && SORTS.includes(page.sort) ? page.sort : 'startedAt'
  const dir = page.dir === 'asc' ? 'asc' : 'desc'
  const twParams: Params = []
  const tw = turnOnly(filters, twParams).join(' AND ')
  const params: Params = []
  const key = sortKey(by, tw)
  if (by === 'usd' || by === 'tokens' || by === 'activeMs') params.push(...twParams, ...twParams)
  const where = sessionOnly(filters, 's.id', params)
  if (tw || page.turnsOnly) {
    // A session needs a turn the filters keep; one without any turn yet is judged by its own start and folder.
    const own: string[] = []
    const ownParams: Params = []
    if (filters.model !== undefined || filters.project !== undefined || page.turnsOnly) own.push('0')
    if (filters.since !== undefined) {
      own.push('COALESCE(s.started_at, s.updated_at) >= ?')
      ownParams.push(filters.since)
    }
    if (filters.until !== undefined) {
      own.push('COALESCE(s.started_at, s.updated_at) < ?')
      ownParams.push(filters.until)
    }
    if (filters.cwdPrefix) {
      const a = under('s.project', filters.cwdPrefix, ownParams)
      const b = under('s.cwd', filters.cwdPrefix, ownParams)
      own.push(`(${a} OR ${b})`)
    }
    const kept = (table: string) => `EXISTS (SELECT 1 FROM ${table} t WHERE t.session_id = s.id${tw ? ` AND ${tw}` : ''})`
    where.push(
      `(${kept('turns')} OR ${kept('turns_daily')} OR (NOT EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.id) AND NOT EXISTS (SELECT 1 FROM turns_daily t WHERE t.session_id = s.id) AND ${own.length ? own.join(' AND ') : '1'}))`
    )
    params.push(...twParams, ...twParams, ...ownParams)
  }
  const cursor = parseSessionCursor(page.cursor, by, dir)
  const cmp = dir === 'desc' ? '<' : '>'
  let after = ''
  const afterParams: Params = []
  if (cursor) {
    after = `WHERE (k ${cmp} ? OR (k = ? AND id ${cmp} ?))`
    afterParams.push(cursor.k, cursor.k, cursor.id)
  }
  const ids = db.raw
    .prepare(
      `WITH page AS (SELECT s.id AS id, ${key} AS k FROM sessions s ${where.length ? `WHERE ${where.join(' AND ')}` : ''})
       SELECT id, k FROM page ${after} ORDER BY k ${dir}, id ${dir} LIMIT ?`
    )
    .all(...params, ...afterParams, limit + 1) as { id: string; k: string | number | null }[]
  const more = ids.length > limit
  const shown = ids.slice(0, limit)
  if (!shown.length) return { rows: [], nextCursor: null }
  const marks = shown.map(() => '?').join(', ')
  const pageIds = shown.map((r) => r.id)
  const sessions = new Map((db.raw.prepare(`SELECT * FROM sessions WHERE id IN (${marks})`).all(...pageIds) as Record<string, unknown>[]).map((r) => [String(r['id']), r]))
  const totals = new Map(
    (db.raw.prepare(`SELECT t.session_id AS sid, ${SUMS} FROM ${TURNS} t WHERE t.session_id IN (${marks})${tw ? ` AND ${tw}` : ''} GROUP BY t.session_id`).all(...pageIds, ...twParams) as Record<string, unknown>[]).map((r) => [String(r['sid']), r])
  )
  const links = db.raw.prepare('SELECT kind, ref FROM session_links WHERE session_id = ? ORDER BY at, kind, ref')
  const tags = db.raw.prepare('SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag')
  const rows = pageIds.map((id): SessionRow => {
    const r = sessions.get(id) ?? {}
    const a = totals.get(id) ?? {}
    const linked = links.all(id) as { kind: string; ref: string }[]
    const of = (kind: string) => linked.filter((l) => l.kind === kind).map((l) => l.ref)
    const str = (k: string) => (r[k] === null || r[k] === undefined ? null : String(r[k]))
    const num = (k: string) => (r[k] === null || r[k] === undefined ? null : n(r[k]))
    return {
      id,
      agent: String(r['agent'] ?? ''),
      accountId: str('account_id'),
      profileId: str('profile_id'),
      project: str('project'),
      cwd: str('cwd'),
      workPath: str('work_path'),
      title: str('title'),
      startedAt: num('started_at'),
      endedAt: num('ended_at'),
      activeMs: n(a['active_ms']),
      lastModel: str('last_model'),
      source: r['source'] === 'workhub' ? 'workhub' : 'transcript',
      tokensIn: n(a['tokens_in']),
      tokensOut: n(a['tokens_out']),
      cacheRead: n(a['cache_read']),
      cacheWrite: n(a['cache_write']),
      usd: n(a['usd']),
      unpricedTokens: n(a['unpriced']),
      turns: n(a['turns']),
      links: linked.map((l) => ({ kind: l.kind, ref: l.ref })),
      tickets: of('ticket'),
      prs: of('pr'),
      branches: of('branch'),
      tags: (tags.all(id) as { tag: string }[]).map((t) => t.tag)
    }
  })
  const last = shown.at(-1)!
  return { rows, nextCursor: more ? Buffer.from(JSON.stringify([by, dir, last.k, last.id])).toString('base64url') : null }
}

function parseSessionCursor(cursor: string | null | undefined, by: SessionSort, dir: string): { k: string | number | null; id: string } | null {
  if (!cursor) return null
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (Array.isArray(v) && v.length === 4 && v[0] === by && v[1] === dir && typeof v[3] === 'string' && (typeof v[2] === 'number' || typeof v[2] === 'string')) return { k: v[2], id: v[3] }
  } catch {
    // Not a cursor: the first page.
  }
  return null
}

export interface SpendTotalsQuery {
  /** Epoch ms, inclusive. */
  since: number
  /** Epoch ms, exclusive. */
  until: number
  groupBy: SpendGroupBy
  filters?: SpendFilters
}

/** One group's sums over the whole period: `sessions` counts each session once, however many days it ran. */
export type SpendTotalRow = Omit<SpendRow, 'bucketStart'>

/** Tokens, dollars, agent time, turns and distinct sessions per group over the period, largest spend first. */
export function spendTotals(db: AnalyticsDb, q: SpendTotalsQuery): SpendTotalRow[] {
  if (!Object.hasOwn(GROUP_SQL, q.groupBy)) throw new Error(`unknown grouping ${String(q.groupBy)}`)
  const group = GROUP_SQL[q.groupBy]
  const params: Params = []
  const where = [...turnOnly({ ...(q.filters ?? {}), since: q.since, until: q.until }, params), ...sessionOnly(q.filters ?? {}, 't.session_id', params)]
  const sql = `
    SELECT ${group.expr} AS grp, ${SUMS}
    FROM ${TURNS} t LEFT JOIN sessions s ON s.id = t.session_id ${group.join ?? ''}
    WHERE ${where.join(' AND ')}
    GROUP BY grp
    ORDER BY usd DESC, tokens_in + tokens_out DESC, grp`
  return (db.raw.prepare(sql).all(...params) as Record<string, unknown>[]).map((r) => ({
    group: r['grp'] === null || r['grp'] === undefined ? null : String(r['grp']),
    tokensIn: n(r['tokens_in']),
    tokensOut: n(r['tokens_out']),
    cacheRead: n(r['cache_read']),
    cacheWrite: n(r['cache_write']),
    usd: n(r['usd']),
    unpricedTokens: n(r['unpriced']),
    activeMs: n(r['active_ms']),
    turns: n(r['turns']),
    sessions: n(r['sessions'])
  }))
}

/** The values the report filters offer, each most used first (by turns). */
export interface FilterValues {
  profiles: string[]
  /** Projects turns worked in (the resolved project, or the folder). */
  projects: string[]
  agents: string[]
  /** Account ids; the default account (null) is left out. */
  accounts: string[]
  models: string[]
  tickets: string[]
  prs: string[]
  tags: string[]
}

/**
 * Values per filter, at most `limit` each, from the turns in `[since, until)` when given. `profileId`
 * keeps them to that profile's sessions (`profiles` then lists every profile in the period).
 */
export function filterValues(db: AnalyticsDb, q: { profileId?: string; since?: number; until?: number; limit?: number } = {}): FilterValues {
  const limit = Math.min(Math.max(1, Math.floor(q.limit ?? 200)), 1000)
  const run = (expr: string, join: string, profiled: boolean): string[] => {
    const params: Params = []
    const where = [...turnOnly({ since: q.since, until: q.until }, params), ...(profiled && q.profileId !== undefined ? sessionOnly({ profileId: q.profileId }, 't.session_id', params) : []), `${expr} IS NOT NULL`]
    return (
      db.raw.prepare(`SELECT ${expr} AS v FROM ${TURNS} t LEFT JOIN sessions s ON s.id = t.session_id ${join} WHERE ${where.join(' AND ')} GROUP BY v ORDER BY SUM(t.n) DESC, v LIMIT ?`).all(...params, limit) as { v: unknown }[]
    ).map((r) => String(r.v))
  }
  return {
    profiles: run('s.profile_id', '', false),
    projects: run('COALESCE(t.project, t.cwd)', '', true),
    agents: run('s.agent', '', true),
    accounts: run('s.account_id', '', true),
    models: run('t.model', '', true),
    tickets: run('g.ref', `JOIN session_links g ON g.session_id = t.session_id AND g.kind = 'ticket'`, true),
    prs: run('g.ref', `JOIN session_links g ON g.session_id = t.session_id AND g.kind = 'pr'`, true),
    tags: run('g.tag', 'JOIN session_tags g ON g.session_id = t.session_id', true)
  }
}

export interface WeeklyItem {
  /** A project folder, a pull request URL or a ticket key. */
  ref: string
  activeMs: number
  usd: number
  /** Fresh tokens: input, output and cache writes. */
  tokens: number
  turns: number
  sessions: number
}

export interface WeeklyProject extends WeeklyItem {
  project: string
}

export interface WeeklyPr {
  url: string
  repo: string
  number: number | null
  title: string | null
  at: number
}

export interface WeeklyTicketMove {
  key: string
  from: string | null
  to: string | null
  title: string | null
  at: number
}

export interface WeeklySummary {
  /** Local Monday 00:00 of the week asked for. */
  weekStart: number
  weekEnd: number
  sessions: number
  activeMs: number
  usd: number
  tokensIn: number
  tokensOut: number
  /** Per project, most agent time first. */
  projects: WeeklyProject[]
  /** Pull requests the week's sessions were linked to. */
  prs: WeeklyItem[]
  /** Tickets the week's sessions were linked to. */
  tickets: WeeklyItem[]
  /** Pull requests first seen open, merged, and that left the user's review queue during the week. */
  prsOpened: WeeklyPr[]
  prsMerged: WeeklyPr[]
  prsReviewed: WeeklyPr[]
  /** Ticket status changes the watcher saw, oldest first. */
  ticketMoves: WeeklyTicketMove[]
}

/** Local Monday 00:00 of the week holding `at`. */
export function weekStartOf(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}

/**
 * The week holding `weekStart` (snapped to its local Monday, seven local days): agent time,
 * dollars and tokens per project, the PRs and tickets worked on, PRs opened, merged and reviewed,
 * ticket moves and sessions. Throws for a `weekStart` that is not a time.
 */
export function weeklySummary(db: AnalyticsDb, q: { profileId?: string; weekStart: number }): WeeklySummary {
  if (typeof q.weekStart !== 'number' || !Number.isFinite(q.weekStart)) throw new Error('weekStart must be epoch milliseconds')
  const weekStart = weekStartOf(q.weekStart)
  const end = new Date(weekStart)
  end.setDate(end.getDate() + 7)
  const weekEnd = end.getTime()
  const params: Params = []
  const where = [...turnOnly({ since: weekStart, until: weekEnd }, params), ...sessionOnly(q.profileId !== undefined ? { profileId: q.profileId } : {}, 't.session_id', params)]
  const base = `FROM ${TURNS} t LEFT JOIN sessions s ON s.id = t.session_id`
  const cond = where.join(' AND ')
  const total = db.raw.prepare(`SELECT ${SUMS} ${base} WHERE ${cond}`).get(...params) as Record<string, unknown>
  const items = (expr: string, join = '') =>
    (
      db.raw
        .prepare(
          `SELECT ${expr} AS ref, SUM(CASE WHEN t.sidechain = 0 THEN t.turn_ms ELSE 0 END) AS active_ms, TOTAL(t.usd) AS usd,
             SUM(t.input_tokens + t.output_tokens + t.cache_write_tokens) AS tokens, SUM(t.n) AS turns, COUNT(DISTINCT t.session_id) AS sessions
           ${base} ${join} WHERE ${cond} AND ${expr} IS NOT NULL GROUP BY ref ORDER BY active_ms DESC, usd DESC, ref`
        )
        .all(...params) as Record<string, unknown>[]
    ).map((r): WeeklyItem => ({ ref: String(r['ref']), activeMs: n(r['active_ms']), usd: n(r['usd']), tokens: n(r['tokens']), turns: n(r['turns']), sessions: n(r['sessions']) }))
  const eventParams: Params = [weekStart, weekEnd]
  const byProfile = q.profileId !== undefined ? ' AND profile_id = ?' : ''
  if (q.profileId !== undefined) eventParams.push(q.profileId)
  const prs = (kind: string): WeeklyPr[] =>
    (
      db.raw
        .prepare(`SELECT url, repo, number, MAX(title) AS title, MIN(at) AS at FROM pr_events WHERE at >= ? AND at < ?${byProfile} AND kind = ? GROUP BY url ORDER BY at, url`)
        .all(...eventParams, kind) as Record<string, unknown>[]
    ).map((r) => ({ url: String(r['url']), repo: String(r['repo']), number: r['number'] === null ? null : n(r['number']), title: r['title'] === null ? null : String(r['title']), at: n(r['at']) }))
  const moves = (
    db.raw.prepare(`SELECT key, from_value, to_value, title, at FROM ticket_events WHERE at >= ? AND at < ?${byProfile} AND kind = 'status' ORDER BY at, id`).all(...eventParams) as Record<string, unknown>[]
  ).map((r) => ({ key: String(r['key']), from: r['from_value'] === null ? null : String(r['from_value']), to: r['to_value'] === null ? null : String(r['to_value']), title: r['title'] === null ? null : String(r['title']), at: n(r['at']) }))
  return {
    weekStart,
    weekEnd,
    sessions: n(total['sessions']),
    activeMs: n(total['active_ms']),
    usd: n(total['usd']),
    tokensIn: n(total['tokens_in']),
    tokensOut: n(total['tokens_out']),
    projects: items('COALESCE(t.project, t.cwd)').map((p) => ({ ...p, project: p.ref })),
    prs: items('g.ref', `JOIN session_links g ON g.session_id = t.session_id AND g.kind = 'pr'`),
    tickets: items('g.ref', `JOIN session_links g ON g.session_id = t.session_id AND g.kind = 'ticket'`),
    prsOpened: prs('opened'),
    prsMerged: prs('merged'),
    prsReviewed: prs('reviewed'),
    ticketMoves: moves
  }
}

/** A Usage and reports query by name, with arguments already checked: what the report worker accepts (never SQL). */
export type AnalyticsReport =
  | { name: 'spend'; query: SpendSeriesQuery }
  | { name: 'totals'; query: SpendTotalsQuery }
  | { name: 'sessions'; filters: SessionFilters; page: NonNullable<Parameters<typeof sessionsTable>[2]> }
  | { name: 'weekly'; query: Parameters<typeof weeklySummary>[1] }
  | { name: 'filters'; query: NonNullable<Parameters<typeof filterValues>[1]> }

export type AnalyticsReportName = AnalyticsReport['name']

/** Runs a named report; throws on a name it does not know (a message from another version). */
export function runAnalyticsReport(db: AnalyticsDb, report: AnalyticsReport): SpendRow[] | SpendTotalRow[] | SessionPage | WeeklySummary | FilterValues {
  switch (report.name) {
    case 'spend':
      return spendSeries(db, report.query)
    case 'totals':
      return spendTotals(db, report.query)
    case 'sessions':
      return sessionsTable(db, report.filters, report.page)
    case 'weekly':
      return weeklySummary(db, report.query)
    case 'filters':
      return filterValues(db, report.query)
    default:
      throw new Error(`unknown report ${String((report as { name?: unknown }).name)}`)
  }
}

/**
 * The tables the reports and the read-only SQL endpoint may read. Not `kv_state` (app state that can
 * hold anything), `schema_migrations`, `turn_files` (local file paths and parser state) nor
 * `history_index` and its search tables (first prompts of every profile's sessions).
 */
export const ANALYTICS_TABLES = [
  'sessions',
  'turns',
  'turns_daily',
  'session_links',
  'session_tags',
  'automation_runs',
  'pr_events',
  'ticket_events',
  'flow_maps',
  'flow_history_measures',
  'flow_history_hours'
] as const

export interface SchemaColumn {
  name: string
  /** SQLite type as declared. */
  type: 'TEXT' | 'INTEGER' | 'REAL'
  description: string
  /** Unit of a number: `usd` (dollars, a float), `ms` (a duration), `epoch_ms` (a time), `tokens`, `bytes`. */
  unit?: 'usd' | 'ms' | 'epoch_ms' | 'tokens' | 'bytes'
  /** What null means, when it can be null. */
  nullable?: string
}

export interface SchemaTable {
  name: string
  description: string
  /** What writes its rows. */
  writer: string
  columns: SchemaColumn[]
}

const c = (name: string, type: SchemaColumn['type'], description: string, extra: Partial<Pick<SchemaColumn, 'unit' | 'nullable'>> = {}): SchemaColumn => ({ name, type, description, ...extra })

/**
 * The per-turn tables, each column with its type, unit, what null means and one line on what it
 * holds. Times are epoch ms (UTC); the queries bucket them at local midnight.
 */
export function schemaDescription(): SchemaTable[] {
  return [
    {
      name: 'sessions',
      description: 'One agent session Workhub knows: opened in Workhub or found in a transcript.',
      writer: 'The transcript scan (TurnIngest) and the session recorder in the main process.',
      columns: [
        c('id', 'TEXT', "The agent's session id (Workhub's own id for a plain terminal)."),
        c('agent', 'TEXT', "The agent family: claude, codex, kiro or another agent id (accounts of one agent share it); 'workhub-background' for the model runs Workhub starts by itself (Slack watcher reads, Listen summaries), one session per kind and account."),
        c('account_id', 'TEXT', "The Workhub account it ran under; 'unknown' when its config folder matches no account.", { nullable: 'the default account, or an agent without accounts' }),
        c('profile_id', 'TEXT', 'The Workhub profile it belongs to (by folder for transcript-only sessions).', { nullable: 'no profile owns its folder' }),
        c('cwd', 'TEXT', 'The folder it started in (its first line).', { nullable: 'not known yet' }),
        c('work_path', 'TEXT', 'The folder its latest turn worked in (edits and cd commands move it).', { nullable: 'no turn yet' }),
        c('project', 'TEXT', 'The project most of its turns worked in (see turns.project).', { nullable: 'no turn yet' }),
        c('title', 'TEXT', 'The name the user or the agent gave it, as shown in the app.', { nullable: 'Workhub never saw one' }),
        c('started_at', 'INTEGER', 'Its first prompt or first turn.', { unit: 'epoch_ms', nullable: 'not known' }),
        c('ended_at', 'INTEGER', 'When Workhub saw it stop (cleared when resumed); for a transcript-only session its last turn.', { unit: 'epoch_ms', nullable: 'still open' }),
        c('active_ms', 'INTEGER', "Agent time: the sum of its turns' turn_ms, sub-agents left out.", { unit: 'ms' }),
        c('last_model', 'TEXT', 'The model of its latest turn (before any turn, the one Workhub saw).', { nullable: 'not known' }),
        c('source', 'TEXT', "'workhub' when opened in Workhub, 'transcript' when only found on disk."),
        c('updated_at', 'INTEGER', 'When the row last changed.', { unit: 'epoch_ms' })
      ]
    },
    {
      name: 'turns',
      description: 'One assistant message with usage (Codex: one token report; Kiro: one turn), read from transcripts on this computer, for the last 12 months (older ones are summed per day in turns_daily). No message text.',
      writer: "The transcript scan (TurnIngest), after each token spend scan; the main process writes one row per Workhub background run (agent 'workhub-background', no folder).",
      columns: [
        c('id', 'INTEGER', 'Row id.'),
        c('session_id', 'TEXT', 'The session (sessions.id); a sub-agent counts for its parent.'),
        c('agent', 'TEXT', 'claude, codex or kiro.'),
        c('msg_key', 'TEXT', "Unique within the session: Claude's message id (also unique across Claude sessions), Codex's running totals, Kiro's end time and turn index."),
        c('at', 'INTEGER', 'When the message was written.', { unit: 'epoch_ms' }),
        c('model', 'TEXT', 'The model that answered.', { nullable: 'not reported' }),
        c('input_tokens', 'INTEGER', 'Fresh input tokens (cache reads and writes apart).', { unit: 'tokens' }),
        c('output_tokens', 'INTEGER', 'Output tokens.', { unit: 'tokens' }),
        c('cache_write_tokens', 'INTEGER', 'Input tokens written to the prompt cache.', { unit: 'tokens' }),
        c('cache_read_tokens', 'INTEGER', 'Input tokens read from the prompt cache.', { unit: 'tokens' }),
        c('usd', 'REAL', 'Cost at list prices, in dollars.', { unit: 'usd', nullable: 'the model has no known price (always for Kiro, which bills credits)' }),
        c('cwd', 'TEXT', 'The folder the session was working in at that message (moved by its edits and cd commands).'),
        c('project', 'TEXT', "The project of cwd: the deepest profile project folder holding it (a worktree counts for its repository), else its repository's root, else cwd."),
        c('turn_ms', 'INTEGER', 'Agent time: from the prompt or the previous reply to this message, at most 30 minutes; 0 for sub-agents.', { unit: 'ms' }),
        c('sidechain', 'INTEGER', '1 for a sub-agent message (its time runs inside the parent turn), else 0.')
      ]
    },
    {
      name: 'turns_daily',
      description:
        'Turns older than 12 months, summed per local day, session, model, folder and project (turns keeps the last 12 months only). Same columns as turns where they mean the same; add it to turns (UNION ALL, counting turns instead of rows) for totals that reach further back. Joins to sessions, session_links and session_tags like turns.',
      writer: 'The daily storage maintenance in the main process (and Compact now in Settings), which moves the turns here and deletes them.',
      columns: [
        c('day', 'INTEGER', 'Local midnight of the day summed.', { unit: 'epoch_ms' }),
        c('session_id', 'TEXT', 'The session (sessions.id).'),
        c('agent', 'TEXT', 'claude, codex or kiro.'),
        c('model', 'TEXT', 'The model that answered.', { nullable: 'not reported' }),
        c('cwd', 'TEXT', 'The folder the turns worked in (see turns.cwd).'),
        c('project', 'TEXT', 'The project of cwd (see turns.project).'),
        c('priced', 'INTEGER', '1 when the turns had a price (usd is their sum), 0 when not (usd is null).'),
        c('at', 'INTEGER', 'The first turn summed: the time reports place the row at.', { unit: 'epoch_ms' }),
        c('last_at', 'INTEGER', 'The last turn summed.', { unit: 'epoch_ms' }),
        c('input_tokens', 'INTEGER', 'Fresh input tokens, summed.', { unit: 'tokens' }),
        c('output_tokens', 'INTEGER', 'Output tokens, summed.', { unit: 'tokens' }),
        c('cache_write_tokens', 'INTEGER', 'Cache write tokens, summed.', { unit: 'tokens' }),
        c('cache_read_tokens', 'INTEGER', 'Cache read tokens, summed.', { unit: 'tokens' }),
        c('usd', 'REAL', 'Cost at list prices, summed.', { unit: 'usd', nullable: 'unpriced turns (priced = 0)' }),
        c('turn_ms', 'INTEGER', 'Agent time, summed; sub-agent turns already left out (there is no sidechain column).', { unit: 'ms' }),
        c('turns', 'INTEGER', 'How many turns the row sums.')
      ]
    },
    {
      name: 'session_links',
      description: 'What a session is related to, as Workhub detected it. Links are never removed.',
      writer: 'The session recorder (monitor snapshots, the session worktree).',
      columns: [
        c('session_id', 'TEXT', 'The session (sessions.id).'),
        c('kind', 'TEXT', "'pr', 'ticket', 'branch' or 'worktree'."),
        c('ref', 'TEXT', 'Pull request URL (canonical), ticket key (upper case), branch name or worktree folder.'),
        c('source', 'TEXT', 'How it was found: acted, user, reply, tracker, git or workhub.', { nullable: 'not recorded' }),
        c('at', 'INTEGER', 'When it was first recorded.', { unit: 'epoch_ms' })
      ]
    },
    {
      name: 'session_tags',
      description: 'Free tags the user put on a session.',
      writer: 'The analytics:setTags IPC (the main window).',
      columns: [c('session_id', 'TEXT', 'The session (sessions.id).'), c('tag', 'TEXT', 'The tag, lower case: letters, digits, spaces, _ - and . (at most 40).'), c('at', 'INTEGER', 'When it was added.', { unit: 'epoch_ms' })]
    },
    {
      name: 'automation_runs',
      description: 'Every automation run of the last 12 months.',
      writer: 'The automations service, each time the engine logs or updates a run.',
      columns: [
        c('id', 'TEXT', 'Run id.'),
        c('automation_id', 'TEXT', 'The automation.'),
        c('profile_id', 'TEXT', "The automation's profile.", { nullable: 'an automation without a profile, or one removed' }),
        c('trigger', 'TEXT', 'chat, interval or manual.'),
        c('started_at', 'INTEGER', 'When it started (queued, for a run that never started).', { unit: 'epoch_ms' }),
        c('ended_at', 'INTEGER', 'When it ended.', { unit: 'epoch_ms', nullable: 'never started or still running' }),
        c('status', 'TEXT', 'ok, error, rateLimited, timeout, skipped, coalesced or stopped.'),
        c('session_id', 'TEXT', 'The session it ran in (its identity).', { nullable: 'it never opened one' }),
        c('summary_json', 'TEXT', "JSON: automationName, queuedAt, startedAt, merged, detail (a reason code or the agent's error text), triggerLink, cost, tokens.")
      ]
    },
    {
      name: 'pr_events',
      description: 'Pull request timeline: what the code host sync saw in the last 12 months.',
      writer: 'The pull request sync (every 3 minutes per profile with a code host).',
      columns: [
        c('id', 'TEXT', 'Profile and event id.'),
        c('profile_id', 'TEXT', 'The profile whose sync saw it.'),
        c('repo', 'TEXT', 'owner/repo, lower case.'),
        c('number', 'INTEGER', 'Pull request number.', { nullable: 'not readable from the event' }),
        c('url', 'TEXT', 'The pull request URL.'),
        c('kind', 'TEXT', 'opened (first seen open, one of yours), reviewed (left your review queue), reviewRequested, approved, changesRequested, newComments, ciFailed, ciPassed, conflicts, newCommits, merged or closed.'),
        c('at', 'INTEGER', 'When the sync saw it.', { unit: 'epoch_ms' }),
        c('actor', 'TEXT', 'Who asked for a review.', { nullable: 'not known' }),
        c('title', 'TEXT', 'The pull request title.', { nullable: 'not known' }),
        c('json', 'TEXT', 'The event as detected.')
      ]
    },
    {
      name: 'ticket_events',
      description: "Ticket timeline: changes the ticket watcher saw in the active profile's assigned tickets in the last 12 months.",
      writer: 'The ticket watcher (while ticket notifications are on).',
      columns: [
        c('id', 'INTEGER', 'Row id.'),
        c('profile_id', 'TEXT', 'The profile whose tracker was read.'),
        c('key', 'TEXT', 'The ticket key.'),
        c('kind', 'TEXT', 'status, assigned or left.'),
        c('at', 'INTEGER', 'When the watcher saw it.', { unit: 'epoch_ms' }),
        c('from_value', 'TEXT', 'The status before.', { nullable: 'not a status change' }),
        c('to_value', 'TEXT', 'The status after (or on assignment).', { nullable: 'a ticket that left' }),
        c('title', 'TEXT', 'The ticket title.', { nullable: 'not known' }),
        c('json', 'TEXT', 'The change as detected.')
      ]
    },
    {
      name: 'flow_maps',
      description: 'The flow maps of the Flow maps screen, one per row.',
      writer: 'The Flow maps screen and POST /v1/flow-maps.',
      columns: [c('id', 'TEXT', 'The map id.'), c('json', 'TEXT', 'The map as written (read it with json_extract).'), c('updated_at', 'INTEGER', 'When it was last saved.', { unit: 'epoch_ms' })]
    },
    {
      name: 'flow_history_measures',
      description: 'What is known of each measured flow (a scope is a hash of profile, connection and environment).',
      writer: 'The flow history fetcher.',
      columns: [
        c('scope', 'TEXT', 'The scope hash.'),
        c('measure', 'TEXT', 'The measure id.'),
        c('settled_until', 'INTEGER', 'Up to when the hours are final.', { unit: 'epoch_ms' }),
        c('fetched_at', 'INTEGER', 'The last read.', { unit: 'epoch_ms' })
      ]
    },
    {
      name: 'flow_history_hours',
      description: 'Hourly aggregates of a measure, kept for a limited number of days.',
      writer: 'The flow history fetcher.',
      columns: [
        c('scope', 'TEXT', 'The scope hash.'),
        c('measure', 'TEXT', 'The measure id.'),
        c('hour_at', 'INTEGER', 'The hour.', { unit: 'epoch_ms' }),
        c('json', 'TEXT', 'The hour as JSON (counts, errors, latencies).'),
        c('fetched_at', 'INTEGER', 'When it was read.', { unit: 'epoch_ms' })
      ]
    }
  ]
}
