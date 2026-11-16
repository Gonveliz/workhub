/**
 * The stuck-session watchdog's timing. A session that is working, waits on nobody and has sent no
 * event for `thresholdMs` is flagged; it is never stopped from here (the user picks Stop or Keep
 * waiting in the session's header). Pure: the caller passes the clock, so tests fake it.
 */

/** What the watch needs to know about a session at one check. */
export interface StallInput {
  id: string
  /** A turn is running (`busy`). Starting sessions have their own start deadline in the runtime. */
  working: boolean
  /** An open permission request or question, or the console asking: the turn waits on the user, not on the agent. */
  waitingOnUser: boolean
}

export interface StallCheck {
  /** Sessions that crossed the threshold at this check, with when their agent was last heard from. */
  flag: { id: string; since: number }[]
}

export class StallWatch {
  /** When each session's agent last sent an event (or when it last started being watched). */
  private readonly last = new Map<string, number>()
  private readonly flagged = new Set<string>()

  /** The agent sent something: the silence starts over. */
  note(id: string, now: number): void {
    this.last.set(id, now)
    this.flagged.delete(id)
  }

  /** "Keep waiting": the silence starts over, and the next notice comes a full threshold later. */
  keepWaiting(id: string, now: number): void {
    this.note(id, now)
  }

  /** The session is gone. */
  forget(id: string): void {
    this.last.delete(id)
    this.flagged.delete(id)
  }

  /**
   * Which sessions to flag now. A session that is not working, or waits on the user, is not
   * silent: its count restarts, so the time spent idle or waiting never adds up to a notice.
   * `thresholdMs <= 0` turns the watch off. A flagged session is not returned again until an
   * event or `keepWaiting` clears it.
   */
  check(sessions: readonly StallInput[], now: number, thresholdMs: number): StallCheck {
    const flag: StallCheck['flag'] = []
    const ids = new Set(sessions.map((s) => s.id))
    for (const id of [...this.last.keys()]) if (!ids.has(id)) this.forget(id)
    for (const s of sessions) {
      if (thresholdMs <= 0 || !s.working || s.waitingOnUser) {
        this.note(s.id, now)
        continue
      }
      const last = this.last.get(s.id)
      if (last === undefined) {
        this.last.set(s.id, now)
        continue
      }
      // A clock that went back (sleep, adjustment) counts as no silence at all.
      if (now < last) this.last.set(s.id, now)
      else if (now - last >= thresholdMs && !this.flagged.has(s.id)) {
        this.flagged.add(s.id)
        flag.push({ id: s.id, since: last })
      }
    }
    return { flag }
  }
}
