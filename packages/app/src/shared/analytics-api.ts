/**
 * The usage reports bridge (`window.hub.analytics`): spend per bucket and group, totals per group,
 * the sessions table, the weekly summary and the values the filters offer. Main answers from the
 * `turns`, `sessions`, `session_links` and `session_tags` tables (`sqlite-store/analytics.ts`).
 * Not offered to paired devices.
 */

export type ReportBucket = 'day' | 'week'
export type ReportGroupBy = 'project' | 'agent' | 'model' | 'account' | 'ticket' | 'pr' | 'tag' | 'none'
export const REPORT_GROUPS: readonly ReportGroupBy[] = ['project', 'agent', 'model', 'account', 'ticket', 'pr', 'tag', 'none']

export interface ReportFilters {
  profileId?: string
  /** A folder: turns whose project or folder is it or below it. */
  cwdPrefix?: string
  /** A project exactly (the resolved project folder). */
  project?: string
  agent?: string
  account?: string
  model?: string
  ticket?: string
  pr?: string
  tag?: string
}
export const REPORT_FILTER_KEYS = ['profileId', 'cwdPrefix', 'project', 'agent', 'account', 'model', 'ticket', 'pr', 'tag'] as const

export interface SpendQuery {
  /** Epoch ms, inclusive. */
  since: number
  /** Epoch ms, exclusive. */
  until: number
  bucket: ReportBucket
  groupBy: ReportGroupBy
  filters?: ReportFilters
}

export interface TotalsQuery {
  since: number
  until: number
  groupBy: ReportGroupBy
  filters?: ReportFilters
}

/** Sums of one group: tokens, list-price dollars, agent time, turns and distinct sessions. */
export interface SpendTotals {
  /** The group's value (folder, agent, model, account id, ticket key, PR URL, tag); null for none. */
  group: string | null
  tokensIn: number
  tokensOut: number
  cacheRead: number
  cacheWrite: number
  usd: number
  /** Tokens of turns whose model has no price (not in `usd`). */
  unpricedTokens: number
  activeMs: number
  turns: number
  sessions: number
}

export interface SpendPoint extends SpendTotals {
  /** Epoch ms of the bucket's local start. */
  bucketStart: number
}

export interface SessionsQuery extends ReportFilters {
  /** Sessions active at or after this epoch ms. */
  since?: number
  /** Sessions that started before this epoch ms. */
  until?: number
  limit?: number
  /** The previous page's `nextCursor`. */
  cursor?: string | null
  /** Only sessions with a turn the filters keep, as the totals count them (the reports always ask for it). */
  turnsOnly?: boolean
}

export interface ReportSession {
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

export interface ReportSessionPage {
  rows: ReportSession[]
  nextCursor: string | null
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

export interface WeeklyReport {
  weekStart: number
  weekEnd: number
  sessions: number
  activeMs: number
  usd: number
  tokensIn: number
  tokensOut: number
  projects: (WeeklyItem & { project: string })[]
  prs: WeeklyItem[]
  tickets: WeeklyItem[]
  /** Pull requests first seen open, merged, and reviewed during the week. */
  prsOpened: WeeklyPr[]
  prsMerged: WeeklyPr[]
  prsReviewed: WeeklyPr[]
  /** Ticket status changes, oldest first. */
  ticketMoves: { key: string; from: string | null; to: string | null; title: string | null; at: number }[]
}

export interface WeeklyPr {
  url: string
  repo: string
  number: number | null
  title: string | null
  at: number
}

export interface ReportFilterValues {
  profiles: string[]
  projects: string[]
  agents: string[]
  accounts: string[]
  models: string[]
  tickets: string[]
  prs: string[]
  tags: string[]
}

/** One row of the totals table as exported: numbers raw, in the units the headers name. */
export interface UsageCsvRow {
  /** The group as the table names it, in full (a folder path, a pull request URL). */
  group: string
  tokensIn: number
  tokensOut: number
  /** Cache reads and writes together, as the table's Cache column. */
  cache: number
  usd: number
  sessions: number
  /** Agent time, in whole seconds. */
  activeSeconds: number
}

/** The totals table as it is filtered, grouped and sorted on screen. The renderer never names the file: main asks the user where. */
export interface UsageCsvExport {
  groupBy: ReportGroupBy
  /** The period shown: epoch ms, `since` inclusive and `until` exclusive. */
  since: number
  until: number
  /** The column titles, in the language of the screen: group, input, output, cache, cost, sessions, agent time. */
  headers: string[]
  rows: UsageCsvRow[]
}

export type UsageCsvResult = { ok: true; path: string } | { ok: false; canceled: boolean; error?: string }

export interface AnalyticsApi {
  /** The free tags on a session (by its identity: the agent's session id), sorted. */
  tags(sessionId: string): Promise<string[]>
  /** Replaces a session's tags; returns them as stored (trimmed, lower case, deduplicated). */
  setTags(sessionId: string, tags: string[]): Promise<string[]>
  /** Spend per bucket (day or week) and group, oldest bucket first. */
  spend(query: SpendQuery): Promise<SpendPoint[]>
  /** Spend per group over the whole period, largest first. */
  totals(query: TotalsQuery): Promise<SpendTotals[]>
  /** Sessions matching the filters, most recently active first, a page at a time. */
  sessions(query: SessionsQuery): Promise<ReportSessionPage>
  /** The week from `weekStart` (a local Monday): time and dollars per project, PRs and tickets. */
  weekly(query: { weekStart: number; profileId?: string }): Promise<WeeklyReport>
  /** The values each filter offers. */
  filters(query: { profileId?: string; since?: number; until?: number }): Promise<ReportFilterValues>
  /** Saves the totals table as a CSV file: main shows the save dialog and writes it. */
  exportCsv(table: UsageCsvExport): Promise<UsageCsvResult>
  /** Reads the transcripts now (the token spend scan, then new turns) instead of at the next 10-minute scan; resolves when done or after about 20 s. */
  refresh(): Promise<void>
}
