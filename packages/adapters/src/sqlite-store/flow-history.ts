import type { FlowHour, FlowMeasureHistory } from '@workhub/core'
import type { WorkhubDb } from './db'

/** How long hourly flow-map aggregates are kept (the screens read a week; the rest is for later analysis). */
export const FLOW_HISTORY_DAYS = 90
const DAY_MS = 86_400_000

/**
 * The flow-map history tables: per measure what is final and when it was last read
 * (`flow_history_measures`), and its hours (`flow_history_hours`). Only the hours that changed
 * are written; hours older than `FLOW_HISTORY_DAYS` go on `prune`.
 */
export class SqliteFlowHistory {
  constructor(
    private readonly db: WorkhubDb,
    private readonly now: () => number = Date.now
  ) {}

  /** A measure with its hours from `since` on, oldest first; undefined when it was never stored. */
  read(scope: string, measure: string, since: number): FlowMeasureHistory | undefined {
    const head = this.db.raw.prepare('SELECT settled_until, fetched_at FROM flow_history_measures WHERE scope = ? AND measure = ?').get(scope, measure) as { settled_until: number; fetched_at: number } | undefined
    if (!head) return undefined
    const rows = this.db.raw.prepare('SELECT json FROM flow_history_hours WHERE scope = ? AND measure = ? AND hour_at >= ? ORDER BY hour_at').all(scope, measure, since) as { json: string }[]
    const hours: FlowHour[] = []
    for (const r of rows) {
      try {
        hours.push(JSON.parse(r.json) as FlowHour)
      } catch {
        // A row that does not parse is left out; the next read of that hour replaces it.
      }
    }
    return { hours, settledUntil: Number(head.settled_until), fetchedAt: Number(head.fetched_at) }
  }

  /**
   * Stores a measure: its head, the hours of `history` that differ from `previous`, and removes the
   * stored hours from `since` on that `history` no longer has. Hours before `since` are kept.
   */
  write(scope: string, measure: string, history: FlowMeasureHistory, previous: FlowMeasureHistory | undefined, since: number): void {
    const before = new Map((previous?.hours ?? []).map((h) => [h.at, JSON.stringify(h)]))
    const keep = new Set(history.hours.map((h) => h.at))
    this.db.write(`flow history ${measure}`, () => this.db.transaction(() => {
      this.db.raw
        .prepare('INSERT INTO flow_history_measures (scope, measure, settled_until, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope, measure) DO UPDATE SET settled_until = excluded.settled_until, fetched_at = excluded.fetched_at')
        .run(scope, measure, history.settledUntil, history.fetchedAt)
      const upsert = this.db.raw.prepare('INSERT INTO flow_history_hours (scope, measure, hour_at, json, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope, measure, hour_at) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at')
      for (const h of history.hours) {
        const json = JSON.stringify(h)
        if (before.get(h.at) !== json) upsert.run(scope, measure, h.at, json, history.fetchedAt)
      }
      const remove = this.db.raw.prepare('DELETE FROM flow_history_hours WHERE scope = ? AND measure = ? AND hour_at = ?')
      for (const at of before.keys()) if (at >= since && !keep.has(at)) remove.run(scope, measure, at)
    }))
  }

  /** Deletes hours older than the retention, and measures not read in that long; returns the rows removed. */
  prune(days = FLOW_HISTORY_DAYS): number {
    const cutoff = this.now() - days * DAY_MS
    return this.db.transaction(() => {
      const hours = Number(this.db.raw.prepare('DELETE FROM flow_history_hours WHERE hour_at < ?').run(cutoff).changes)
      const stale = this.db.raw.prepare('SELECT scope, measure FROM flow_history_measures WHERE fetched_at < ?').all(cutoff) as { scope: string; measure: string }[]
      for (const s of stale) this.db.raw.prepare('DELETE FROM flow_history_hours WHERE scope = ? AND measure = ?').run(s.scope, s.measure)
      const measures = Number(this.db.raw.prepare('DELETE FROM flow_history_measures WHERE fetched_at < ?').run(cutoff).changes)
      return hours + measures
    })
  }
}
