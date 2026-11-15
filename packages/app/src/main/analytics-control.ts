/**
 * Analytics over the control endpoint: what an agent in a Workhub session may read of the usage
 * database (`workhub.db`) to answer "how much did I spend on X", "what did I work on this week".
 * Everything here is read-only, so a reviewer (read-only) session may call it too. Reads are not
 * scoped to the caller's profile (like `/v1/history`). It is not offered to paired devices (the
 * remote allowlist does not name it).
 *
 *   GET  /v1/analytics/schema   the tables, their columns, how to query and example queries
 *   POST /v1/analytics/query    one SELECT/WITH over the readable tables, checked here
 *                               (`checkReadOnlySql`) and run in a separate process (`analytics-queries.ts`)
 *   GET  /v1/analytics/report   spend per project, ticket, tag or agent, or a week, from the usage database
 */
import { canonicalUrl } from '@workhub/core'
import {
  checkQueryParams,
  checkReadOnlySql,
  deniedTables,
  QUERY_LIMITS,
  READABLE_TABLES,
  schemaDescription,
  spendGroups,
  spendSeries,
  weeklySummary,
  weekStartOf,
  type QueryParams,
  type QueryResult,
  type SpendFilters,
  type SpendGroupBy,
  type SpendRow,
  type WorkhubDb
} from '@workhub/adapters/sqlite-store'
import { QueryGuardUnavailable } from './analytics-queries'
import type { ControlReply } from './control-server'
import { resolveControlProfile, type ControlProfileDeps } from './plan-control'

const DAY_MS = 86_400_000
/** The longest span a report covers. */
export const REPORT_MAX_DAYS = 400
/** Characters of a query, and of an error, kept in the diagnostics log. */
const LOGGED_CHARS = 300

export const REPORT_KINDS = ['spend_by_project', 'spend_by_ticket', 'spend_by_tag', 'spend_by_agent', 'weekly'] as const
export type ReportKind = (typeof REPORT_KINDS)[number]
const GROUP_OF: Record<Exclude<ReportKind, 'weekly'>, SpendGroupBy> = { spend_by_project: 'project', spend_by_ticket: 'ticket', spend_by_tag: 'tag', spend_by_agent: 'agent' }
/** Filters of the spend kinds; `weekly` takes none of them. */
const FILTERS = ['until', 'bucket', 'tag', 'folder', 'pr', 'ticket', 'model', 'agent'] as const

/** What "tokens" means in the answers, as on Home and the Usage screen. */
export const TOKENS_MEANING = '"tokens" is input + output + cache writes (input_tokens + output_tokens + cache_write_tokens), the same count as Home and the Usage screen.'

export const PROJECT_MEANING = 'A project is the deepest project folder of a Workhub profile holding the folder a turn worked in (a worktree counts for its repository), else the git repository root, else the folder itself.'

export interface AnalyticsQueryRunner {
  run(sql: string, params: QueryParams, limit: number, deniedTables: readonly string[]): Promise<QueryResult>
}

export interface AnalyticsControlDeps extends ControlProfileDeps {
  db: WorkhubDb
  /** Runs a checked query out of the main process (`AnalyticsQueries`). */
  queries: AnalyticsQueryRunner
  now?: () => number
  log?: (message: string) => void
}

export interface AnalyticsControl {
  schema(params: URLSearchParams): Promise<ControlReply>
  query(body: unknown, params: URLSearchParams): Promise<ControlReply>
  report(params: URLSearchParams): Promise<ControlReply>
}

const fail = (status: number, error: string): ControlReply => ({ status, body: { ok: false, error } })
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const iso = (ms: number) => new Date(ms).toISOString()
const cut = (text: string) => (text.length > LOGGED_CHARS ? `${text.slice(0, LOGGED_CHARS - 1)}…` : text)
const usd4 = (v: number) => Math.round(v * 10_000) / 10_000

export const HOW_TO = [
  'POST /v1/analytics/query with {"sql": "...", "params": [...], "limit": 500}: one SELECT or WITH statement (SQLite); values go in params (? or :name), never spliced into the text. A keyword used as a name (commit, release, edit) must be quoted: "commit".',
  "Times are epoch milliseconds (UTC). Show one with datetime(at / 1000, 'unixepoch', 'localtime'). Day, week and month bounds are in this computer's local time zone: this month starts at strftime('%s', 'now', 'localtime', 'start of month', 'utc') * 1000; the last 30 days at strftime('%s', 'now', '-30 days') * 1000; label a week by its Monday with date(at / 1000, 'unixepoch', 'localtime', '-6 days', 'weekday 1').",
  'Agent time is turns.turn_ms (and sessions.active_ms): the time an agent spent on each reply, summed across sessions that ran in parallel, so it can exceed wall-clock time. Sub-agent rows (turns.sidechain = 1) count tokens and dollars but have turn_ms = 0.',
  `Tokens: ${TOKENS_MEANING} Cache reads are apart (cacheRead, cache_read_tokens): they are cheap and would dwarf the rest.`,
  'Dollars are turns.usd at list prices; null when the model has no known price (TOTAL() counts null as 0; SUM() of only nulls is null).',
  `turns.project and sessions.project: ${PROJECT_MEANING} turns.cwd, sessions.cwd and work_path are folders on this computer; show their last part unless the full path is wanted.`,
  "session_links: kind is pr, ticket, branch or worktree. A pr ref is the canonical pull request URL in lower case, no trailing slash (https://github.com/acme/api/pull/42); a ticket ref is the key in upper case. A session linked to several tickets, PRs or tags counts once in each, so per-group sums can add up to more than the total.",
  'pr_events: repo is owner/repo in lower case and number the PR number; when the event did not name them, repo holds the URL and number is null. Join to sessions with lower(p.url) = l.ref.',
  'Numbers in params bind as floating point: compare them freely, but CAST(:n AS INTEGER) before concatenating one into text.',
  'Nullable columns and what null means are listed per column in this schema (nullable). SELECT name, sql FROM sqlite_master is allowed.',
  `At most ${QUERY_LIMITS.maxRows} rows (default ${QUERY_LIMITS.defaultRows}): truncated = true means there were more, or the query was stopped. A query running longer than ${QUERY_LIMITS.budgetMs / 1000} s is stopped: timedOut = true and no rows. Aggregate in SQL instead of reading raw turns. kv_state and schema_migrations cannot be read.`
]

export const EXAMPLES: { title: string; sql: string; params?: (string | number)[] | Record<string, string | number> }[] = [
  {
    title: 'Spend and agent time per project, last 30 days',
    sql: `SELECT COALESCE(project, cwd) AS project, ROUND(TOTAL(usd), 2) AS usd, ROUND(SUM(turn_ms) / 3600000.0, 1) AS hours, COUNT(DISTINCT session_id) AS sessions
FROM turns WHERE at >= strftime('%s', 'now', '-30 days') * 1000
GROUP BY 1 ORDER BY usd DESC LIMIT 20`
  },
  {
    title: 'Spend per ticket, last 30 days (a session linked to two tickets counts in both)',
    sql: `SELECT l.ref AS ticket, ROUND(TOTAL(t.usd), 2) AS usd, ROUND(SUM(t.turn_ms) / 3600000.0, 1) AS hours, COUNT(DISTINCT t.session_id) AS sessions
FROM turns t JOIN session_links l ON l.session_id = t.session_id AND l.kind = 'ticket'
WHERE t.at >= strftime('%s', 'now', '-30 days') * 1000
GROUP BY l.ref ORDER BY usd DESC`
  },
  {
    title: 'Spend per tag',
    sql: `SELECT g.tag, ROUND(TOTAL(t.usd), 2) AS usd, COUNT(DISTINCT t.session_id) AS sessions
FROM turns t JOIN session_tags g ON g.session_id = t.session_id
GROUP BY g.tag ORDER BY usd DESC`
  },
  {
    title: 'Sessions that worked on a pull request (by URL)',
    sql: `SELECT s.id, s.agent, s.title, datetime(s.started_at / 1000, 'unixepoch', 'localtime') AS started, ROUND(s.active_ms / 60000.0) AS minutes
FROM sessions s JOIN session_links l ON l.session_id = s.id
WHERE l.kind = 'pr' AND l.ref = :pr ORDER BY s.started_at`,
    params: { pr: 'https://github.com/acme/api/pull/42' }
  },
  {
    title: 'Sessions that worked on a pull request (by number, any repository)',
    sql: `SELECT l.ref AS pr, s.id, s.title, ROUND(s.active_ms / 60000.0) AS minutes
FROM sessions s JOIN session_links l ON l.session_id = s.id
WHERE l.kind = 'pr' AND l.ref LIKE '%/pull/' || CAST(:n AS INTEGER) ORDER BY s.started_at`,
    params: { n: 42 }
  },
  {
    title: 'Pull request timeline with the sessions that worked on it',
    sql: `SELECT datetime(p.at / 1000, 'unixepoch', 'localtime') AS at, p.kind, p.actor, p.title, COUNT(DISTINCT l.session_id) AS sessions
FROM pr_events p LEFT JOIN session_links l ON l.kind = 'pr' AND l.ref = lower(p.url)
WHERE p.repo = ? AND p.number = ? GROUP BY p.id ORDER BY p.at`,
    params: ['acme/api', 42]
  },
  {
    title: 'Agent hours and dollars per week (labelled by its Monday)',
    sql: `SELECT date(at / 1000, 'unixepoch', 'localtime', '-6 days', 'weekday 1') AS week, ROUND(SUM(turn_ms) / 3600000.0, 1) AS hours, ROUND(TOTAL(usd), 2) AS usd
FROM turns GROUP BY week ORDER BY week DESC LIMIT 12`
  },
  {
    title: 'Spend per model this month',
    sql: `SELECT model, ROUND(TOTAL(usd), 2) AS usd, SUM(output_tokens) AS tokens_out
FROM turns WHERE at >= strftime('%s', 'now', 'localtime', 'start of month', 'utc') * 1000
GROUP BY model ORDER BY usd DESC`
  },
  {
    title: 'Failed automation runs, last 7 days',
    sql: `SELECT json_extract(summary_json, '$.automationName') AS automation, status, json_extract(summary_json, '$.detail') AS detail, datetime(started_at / 1000, 'unixepoch', 'localtime') AS started
FROM automation_runs WHERE status IN ('error', 'timeout') AND started_at >= strftime('%s', 'now', '-7 days') * 1000
ORDER BY started_at DESC`
  },
  {
    title: 'Status changes of a ticket',
    sql: `SELECT datetime(at / 1000, 'unixepoch', 'localtime') AS at, kind, from_value, to_value FROM ticket_events WHERE key = ? ORDER BY at`,
    params: ['ABC-123']
  }
]

/** A time from a query value: epoch ms (13 digits or more), or an ISO date (local midnight) or date-time. */
export function timeOf(raw: string | null): number | undefined | string {
  if (raw === null || raw === '') return undefined
  const bad = `"${raw}" is not a time: send an ISO date (2026-11-01), an ISO date-time or epoch milliseconds (13 digits)`
  if (/^\d+$/.test(raw)) return raw.length >= 13 ? Number(raw) : bad
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) return bad
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : bad
}

/** `SpendRow` for an agent: dollars to 4 decimals, and `tokens` (input + output + cache writes, as Home and Usage count them). */
const spendAnswer = ({ bucketStart: _b, ...r }: SpendRow) => ({ ...r, tokens: r.tokensIn + r.tokensOut + r.cacheWrite, usd: usd4(r.usd) })

/** Every `usd` in a value rounded to 4 decimals. */
function roundUsd<T>(v: T): T {
  if (Array.isArray(v)) return v.map(roundUsd) as T
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'usd' && typeof x === 'number' ? usd4(x) : roundUsd(x)])) as T
  return v
}

export function createAnalyticsControl(deps: AnalyticsControlDeps): AnalyticsControl {
  const now = deps.now ?? Date.now
  /** Same check as every other route: a session that is sent must exist. Reads only, so a reviewer passes. */
  const who = (params: URLSearchParams, body?: unknown) =>
    resolveControlProfile(deps, { session: (isRecord(body) ? body['session'] : undefined) ?? params.get('session') ?? undefined, cwd: (isRecord(body) ? body['cwd'] : undefined) ?? params.get('cwd') ?? undefined })
  const fileTables = () => (deps.db.raw.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view')`).all() as { name: string }[]).map((r) => r.name)

  return {
    async schema(params) {
      const caller = await who(params)
      if (!caller.ok) return fail(caller.status, caller.error)
      return {
        status: 200,
        body: {
          ok: true,
          tables: schemaDescription(),
          readable: READABLE_TABLES,
          projectMeaning: PROJECT_MEANING,
          howTo: HOW_TO,
          examples: EXAMPLES,
          limits: { rows: { default: QUERY_LIMITS.defaultRows, max: QUERY_LIMITS.maxRows }, budgetMs: QUERY_LIMITS.budgetMs, sqlBytes: QUERY_LIMITS.sqlBytes, params: QUERY_LIMITS.params }
        }
      }
    },

    async query(body, params) {
      if (!isRecord(body)) return fail(400, 'the body must be a JSON object: {"sql": "...", "params": [...], "limit": 500}')
      const caller = await who(params, body)
      if (!caller.ok) return fail(caller.status, caller.error)
      const sql = body['sql']
      if (typeof sql !== 'string') return fail(400, '"sql" must be a string')
      const rawLimit = body['limit']
      if (rawLimit !== undefined && rawLimit !== null && (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1)) return fail(400, '"limit" must be a positive whole number')
      const limit = Math.min(typeof rawLimit === 'number' ? rawLimit : QUERY_LIMITS.defaultRows, QUERY_LIMITS.maxRows)
      // The text only: bound values are never logged.
      const logged = cut(sql.replace(/\s+/g, ' ').trim())
      const by = caller.session ?? '-'
      const bound = checkQueryParams(body['params'])
      if (typeof bound === 'string') return fail(400, bound)
      const tables = fileTables()
      const refused = checkReadOnlySql(sql, tables)
      if (refused) {
        deps.log?.(`analytics query refused (session ${by}): ${cut(refused)} | ${logged}`)
        return fail(400, refused)
      }
      let result: QueryResult
      try {
        result = await deps.queries.run(sql, bound, limit, [...deniedTables(tables)])
      } catch (e) {
        if (e instanceof QueryGuardUnavailable) {
          deps.log?.(`analytics query refused (session ${by}): ${e.message} | ${logged}`)
          return fail(503, `${e.message}: this Workhub cannot run SQL queries; use GET /v1/analytics/report`)
        }
        const message = e instanceof Error ? e.message : String(e)
        deps.log?.(`analytics query failed (session ${by}): ${cut(message)} | ${logged}`)
        return fail(400, `SQLite: ${cut(message)}`)
      }
      deps.log?.(`analytics query (session ${by}): ${result.timedOut ? 'stopped at the time budget' : `${result.rowCount} rows${result.truncated ? ' (truncated)' : ''}`} in ${result.elapsedMs} ms | ${logged}`)
      return { status: 200, body: { ok: true, ...result } }
    },

    async report(params) {
      const caller = await who(params)
      if (!caller.ok) return fail(caller.status, caller.error)
      const kind = params.get('kind') ?? ''
      if (!(REPORT_KINDS as readonly string[]).includes(kind)) return fail(400, `"kind" must be one of ${REPORT_KINDS.join(', ')}`)
      const since = timeOf(params.get('since'))
      if (typeof since === 'string') return fail(400, since)
      const until = timeOf(params.get('until'))
      if (typeof until === 'string') return fail(400, until)
      // The caller's profile unless asked otherwise: "all" for every profile, or a profile id.
      const profileRaw = params.get('profile') || 'current'
      let profileId: string | undefined
      if (profileRaw === 'current') profileId = caller.profileId
      else if (profileRaw !== 'all') {
        if (!(await deps.profiles()).ids.includes(profileRaw)) return fail(404, 'unknown profile')
        profileId = profileRaw
      }
      const profile = profileId !== undefined ? { profileId } : {}
      if (kind === 'weekly') {
        const extra = FILTERS.find((f) => params.get(f))
        if (extra) return fail(400, `"${extra}" does not apply to weekly: it takes since (any day of the week) and profile`)
        const week = weeklySummary(deps.db, { ...profile, weekStart: weekStartOf(since ?? now()) })
        // The week's totals leave cache writes out; `tokens` counts them, as Home and Usage do.
        const all = spendGroups(deps.db, { since: week.weekStart, until: week.weekEnd, groupBy: 'none', filters: profile })[0]
        const tokens = all ? all.tokensIn + all.tokensOut + all.cacheWrite : 0
        return { status: 200, body: roundUsd({ ok: true, kind, profile: profileId ?? 'all', projectMeaning: PROJECT_MEANING, tokensMeaning: TOKENS_MEANING, ...week, tokens, weekStartIso: iso(week.weekStart), weekEndIso: iso(week.weekEnd) }) }
      }
      const bucket = params.get('bucket') || 'day'
      if (bucket !== 'day' && bucket !== 'week') return fail(400, '"bucket" must be day or week')
      const to = until ?? now()
      const from = since ?? to - 30 * DAY_MS
      if (from >= to) return fail(400, '"since" must be before "until"')
      if (to - from > REPORT_MAX_DAYS * DAY_MS) return fail(400, `at most ${REPORT_MAX_DAYS} days per report`)
      const filters: SpendFilters = { ...profile }
      const tag = params.get('tag')
      if (tag) filters.tag = tag.trim().replace(/\s+/g, ' ').toLowerCase()
      const folder = params.get('folder')
      if (folder) filters.cwdPrefix = folder
      const pr = params.get('pr')
      if (pr) filters.pr = canonicalUrl(pr)
      const ticket = params.get('ticket')
      if (ticket) filters.ticket = ticket.trim().toUpperCase()
      const model = params.get('model')
      if (model) filters.model = model
      const agent = params.get('agent')
      if (agent) filters.agent = agent
      const groupBy = GROUP_OF[kind as keyof typeof GROUP_OF]
      const span = { since: from, until: to, filters }
      const totals = spendGroups(deps.db, { ...span, groupBy: 'none' })[0]
      const groups = spendGroups(deps.db, { ...span, groupBy })
      const rows = spendSeries(deps.db, { ...span, bucket, groupBy })
      const overlap = groupBy === 'ticket' || groupBy === 'tag'
      return {
        status: 200,
        body: {
          ok: true,
          kind,
          since: from,
          sinceIso: iso(from),
          until: to,
          untilIso: iso(to),
          bucket,
          profile: profileId ?? 'all',
          filters: Object.fromEntries(Object.entries(filters).filter(([k]) => k !== 'profileId')),
          ...(groupBy === 'project' ? { projectMeaning: PROJECT_MEANING } : {}),
          groupsOverlap: overlap,
          ...(overlap ? { note: 'A session linked to several groups counts in each, so the groups can add up to more than the totals; totals count every turn once. The null group is turns with no link.' } : {}),
          tokensMeaning: TOKENS_MEANING,
          totals: totals ? spendAnswer(totals) : { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, usd: 0, unpricedTokens: 0, activeMs: 0, turns: 0, sessions: 0, group: null },
          groups: groups.map(spendAnswer),
          rows: rows.map((r) => ({ bucketStart: r.bucketStart, bucketStartIso: iso(r.bucketStart), ...spendAnswer(r) }))
        }
      }
    }
  }
}

