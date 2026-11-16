import { isInstallerId, type InstallerId } from '@workhub/core'
import type { ManagedProgress } from '@workhub/adapters/managed-tools'
import type { InstallItemView, InstallQueueSnapshot } from '../shared/setup-api'
import type { InstallOptions, InstallResult } from './setup-install'

export interface InstallQueueDeps {
  install: (installer: InstallerId, options: InstallOptions) => Promise<InstallResult>
  emit: (snapshot: InstallQueueSnapshot) => void
  /** After each install (PATH read again, so the next check finds what was installed). */
  afterEach?: () => Promise<void>
  /** Download progress is sent at most this often. */
  progressIntervalMs?: number
  now?: () => number
}

/**
 * Runs installs one after another, each with a progress line; one queue at a time. Cancel stops
 * the current one (its own cleanup leaves nothing half-installed) and the ones not started; a
 * failed or canceled line can be tried again on its own.
 */
export class InstallQueue {
  private items: InstallItemView[] = []
  private running = false
  private controller: AbortController | null = null
  private lastEmit = 0

  constructor(private readonly deps: InstallQueueDeps) {}

  snapshot(): InstallQueueSnapshot {
    return { running: this.running, items: this.items.map((i) => ({ ...i })) }
  }

  get busy(): boolean {
    return this.running
  }

  /** Starts the installs in this order (already ordered by `installQueue`); false while one runs. */
  start(ids: readonly unknown[]): Promise<InstallQueueSnapshot> | null {
    if (this.running) return null
    const valid = [...new Set(ids.filter(isInstallerId))]
    if (valid.length === 0) return null
    this.items = valid.map((installer) => ({ installer, state: 'pending' }))
    return this.drain()
  }

  /** Runs one failed or canceled line again. */
  retry(id: unknown): Promise<InstallQueueSnapshot> | null {
    if (this.running) return null
    const item = this.items.find((i) => i.installer === id)
    if (!item || (item.state !== 'failed' && item.state !== 'canceled')) return null
    this.reset(item)
    return this.drain()
  }

  cancel(): void {
    if (!this.running) return
    for (const item of this.items) if (item.state === 'pending') item.state = 'canceled'
    this.controller?.abort()
    this.emit(true)
  }

  private reset(item: InstallItemView): void {
    item.state = 'pending'
    delete item.reason
    delete item.detail
    delete item.received
    delete item.total
  }

  private emit(force = false): void {
    const now = (this.deps.now ?? Date.now)()
    if (!force && now - this.lastEmit < (this.deps.progressIntervalMs ?? 250)) return
    this.lastEmit = now
    this.deps.emit(this.snapshot())
  }

  private async drain(): Promise<InstallQueueSnapshot> {
    this.running = true
    this.emit(true)
    try {
      for (const item of this.items) {
        if (item.state !== 'pending') continue
        const controller = new AbortController()
        this.controller = controller
        item.state = 'installing'
        this.emit(true)
        const onProgress = (p: ManagedProgress) => {
          const changed = item.state !== p.phase
          item.state = p.phase
          if (p.received !== undefined) item.received = p.received
          if (p.total !== undefined) item.total = p.total
          this.emit(changed)
        }
        let result: InstallResult
        try {
          result = await this.deps.install(item.installer, { signal: controller.signal, onProgress })
        } catch (err) {
          result = { ok: false, output: err instanceof Error ? err.message : String(err) }
        }
        if (controller.signal.aborted || result.reason === 'canceled') item.state = 'canceled'
        else if (result.ok) item.state = 'done'
        else {
          item.state = 'failed'
          item.reason = result.reason ?? 'failed'
          if (result.output) item.detail = result.output
        }
        await this.deps.afterEach?.().catch(() => undefined)
        this.emit(true)
      }
    } finally {
      this.running = false
      this.controller = null
      this.emit(true)
    }
    return this.snapshot()
  }
}
