// Changes agents made to Workhub's own objects through the control endpoint, waiting for the user to
// keep or revert them: types of the preload bridge (window.hub.agentChanges). Never offered to
// paired devices or to agents.

/** What an agent changed: an automation, a flow map (and its alert limits), a milestone or an inbox item. */
export type AgentChangeKind = 'automation' | 'flowMap' | 'milestone' | 'inboxItem'

export interface AgentChange {
  id: string
  at: number
  /** The session whose agent made it: its name and its agent's name when it was still open. */
  session?: { id: string; name?: string; agent?: string }
  profileId?: string | null
  kind: AgentChangeKind
  action: 'create' | 'update' | 'delete'
  object: { id: string; name: string }
  /** The fields that changed, in order. */
  fields: string[]
  /** The fields' values before and after; a field missing on one side was not set there. */
  before: Record<string, unknown>
  after: Record<string, unknown>
  /** Fields whose value was too long or looked like a secret: shown shortened, never restored. */
  cut?: string[]
  /** Fields saved but not in effect until the user keeps the change (a flow map's alert limits). */
  held?: string[]
  /** A digest of the changed fields right after the change: a revert checks nothing changed them since. */
  check: string
  reviewed?: { at: number; outcome: 'kept' | 'reverted' }
}

/**
 * What keeping or reverting did. Failures: `gone` (the entry or the object is gone), `changed`
 * (the object changed again since), `cut` (a value was too long to keep in the journal), `failed`
 * (the service refused; `detail` says why).
 */
export type AgentChangeAnswer = { ok: true } | { ok: false; error: 'gone' | 'changed' | 'cut' | 'failed'; detail?: string }

export interface AgentChangesApi {
  /** The changes not reviewed yet, newest first. */
  list(): Promise<AgentChange[]>
  /** Marks a change as reviewed; held fields (a flow map's limits) take effect now. */
  keep(id: string): Promise<AgentChangeAnswer>
  /** Puts the "before" values back through the service the UI uses, then marks the change as reviewed. */
  revert(id: string): Promise<AgentChangeAnswer>
  onChanged(cb: (changes: AgentChange[]) => void): () => void
  /** Opens the window that lists the changes, or brings the open one to the front. */
  openWindow(): void
}
