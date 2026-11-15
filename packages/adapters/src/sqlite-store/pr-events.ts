import type { PrEventState, PrEventStore } from '@workhub/core'
import { readPrEventState } from '../pr-events-json'
import type { WorkhubDb } from './db'

export const PR_EVENTS_KEY = 'pr-events'

/**
 * The pull request sync memory in `kv_state` (key `pr-events`). Nothing stored, or a value of an
 * unknown version, loads as an empty memory, which makes the next sync a seeding one.
 */
export class SqlitePrEventStore implements PrEventStore {
  constructor(private readonly db: WorkhubDb) {}

  async load(): Promise<PrEventState> {
    let raw: unknown = null
    try {
      const row = this.db.raw.prepare('SELECT value FROM kv_state WHERE key = ?').get(PR_EVENTS_KEY) as { value: string } | undefined
      raw = row ? (JSON.parse(row.value) as unknown) : null
    } catch {
      raw = null
    }
    return readPrEventState(raw)
  }

  async save(state: PrEventState): Promise<void> {
    this.db.write('pull request memory', () =>
      this.db.raw
        .prepare('INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .run(PR_EVENTS_KEY, JSON.stringify(state), Date.now())
    )
  }
}
