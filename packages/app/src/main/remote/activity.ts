// A session's sub-agents and background tasks as a paired device reads them (`remote:activity`).
// The device sees them live in `session:event` monitor updates, but those only come when something
// changes: a phone that connects while a sub-agent runs, or while a command waits in the
// background, would show nothing until then. Main keeps the latest of each per session here.
import type { AgentEvent, BackgroundTaskSummary, SubagentSummary } from '@workhub/core'
import type { RemoteSessionActivity } from '../../shared/remote-api'

/** The newest sub-agents and background tasks a device gets, and how much of each text. */
const SUBAGENTS_MAX = 100
const TASKS_MAX = 50
const TEXT_MAX = 300

const cut = (text: string | undefined): string | undefined => (text === undefined ? undefined : text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text)

/** What the phone draws for a sub-agent: its name, state and last step. Not its model, tokens or cost. */
export function remoteSubagentSummary(s: SubagentSummary): SubagentSummary {
  const out: SubagentSummary = { id: s.id }
  if (s.name !== undefined) out.name = cut(s.name)
  if (s.status !== undefined) out.status = s.status
  if (s.type !== undefined) out.type = cut(s.type)
  if (s.description !== undefined) out.description = cut(s.description)
  if (s.toolUseId !== undefined) out.toolUseId = s.toolUseId
  if (s.lastStep !== undefined) out.lastStep = cut(s.lastStep)
  if (s.stepCount !== undefined) out.stepCount = s.stepCount
  if (s.startedAt !== undefined) out.startedAt = s.startedAt
  if (s.lastActivityAt !== undefined) out.lastActivityAt = s.lastActivityAt
  return out
}

export function remoteBackgroundTask(t: BackgroundTaskSummary): BackgroundTaskSummary {
  return { id: t.id, kind: t.kind, description: cut(t.description) ?? '', since: t.since }
}

const EMPTY: RemoteSessionActivity = { subagents: [], backgroundTasks: [] }

export class RemoteActivityLog {
  private readonly bySession = new Map<string, RemoteSessionActivity>()

  /** Every event main sends its windows; only monitor updates that name sub-agents or tasks count. */
  onEvent(e: AgentEvent): void {
    if (e.type !== 'monitor') return
    const { subagents, backgroundTasks } = e.snapshot
    if (subagents === undefined && backgroundTasks === undefined) return
    const prev = this.bySession.get(e.sessionId) ?? EMPTY
    this.bySession.set(e.sessionId, {
      subagents: subagents ? subagents.slice(-SUBAGENTS_MAX).map(remoteSubagentSummary) : prev.subagents,
      backgroundTasks: backgroundTasks ? backgroundTasks.slice(0, TASKS_MAX).map(remoteBackgroundTask) : prev.backgroundTasks
    })
  }

  forget(sessionId: string): void {
    this.bySession.delete(sessionId)
  }

  of(sessionId: string): RemoteSessionActivity {
    return this.bySession.get(sessionId) ?? EMPTY
  }
}

/** Session ids one `remote:activity` call may name. */
export const ACTIVITY_IDS_MAX = 500

/**
 * `remote:activity`: one session's activity (refused unless it is open), or with a list of ids
 * (Home, after a reconnect) the activity of each one still open, by id; closed ones are left out.
 */
export function readActivity(log: RemoteActivityLog, openIds: () => readonly string[], ids: unknown): RemoteSessionActivity | Record<string, RemoteSessionActivity> {
  const open = new Set(openIds())
  if (Array.isArray(ids)) {
    if (ids.length > ACTIVITY_IDS_MAX || !ids.every((id) => typeof id === 'string')) throw new Error('the session ids are not valid')
    const out: Record<string, RemoteSessionActivity> = {}
    for (const id of ids as string[]) if (open.has(id)) out[id] = log.of(id)
    return out
  }
  if (typeof ids !== 'string') throw new Error('a session is required')
  if (!open.has(ids)) throw new Error('the session is not open')
  return log.of(ids)
}
