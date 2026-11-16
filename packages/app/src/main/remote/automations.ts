// What a paired device sees of the automations: a short row each (no prompt, folder or agent), and
// the three actions it may take. Turning one ON is not among them: an agent can add or edit an
// automation (always saved off, see automation-control.ts), and only the person at the desktop
// reviews and turns it on.
import type { RemoteAutomation } from '../../shared/remote-api'
import type { AutomationsSnapshot } from '../../shared/chat-api'

/** Characters of an automation's name a device gets. */
const NAME_MAX = 200
/** The same id shape the local control endpoint accepts for an automation. */
const AUTOMATION_ID = /^[\w.:-]{1,200}$/

/** The id of an automation a device named, or null when it is not one. */
export function readAutomationId(value: unknown): string | null {
  return typeof value === 'string' && AUTOMATION_ID.test(value) ? value : null
}

/** The snapshot as rows, in the order the desktop lists them. */
export function remoteAutomations(snapshot: AutomationsSnapshot | null | undefined, now = Date.now()): RemoteAutomation[] {
  const automations = Array.isArray(snapshot?.automations) ? snapshot.automations : []
  const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : []
  return automations.map((s) => {
    const a = s.definition
    // Runs come newest first.
    const run = runs.find((r) => r.automationId === a.id)
    const next = s.health === 'off' ? undefined : [s.nextIntervalAt, s.waitUntil, s.pausedUntil].find((t) => typeof t === 'number' && t > now)
    return {
      id: a.id,
      name: String(a.name ?? '').slice(0, NAME_MAX),
      enabled: a.enabled === true,
      active: s.active === true,
      health: s.health,
      ...(run ? { lastRun: { at: run.endedAt ?? run.startedAt ?? run.queuedAt, outcome: run.outcome } } : {}),
      ...(next !== undefined ? { nextRunAt: next } : {})
    }
  })
}
