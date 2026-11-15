/**
 * What the main process records as it happens, next to the turns read from transcripts: the
 * sessions Workhub opens, what they are related to (pull requests, tickets, branches, worktrees),
 * the user's tags, every automation run, and the pull request and ticket timelines.
 * Every write is idempotent on a natural key, so recording the same fact twice changes nothing.
 */
import type { AutomationRun, PrEvent, TicketChange } from '@workhub/core'
import type { WorkhubDb } from './db'
import { refreshSessionTotals } from './turns'

export type SessionLinkKind = 'pr' | 'ticket' | 'branch' | 'worktree'

export interface SessionLink {
  kind: SessionLinkKind
  ref: string
  /** How it was found (`acted`, `user`, `reply`, `tracker`, `git`, `workhub`). */
  source?: string
}

export interface WorkhubSessionRecord {
  id: string
  /** The spend agent family (`spendAgentId`): what the transcript scan records for the same session. */
  agent: string
  accountId: string | null
  profileId: string | null
  /** The folder it started in. */
  cwd: string
  title?: string | null
  startedAt: number
  /** When Workhub saw it stop; null while it runs (a resumed session clears it). The first stop time is kept. */
  endedAt?: number | null
  /** The model it reported, until its turns say (the latest turn's model wins). */
  model?: string | null
}

/** The longest tag, and the most tags on one session. */
export const TAG_MAX_LENGTH = 40
export const TAGS_PER_SESSION = 20
/** What a tag may hold once normalized: letters, digits, spaces, `_`, `-` and `.`. */
export const TAG_PATTERN = /^[\p{L}\p{N} _\-.]{1,40}$/u

/** A tag as stored: trimmed, inner spaces folded, lower case; empty when nothing is left. */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/\s+/g, ' ').toLowerCase()
}

export class SessionRecords {
  constructor(
    private readonly db: WorkhubDb,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * A session opened in Workhub: its row is marked `workhub` and keeps the turns' totals. The work
   * folder, project and (once it has turns) model come from the transcript scan; a worktree is a link.
   */
  upsertSession(s: WorkhubSessionRecord): void {
    this.db.transaction(() => {
      this.db.raw
        .prepare(
          `INSERT INTO sessions (id, agent, account_id, profile_id, cwd, title, started_at, ended_at, last_model, source, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'workhub', ?)
           ON CONFLICT (id) DO UPDATE SET agent = excluded.agent, account_id = COALESCE(excluded.account_id, sessions.account_id),
             profile_id = COALESCE(excluded.profile_id, sessions.profile_id), cwd = COALESCE(sessions.cwd, excluded.cwd),
             title = COALESCE(excluded.title, sessions.title),
             started_at = MIN(COALESCE(sessions.started_at, excluded.started_at), excluded.started_at),
             ended_at = CASE WHEN excluded.ended_at IS NULL THEN NULL ELSE COALESCE(CASE WHEN sessions.source = 'workhub' THEN sessions.ended_at END, excluded.ended_at) END,
             last_model = COALESCE(sessions.last_model, excluded.last_model), source = 'workhub', updated_at = excluded.updated_at`
        )
        .run(s.id, s.agent, s.accountId, s.profileId, s.cwd, s.title ?? null, s.startedAt, s.endedAt ?? null, s.model ?? null, this.now())
      refreshSessionTotals(this.db, s.id)
    })
  }

  /**
   * Moves what was recorded under `oldId` (a session recorded before its agent's id was known) to
   * `newId`: links and tags join the new row, and the old row merges into it.
   */
  rekey(oldId: string, newId: string): void {
    if (oldId === newId) return
    this.db.transaction(() => {
      this.db.raw.prepare('UPDATE OR IGNORE session_links SET session_id = ? WHERE session_id = ?').run(newId, oldId)
      this.db.raw.prepare('DELETE FROM session_links WHERE session_id = ?').run(oldId)
      this.db.raw.prepare('UPDATE OR IGNORE session_tags SET session_id = ? WHERE session_id = ?').run(newId, oldId)
      this.db.raw.prepare('DELETE FROM session_tags WHERE session_id = ?').run(oldId)
      const old = this.db.raw.prepare('SELECT * FROM sessions WHERE id = ?').get(oldId) as Record<string, string | number | null> | undefined
      if (old) {
        this.db.raw.prepare('DELETE FROM sessions WHERE id = ?').run(oldId)
        this.db.raw
          .prepare(
            `INSERT INTO sessions (id, agent, account_id, profile_id, cwd, title, started_at, ended_at, last_model, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET account_id = COALESCE(sessions.account_id, excluded.account_id), profile_id = COALESCE(sessions.profile_id, excluded.profile_id),
               cwd = COALESCE(sessions.cwd, excluded.cwd), title = COALESCE(sessions.title, excluded.title), started_at = MIN(COALESCE(sessions.started_at, excluded.started_at), COALESCE(excluded.started_at, sessions.started_at)),
               source = CASE WHEN excluded.source = 'workhub' THEN 'workhub' ELSE sessions.source END, updated_at = excluded.updated_at`
          )
          .run(newId, ...(['agent', 'account_id', 'profile_id', 'cwd', 'title', 'started_at', 'ended_at', 'last_model', 'source'] as const).map((k) => old[k] ?? null), this.now())
        refreshSessionTotals(this.db, newId)
      }
    })
  }

  /** Whether a session is recorded. */
  has(sessionId: string): boolean {
    return !!this.db.raw.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)
  }

  /** Adds the links not recorded yet (a link is never removed: the session was related to it); returns how many were new. */
  addLinks(sessionId: string, links: readonly SessionLink[]): number {
    if (!links.length) return 0
    const at = this.now()
    return this.db.transaction(() => {
      const insert = this.db.raw.prepare('INSERT OR IGNORE INTO session_links (session_id, kind, ref, source, at) VALUES (?, ?, ?, ?, ?)')
      let added = 0
      for (const l of links) if (l.ref) added += Number(insert.run(sessionId, l.kind, l.ref, l.source ?? null, at).changes)
      return added
    })
  }

  links(sessionId: string): SessionLink[] {
    return (this.db.raw.prepare('SELECT kind, ref, source FROM session_links WHERE session_id = ? ORDER BY at, kind, ref').all(sessionId) as { kind: SessionLinkKind; ref: string; source: string | null }[]).map((r) => ({
      kind: r.kind,
      ref: r.ref,
      ...(r.source ? { source: r.source } : {})
    }))
  }

  tags(sessionId: string): string[] {
    return (this.db.raw.prepare('SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag').all(sessionId) as { tag: string }[]).map((r) => r.tag)
  }

  /**
   * Replaces a session's tags (normalized, deduplicated); returns them as stored. Throws for a
   * session not recorded, a tag outside `TAG_PATTERN`, or more than `TAGS_PER_SESSION` tags.
   */
  setTags(sessionId: string, tags: readonly string[]): string[] {
    if (!this.has(sessionId)) throw new Error('unknown session')
    const wanted = [...new Set(tags.map(normalizeTag))]
    const bad = wanted.find((t) => !TAG_PATTERN.test(t))
    if (bad !== undefined) throw new Error(`invalid tag "${bad.slice(0, TAG_MAX_LENGTH)}"`)
    if (wanted.length > TAGS_PER_SESSION) throw new Error(`at most ${TAGS_PER_SESSION} tags`)
    const at = this.now()
    this.db.transaction(() => {
      const keep = new Set(wanted)
      for (const old of this.tags(sessionId)) if (!keep.has(old)) this.db.raw.prepare('DELETE FROM session_tags WHERE session_id = ? AND tag = ?').run(sessionId, old)
      const insert = this.db.raw.prepare('INSERT OR IGNORE INTO session_tags (session_id, tag, at) VALUES (?, ?, ?)')
      for (const tag of wanted) insert.run(sessionId, tag, at)
    })
    return this.tags(sessionId)
  }

  /** Every tag in use, most used first. */
  allTags(): { tag: string; sessions: number }[] {
    return (this.db.raw.prepare('SELECT tag, COUNT(*) AS n FROM session_tags GROUP BY tag ORDER BY n DESC, tag').all() as { tag: string; n: number }[]).map((r) => ({ tag: r.tag, sessions: Number(r.n) }))
  }
}

/** Every automation run, without the cap the automations state has. */
export class AutomationRunLog {
  /** What was last written per run id, so an unchanged run is not written again. */
  private readonly written = new Map<string, string>()

  constructor(private readonly db: WorkhubDb) {}

  /** Writes the runs that are new or changed (a run's usage settles after it ends); `profileOf` names its automation's profile. */
  record(runs: readonly AutomationRun[], profileOf: (automationId: string) => string | null = () => null): number {
    const changed: { run: AutomationRun; summary: string; signature: string }[] = []
    for (const run of runs) {
      const summary = JSON.stringify(summaryOf(run))
      const signature = `${summary}|${run.startedAt ?? ''}|${run.endedAt ?? ''}|${run.outcome}|${run.session ?? ''}`
      if (this.written.get(run.id) !== signature) changed.push({ run, summary, signature })
    }
    if (!changed.length) return 0
    this.db.transaction(() => {
      const upsert = this.db.raw.prepare(
        `INSERT INTO automation_runs (id, automation_id, profile_id, trigger, started_at, ended_at, status, session_id, summary_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET profile_id = COALESCE(excluded.profile_id, automation_runs.profile_id), started_at = excluded.started_at, ended_at = excluded.ended_at,
           status = excluded.status, session_id = excluded.session_id, summary_json = excluded.summary_json`
      )
      for (const { run, summary } of changed) upsert.run(run.id, run.automationId, profileOf(run.automationId), run.trigger, run.startedAt ?? run.queuedAt, run.endedAt ?? null, run.outcome, run.session ?? null, summary)
    })
    for (const c of changed) this.written.set(c.run.id, c.signature)
    return changed.length
  }

  /**
   * Runs newest first (by start, then id), `limit` of them; only the given automations when
   * `automationIds` is set. Paging: `cursor` (the last run's start and id, see `runCursor`) goes on
   * exactly after it, ties included; `before` (epoch ms) keeps the runs started earlier.
   */
  list(query: { automationIds?: readonly string[]; limit: number; before?: number; cursor?: { startedAt: number; id: string } }): AutomationRun[] {
    const where: string[] = []
    const params: (string | number)[] = []
    if (query.before !== undefined) {
      where.push('started_at < ?')
      params.push(query.before)
    }
    if (query.cursor) {
      where.push('(started_at < ? OR (started_at = ? AND id < ?))')
      params.push(query.cursor.startedAt, query.cursor.startedAt, query.cursor.id)
    }
    if (query.automationIds) {
      if (!query.automationIds.length) return []
      where.push(`automation_id IN (${query.automationIds.map(() => '?').join(', ')})`)
      params.push(...query.automationIds)
    }
    params.push(Math.max(1, Math.floor(query.limit)))
    const rows = this.db.raw
      .prepare(`SELECT id, automation_id, trigger, started_at, ended_at, status, session_id, summary_json FROM automation_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, id DESC LIMIT ?`)
      .all(...params) as { id: string; automation_id: string; trigger: string; started_at: number; ended_at: number | null; status: string; session_id: string | null; summary_json: string }[]
    return rows.map((r) => {
      let s: Partial<ReturnType<typeof summaryOf>> = {}
      try {
        s = JSON.parse(r.summary_json) as ReturnType<typeof summaryOf>
      } catch {
        // A summary that does not parse leaves the run with its columns only.
      }
      const run: AutomationRun = {
        id: r.id,
        automationId: r.automation_id,
        automationName: s.automationName ?? '',
        trigger: r.trigger as AutomationRun['trigger'],
        queuedAt: s.queuedAt ?? Number(r.started_at),
        outcome: r.status as AutomationRun['outcome'],
        merged: s.merged ?? 0
      }
      if (s.startedAt !== undefined) run.startedAt = s.startedAt
      if (r.ended_at !== null) run.endedAt = Number(r.ended_at)
      if (r.session_id) run.session = r.session_id
      if (s.detail) run.detail = s.detail
      if (s.triggerLink) run.triggerLink = s.triggerLink
      if (s.cost) run.cost = s.cost
      if (s.tokens !== undefined) run.tokens = s.tokens
      return run
    })
  }
}

/** The opaque cursor of a run (its start and id), for `list({ cursor })`. */
export function runCursor(r: Pick<AutomationRun, 'id' | 'queuedAt' | 'startedAt'>): string {
  return Buffer.from(JSON.stringify([r.startedAt ?? r.queuedAt, r.id])).toString('base64url')
}

/** A cursor `runCursor` made; null when the text is not one. */
export function parseRunCursor(text: string): { startedAt: number; id: string } | null {
  try {
    const v = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as unknown
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && Number.isFinite(v[0]) && typeof v[1] === 'string') return { startedAt: v[0], id: v[1] }
  } catch {
    // Not a cursor.
  }
  return null
}

function summaryOf(r: AutomationRun) {
  return {
    automationName: r.automationName,
    queuedAt: r.queuedAt,
    ...(r.startedAt !== undefined ? { startedAt: r.startedAt } : {}),
    merged: r.merged,
    ...(r.detail ? { detail: r.detail } : {}),
    ...(r.triggerLink ? { triggerLink: r.triggerLink } : {}),
    ...(r.cost ? { cost: r.cost } : {}),
    ...(r.tokens !== undefined ? { tokens: r.tokens } : {})
  }
}

/** A timeline event: what the pull request sync detects, plus `opened` (first seen) and `reviewed` (left the review queue). */
export type TimelinePrEvent = Omit<PrEvent, 'kind'> & { kind: PrEvent['kind'] | 'opened' | 'reviewed' }

/** Two ticket status changes alike this close together are one (a restart before the watcher memory was written). */
export const TICKET_REPEAT_WINDOW_MS = 10 * 60_000

/** `owner/repo` and the number of a pull request event (its id starts with `owner/repo#12|`). */
export function prOfEvent(e: Pick<PrEvent, 'id' | 'name' | 'url'>): { repo: string; number: number | null } {
  const slug = /^([^|#]+)#(\d+)\|/.exec(e.id)
  if (slug) return { repo: slug[1]!, number: Number(slug[2]) }
  const name = /^(.+)#(\d+)$/.exec(e.name)
  return name ? { repo: name[1]!, number: Number(name[2]) } : { repo: e.url, number: null }
}

/** The pull request and ticket timelines. */
export class Timelines {
  constructor(private readonly db: WorkhubDb) {}

  /** Appends the events a sync detected; one already stored (same profile and event id) is left as is. Returns how many were new. */
  appendPrEvents(profileId: string, events: readonly TimelinePrEvent[]): number {
    if (!events.length) return 0
    return this.db.transaction(() => {
      const insert = this.db.raw.prepare('INSERT OR IGNORE INTO pr_events (id, profile_id, repo, number, url, kind, at, actor, title, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      let added = 0
      for (const e of events) {
        const { repo, number } = prOfEvent(e)
        added += Number(insert.run(`${profileId}|${e.id}`, profileId, repo, number, e.url, e.kind, e.at, e.actor ?? null, e.title || null, JSON.stringify(e)).changes)
      }
      return added
    })
  }

  /**
   * Appends the changes the ticket watcher saw at `at`. The same change (profile, ticket, kind,
   * from, to) within `TICKET_REPEAT_WINDOW_MS` of one stored is the same event, seen again after a
   * restart that lost the watcher's memory: it is stored once. Returns how many were new.
   */
  appendTicketChanges(profileId: string, changes: readonly TicketChange[], at: number): number {
    if (!changes.length) return 0
    return this.db.transaction(() => {
      const insert = this.db.raw.prepare('INSERT OR IGNORE INTO ticket_events (profile_id, key, kind, at, from_value, to_value, title, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      const seen = this.db.raw.prepare('SELECT 1 FROM ticket_events WHERE profile_id = ? AND key = ? AND kind = ? AND from_value IS ? AND to_value IS ? AND at BETWEEN ? AND ? LIMIT 1')
      let added = 0
      for (const c of changes) {
        const from = c.kind === 'status' ? c.from : null
        const to = c.kind === 'status' ? c.to : c.kind === 'assigned' ? c.status : null
        if (seen.get(profileId, c.key, c.kind, from, to, at - TICKET_REPEAT_WINDOW_MS, at + TICKET_REPEAT_WINDOW_MS)) continue
        added += Number(insert.run(profileId, c.key, c.kind, at, from, to, c.title, JSON.stringify(c)).changes)
      }
      return added
    })
  }

  /** A pull request's events, oldest first. */
  prTimeline(repo: string, number: number): { kind: string; at: number; actor?: string; title?: string }[] {
    return (this.db.raw.prepare('SELECT kind, at, actor, title FROM pr_events WHERE repo = ? AND number = ? ORDER BY at, id').all(repo.toLowerCase(), number) as { kind: string; at: number; actor: string | null; title: string | null }[]).map((r) => ({
      kind: r.kind,
      at: Number(r.at),
      ...(r.actor ? { actor: r.actor } : {}),
      ...(r.title ? { title: r.title } : {})
    }))
  }

  /** A ticket's changes, oldest first. */
  ticketTimeline(key: string): { kind: string; at: number; from?: string; to?: string; title?: string }[] {
    return (this.db.raw.prepare('SELECT kind, at, from_value, to_value, title FROM ticket_events WHERE key = ? ORDER BY at, id').all(key) as { kind: string; at: number; from_value: string | null; to_value: string | null; title: string | null }[]).map((r) => ({
      kind: r.kind,
      at: Number(r.at),
      ...(r.from_value ? { from: r.from_value } : {}),
      ...(r.to_value ? { to: r.to_value } : {}),
      ...(r.title ? { title: r.title } : {})
    }))
  }
}
