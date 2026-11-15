/**
 * Records what the usage reports need from the sessions Workhub runs: each session (agent family,
 * account, profile, folder, title, when it stopped) and what it is related to as its monitor finds
 * it (pull requests, tickets, branches) or Workhub made for it (a worktree). The work folder,
 * project and model come from the transcript scan, which owns them. Writes only what changed, on
 * the main process; a failed write is logged and dropped, never thrown at the session.
 */
import { canonicalUrl, sessionIdentity, type AgentEvent, type SessionMonitorSnapshot } from '@workhub/core'
import type { SessionLink, SessionRecords } from '@workhub/adapters/sqlite-store'
import type { SessionView } from '../shared/api'

export interface AnalyticsRecorderDeps {
  records: Pick<SessionRecords, 'upsertSession' | 'addLinks' | 'rekey'>
  /** The spend agent family of a session (`spendAgentId`), as the transcript scan records it; its agent id by default. */
  agentOf?: (view: SessionView) => string
  log?: (message: string) => void
  now?: () => number
}

/** The pull requests, tickets and branches a monitor snapshot names (it may hold only some fields: they add up). */
export function linksOfSnapshot(s: Pick<SessionMonitorSnapshot, 'pullRequestLinks' | 'pullRequests' | 'ticketKeys' | 'replyTicketKeys' | 'linkedTicketKeys' | 'branches'>): SessionLink[] {
  const out: SessionLink[] = []
  if (s.pullRequestLinks) {
    for (const l of s.pullRequestLinks) if (l.url) out.push({ kind: 'pr', ref: canonicalUrl(l.url), source: l.source })
  } else {
    for (const url of s.pullRequests ?? []) out.push({ kind: 'pr', ref: canonicalUrl(url), source: 'reply' })
  }
  for (const key of s.ticketKeys ?? []) out.push({ kind: 'ticket', ref: key.toUpperCase(), source: 'user' })
  for (const key of s.replyTicketKeys ?? []) out.push({ kind: 'ticket', ref: key.toUpperCase(), source: 'reply' })
  for (const key of s.linkedTicketKeys ?? []) out.push({ kind: 'ticket', ref: key.toUpperCase(), source: 'tracker' })
  for (const b of s.branches ?? []) if (b.name) out.push({ kind: 'branch', ref: b.name, source: 'git' })
  return out
}

/** The id a session is recorded under: the agent's session id once known, Workhub's identity until then (moved over later). */
function recordId(v: SessionView): string | null {
  return v.readOnly ? null : (v.agentSessionId ?? sessionIdentity(v))
}

const linkKey = (id: string, l: SessionLink) => `${id}\u0000${l.kind}\u0000${l.ref}`

export class AnalyticsRecorder {
  /** What was last written per record id, so an unchanged session is not written again. */
  private readonly written = new Map<string, string>()
  private readonly linked = new Set<string>()
  /** The model each live session last reported, by Workhub id. */
  private readonly models = new Map<string, string>()
  /** Each live session as last changed, by Workhub id (monitor events name only the id). */
  private readonly views = new Map<string, SessionView>()
  /** The id each live session is recorded under, by Workhub id. */
  private readonly ids = new Map<string, string>()

  constructor(private readonly deps: AnalyticsRecorderDeps) {}

  private guard(what: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.deps.log?.(`analytics: ${what} not recorded: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** The record id of a session now; moves what was recorded under an earlier one (before the agent's id was known). */
  private idOf(v: SessionView): string | null {
    const id = recordId(v)
    if (!id) return null
    const before = this.ids.get(v.id)
    if (before && before !== id) {
      this.guard('re-key', () => this.deps.records.rekey(before, id))
      this.forget(before)
    }
    this.ids.set(v.id, id)
    return id
  }

  private forget(recordedAs: string): void {
    this.written.delete(recordedAs)
    const prefix = `${recordedAs}\u0000`
    for (const k of this.linked) if (k.startsWith(prefix)) this.linked.delete(k)
  }

  /** A session changed: its row, and its worktree as a link. */
  sessionChanged(v: SessionView): void {
    this.views.set(v.id, v)
    const id = this.idOf(v)
    if (!id) return
    const stopped = v.state === 'stopped' || v.state === 'error'
    const title = v.name ?? v.agentTitle ?? null
    const model = this.models.get(v.id) ?? v.currentModelId ?? null
    const agent = this.deps.agentOf?.(v) ?? v.agentId
    const signature = JSON.stringify([agent, v.accountId, v.profileId, v.cwd, title, v.startedAt, stopped, model])
    if (this.written.get(id) !== signature) {
      this.guard('session', () => {
        // The first stop time is kept (a rename after it changes nothing); running again clears it.
        this.deps.records.upsertSession({ id, agent, accountId: v.accountId, profileId: v.profileId, cwd: v.cwd, title, startedAt: v.startedAt, endedAt: stopped ? (this.deps.now ?? Date.now)() : null, model })
        this.written.set(id, signature)
      })
    }
    if (v.worktree) {
      this.addLinks(id, [
        { kind: 'worktree', ref: v.worktree.path, source: 'workhub' },
        { kind: 'branch', ref: v.worktree.branch, source: 'workhub' }
      ])
    }
  }

  /** A session's event: its monitor's links and model. */
  onEvent(e: AgentEvent): void {
    if (e.type !== 'monitor') return
    const v = this.views.get(e.sessionId)
    if (!v) return
    if (e.snapshot.model && this.models.get(v.id) !== e.snapshot.model) {
      this.models.set(v.id, e.snapshot.model)
      this.sessionChanged(v)
    }
    const id = this.idOf(v)
    if (id) this.addLinks(id, linksOfSnapshot(e.snapshot))
  }

  /** A session left the list: forget what is kept for it in memory. */
  sessionRemoved(sessionId: string): void {
    const id = this.ids.get(sessionId)
    if (id) this.forget(id)
    this.ids.delete(sessionId)
    this.models.delete(sessionId)
    this.views.delete(sessionId)
  }

  private addLinks(id: string, links: SessionLink[]): void {
    const fresh = links.filter((l) => l.ref && !this.linked.has(linkKey(id, l)))
    if (!fresh.length) return
    this.guard('links', () => {
      this.deps.records.addLinks(id, fresh)
      for (const l of fresh) this.linked.add(linkKey(id, l))
    })
  }
}
