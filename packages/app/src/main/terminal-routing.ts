import type { AgentEvent } from '@workhub/core'

/** The session a terminal channel (`<session>:console`, `<session>:shell`) belongs to; null for any other event. */
export function terminalSessionOf(e: AgentEvent): string | null {
  const at = e.sessionId.indexOf(':')
  return at > 0 ? e.sessionId.slice(0, at) : null
}

export interface SessionEventTargets {
  /** Every receiver of `session:event`: the main window, every session and sub-agent window, paired devices. */
  everywhere: (e: AgentEvent) => void
  /** The main window. */
  main: (e: AgentEvent) => void
  /** The session's own window, when it has one. */
  sessionWindow: (sessionId: string, e: AgentEvent) => void
  /** Paired devices (they pick what they may see). */
  devices: (e: AgentEvent) => void
}

/**
 * Sends a session event. The events of a terminal channel (its output, flushed by the coalescer, and
 * its exit) go only where the session's terminals can be shown: the main window and the session's
 * own window. The main window gets them even while the session is in a window of its own, because
 * it keeps every terminal's scrollback: a session window seeds its terminals from it when it opens,
 * and the main window shows them again when the session is moved back. Other session windows and
 * sub-agent windows show no other session's terminals and no longer get their output.
 */
export function routeSessionEvent(e: AgentEvent, to: SessionEventTargets): void {
  const session = terminalSessionOf(e)
  if (session === null) return to.everywhere(e)
  to.main(e)
  to.sessionWindow(session, e)
  to.devices(e)
}
