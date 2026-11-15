import type { StateStore } from '@workhub/core'
import type { WorkhubDb } from './db'

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * One row of `kv_state`: a JSON value read once at start and written at most every `delayMs`
 * (an unref'd timer, so it never keeps the process alive); `flush` writes what is pending now.
 * Large values saved often (token spend) depend on the debounce.
 */
export class KvState<T> implements StateStore<T> {
  private pending: { value: T } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly db: WorkhubDb,
    readonly key: string,
    private readonly delayMs = 500,
    private readonly log: (message: string) => void = (m) => console.warn(m)
  ) {}

  /** The stored object merged over `fallback`; `fallback` when nothing is stored or it is not an object. */
  load(fallback: T): T {
    if (this.pending) return mergeOver(fallback, this.pending.value)
    try {
      const row = this.db.raw.prepare('SELECT value FROM kv_state WHERE key = ?').get(this.key) as { value: string } | undefined
      if (!row) return fallback
      return mergeOver(fallback, JSON.parse(row.value) as unknown)
    } catch (err) {
      this.log(`could not read state ${this.key}: ${err instanceof Error ? err.message : String(err)}`)
      return fallback
    }
  }

  save(value: T): void {
    this.pending = { value }
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), this.delayMs)
    this.timer.unref?.()
  }

  /** Writes the pending value now. A failed write stays pending and is logged, never thrown. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.pending) return
    const { value } = this.pending
    if (!this.db.isOpen) {
      this.log(`state ${this.key} not written: the database is closed`)
      return
    }
    try {
      const text = JSON.stringify(value)
      this.db.transaction(() => {
        this.db.raw
          .prepare('INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
          .run(this.key, text, Date.now())
      })
      if (this.pending?.value === value) this.pending = null
    } catch (err) {
      this.log(`could not write state ${this.key}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

function mergeOver<T>(fallback: T, raw: unknown): T {
  return isPlainObject(raw) ? ({ ...fallback, ...(raw as Partial<T>) } as T) : fallback
}
