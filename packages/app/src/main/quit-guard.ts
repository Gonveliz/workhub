/**
 * The quit guard: quitting (or restarting for an update) while a session works, has prompts
 * waiting or an open permission request asks first, and can wait for the sessions to go idle.
 * The pure parts (what counts as busy, the quit-when-idle state machine) take the clock and the
 * counts as arguments; `QuitGuard` ties them to the dialog and the timer through injected deps.
 *
 * What main can count: sessions with a turn running (`busy`), prompts held in main behind the
 * running one (the send gate: `queued`) and open permission requests or questions. Prompts a
 * window keeps in its own composer queue are not visible here; they only exist while a turn
 * runs, so that session is counted as working, and the idle settle time below covers the gap
 * between a turn's end and the window sending the next queued prompt.
 */
import type { QuitIntent } from '../shared/quit-api'

export type { QuitIntent }

export interface BusyCounts {
  /** Sessions with a turn in progress. */
  working: number
  /** Prompts waiting in main for their turn. */
  queued: number
  /** Permission requests and questions nobody answered (a console that asks counts as one). */
  permissions: number
}

/** The part of a session view the guard reads. */
export interface BusyView {
  state: string
  pendingPermissions?: readonly unknown[]
  consoleAsking?: boolean
}

/** What counts as busy: a turn running, prompts queued, or a request open. Starting sessions lose nothing by stopping. */
export function busyCounts(views: readonly BusyView[], queuedPrompts: number): BusyCounts {
  let working = 0
  let permissions = 0
  for (const v of views) {
    if (v.state === 'busy') working += 1
    // A stopped or failed session's leftovers are gone with its process.
    if (v.state === 'busy' || v.state === 'ready') permissions += v.pendingPermissions?.length || (v.consoleAsking ? 1 : 0)
  }
  return { working, queued: Math.max(0, queuedPrompts), permissions }
}

export const isBusy = (c: BusyCounts): boolean => c.working > 0 || c.queued > 0 || c.permissions > 0

/** What `QuitWhenIdle.observe` tells the caller to do. */
export type IdleVerdict = 'none' | 'wait' | 'quit'

/**
 * "Quit when idle": armed, it waits until nothing is busy for `settleMs` in a row, then says
 * `quit` once. A new prompt (busy again) restarts the settle time, which is how it postpones the
 * quit; the settle time also covers a window handing its next queued prompt over after a turn.
 */
export class QuitWhenIdle {
  private armedFor: QuitIntent | null = null
  private idleSince: number | null = null

  constructor(private readonly settleMs: number) {}

  /** The quit being waited for, or null. */
  get pending(): QuitIntent | null {
    return this.armedFor
  }

  arm(intent: QuitIntent): void {
    this.armedFor = intent
    this.idleSince = null
  }

  cancel(): void {
    this.armedFor = null
    this.idleSince = null
  }

  observe(counts: BusyCounts, now: number): IdleVerdict {
    if (!this.armedFor) return 'none'
    if (isBusy(counts)) {
      this.idleSince = null
      return 'wait'
    }
    this.idleSince ??= now
    // A clock that went back restarts the settle time instead of waiting for the old one.
    if (now < this.idleSince) this.idleSince = now
    if (now - this.idleSince < this.settleMs) return 'wait'
    this.armedFor = null
    this.idleSince = null
    return 'quit'
  }
}

/** The user's answer to the dialog. */
export type QuitChoice = 'now' | 'whenIdle' | 'cancel'

export interface QuitGuardDeps {
  views: () => readonly BusyView[]
  queuedPrompts: () => number
  /** Asks the user; resolves with the choice (a closed dialog is `cancel`). */
  confirm: (counts: BusyCounts, intent: QuitIntent) => Promise<QuitChoice>
  /** The quit waiting for idle changed (or ended): tell the windows. */
  publish: (pending: QuitIntent | null) => void
  /** The quit was cancelled from the dialog: a window closed by the quit may need to come back. */
  cancelled?: () => void
  now?: () => number
  /** How often the idle wait looks at the sessions (tests drive `tick` themselves). */
  setTimer?: (tick: () => void, ms: number) => () => void
}

const TICK_MS = 1000
/** Idle must hold this long before a waiting quit goes ahead (a window's next queued prompt is on its way). */
export const IDLE_SETTLE_MS = 3000

export class QuitGuard {
  private enabled = true
  private shuttingDown = false
  /** A quit decided (confirmed, idle, guard off or OS shutdown): `before-quit` lets it through. */
  private proceeding = false
  private asking = false
  private readonly idle = new QuitWhenIdle(IDLE_SETTLE_MS)
  private action: (() => void) | null = null
  /** The windows were told a quit waits. */
  private shown = false
  private stopTimer: (() => void) | null = null

  constructor(private readonly deps: QuitGuardDeps) {}

  /** The "ask before quitting" preference. */
  setEnabled(on: boolean): void {
    this.enabled = on
  }

  /** The operating system is shutting down or the user session ends: nothing waits, nothing asks. */
  systemShutdown(): void {
    this.shuttingDown = true
    this.endWait()
  }

  get pending(): QuitIntent | null {
    return this.idle.pending
  }

  private counts(): BusyCounts {
    return busyCounts(this.deps.views(), this.deps.queuedPrompts())
  }

  private mustAsk(): boolean {
    return this.enabled && !this.shuttingDown && !this.proceeding && isBusy(this.counts())
  }

  /**
   * `before-quit`: true when the quit must be stopped (`event.preventDefault()`) because the user
   * is being asked or the app waits for idle; false lets it go on.
   */
  intercept(quit: () => void): boolean {
    if (!this.mustAsk()) return false
    void this.ask('quit', quit)
    return true
  }

  /** A quit that is not a plain `app.quit()` (restarting into an update): runs `action` now, or after the user's answer. */
  request(intent: QuitIntent, action: () => void): void {
    if (!this.mustAsk()) return this.go(action)
    void this.ask(intent, action)
  }

  /** Stops waiting for idle; the app stays open. */
  cancelPending(): void {
    this.endWait()
  }

  private go(action: () => void): void {
    this.proceeding = true
    this.endWait()
    action()
  }

  private async ask(intent: QuitIntent, action: () => void): Promise<void> {
    if (this.asking) return
    this.asking = true
    try {
      const choice = await this.deps.confirm(this.counts(), intent)
      if (choice === 'now') this.go(action)
      else if (choice === 'whenIdle') this.wait(intent, action)
      else this.deps.cancelled?.()
    } finally {
      this.asking = false
    }
  }

  private wait(intent: QuitIntent, action: () => void): void {
    this.action = action
    this.idle.arm(intent)
    this.shown = true
    this.deps.publish(intent)
    this.stopTimer?.()
    this.stopTimer = (this.deps.setTimer ?? defaultTimer)(() => this.tick(), TICK_MS)
  }

  /** One look at the sessions while waiting; public so tests drive it with a fake clock. */
  tick(): void {
    const verdict = this.idle.observe(this.counts(), (this.deps.now ?? Date.now)())
    if (verdict === 'quit' && this.action) this.go(this.action)
  }

  private endWait(): void {
    this.idle.cancel()
    this.action = null
    this.stopTimer?.()
    this.stopTimer = null
    if (this.shown) this.deps.publish(null)
    this.shown = false
  }
}

const defaultTimer = (tick: () => void, ms: number): (() => void) => {
  const id = setInterval(tick, ms)
  id.unref?.()
  return () => clearInterval(id)
}
