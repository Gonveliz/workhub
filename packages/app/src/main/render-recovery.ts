import type { WebContents } from 'electron'
import type { Logger } from './log-file'

/** A window that keeps crashing is left alone after this many reloads in `RELOAD_WINDOW_MS`. */
export const MAX_RELOADS = 3
export const RELOAD_WINDOW_MS = 60_000

/** Reasons that mean the process ended on purpose: reloading would fight the user or the OS. */
const NO_RELOAD_REASONS = new Set(['clean-exit', 'killed'])

export function shouldReload(reason: string): boolean {
  return !NO_RELOAD_REASONS.has(reason)
}

/** Lets a window reload at most `MAX_RELOADS` times per minute, so a crash on load does not loop. */
export class ReloadGuard {
  private readonly reloads = new Map<number, number[]>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Whether window `id` may reload now; counts the reload when it may. */
  allow(id: number): boolean {
    const now = this.now()
    const recent = (this.reloads.get(id) ?? []).filter((t) => now - t < RELOAD_WINDOW_MS)
    const ok = recent.length < MAX_RELOADS
    if (ok) recent.push(now)
    this.reloads.set(id, recent)
    return ok
  }

  forget(id: number): void {
    this.reloads.delete(id)
  }
}

/**
 * Logs a window's renderer process dying or hanging and reloads the window. Sessions live in the
 * main process, so the reloaded window gets them back from its start-up list; the agents never stop.
 */
export function watchRenderer(contents: WebContents, log: Logger, guard: ReloadGuard): void {
  if (contents.getType() !== 'window') return
  const id = contents.id
  contents.on('render-process-gone', (_event, details) => {
    const reload = shouldReload(details.reason)
    const allowed = reload && guard.allow(id)
    log.error(`window ${id} renderer gone reason=${details.reason} exitCode=${details.exitCode}${reload ? (allowed ? ' reloading' : ' not reloading: too many reloads in a minute') : ''}`)
    if (allowed && !contents.isDestroyed()) contents.reload()
  })
  contents.on('unresponsive', () => log.warn(`window ${id} renderer is unresponsive`))
  contents.on('responsive', () => log.info(`window ${id} renderer is responsive again`))
  contents.once('destroyed', () => guard.forget(id))
}
