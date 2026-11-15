/**
 * The flow-map history: the hourly aggregates of every measure, per profile, connection and
 * environment (see `@workhub/core` flow-history), in the data folder's database. The screens read
 * the last week; the database keeps `FLOW_HISTORY_DAYS` (pruned on start). Only the hours that
 * change are written.
 */
import { createHash } from 'node:crypto'
import { FLOW_HISTORY_HOURS, flowHistoryStart, type FlowMeasureHistory } from '@workhub/core'
import { FLOW_HISTORY_DAYS, SqliteFlowHistory, type WorkhubDb } from '@workhub/adapters/sqlite-store'

export { FLOW_HISTORY_DAYS }
const WEEK_MS = FLOW_HISTORY_HOURS * 3_600_000

/** The id a scope is stored under: a hash, so ids and connection details never end up in the database (it was the file name before). */
export const flowHistoryScopeId = (scope: string): string => createHash('sha256').update(scope).digest('hex').slice(0, 24)

export class FlowHistoryStore {
  private readonly table: SqliteFlowHistory
  /** What was last read or written per measure, so a write only touches the hours that changed. */
  private readonly cache = new Map<string, FlowMeasureHistory>()
  private readonly unsaved = new Set<string>()

  constructor(
    db: WorkhubDb,
    private readonly now: () => number = Date.now,
    private readonly log: (message: string) => void = (m) => console.warn(m)
  ) {
    this.table = new SqliteFlowHistory(db, now)
  }

  /** A database read; a failure is logged and reads as nothing stored (never as a cluster failure). */
  private read(sid: string, key: string, since: number): FlowMeasureHistory | undefined {
    try {
      return this.table.read(sid, key, since)
    } catch (err) {
      this.log(`flow history read failed: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }

  /** A measure's history of the last week; undefined when never stored or not read for a week. */
  get(scope: string, key: string): FlowMeasureHistory | undefined {
    const id = `${flowHistoryScopeId(scope)}|${key}`
    let history = this.cache.get(id)
    if (!history) {
      history = this.read(flowHistoryScopeId(scope), key, flowHistoryStart(this.now()))
      if (!history) return undefined
      this.cache.set(id, history)
    }
    // Measures nobody asked for in a week (a map removed or edited) are not shown.
    if (this.now() - history.fetchedAt > WEEK_MS) return undefined
    const start = flowHistoryStart(this.now())
    return history.hours.some((h) => h.at < start) ? { ...history, hours: history.hours.filter((h) => h.at >= start) } : history
  }

  set(scope: string, key: string, history: FlowMeasureHistory): void {
    const start = flowHistoryStart(this.now())
    const next: FlowMeasureHistory = { ...history, hours: history.hours.filter((h) => h.at >= start) }
    const sid = flowHistoryScopeId(scope)
    const id = `${sid}|${key}`
    // After a failed write the cache no longer matches the rows: the next write sends every hour.
    const previous = this.unsaved.has(id) ? this.read(sid, key, 0) : (this.cache.get(id) ?? this.read(sid, key, start))
    // The reading is kept in memory either way; a failed write is logged, never reported as a failed cluster read.
    this.cache.set(id, next)
    try {
      this.table.write(sid, key, next, previous, start)
      this.unsaved.delete(id)
    } catch (err) {
      this.unsaved.add(id)
      this.log(`flow history write failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Nothing is pending: every `set` is written at once. Kept for the quit sequence. */
  flush(): void {}

  /** Deletes hours and measures older than the retention; returns how many rows went. */
  prune(): number {
    this.cache.clear()
    try {
      return this.table.prune(FLOW_HISTORY_DAYS)
    } catch (err) {
      this.log(`flow history prune failed: ${err instanceof Error ? err.message : String(err)}`)
      return 0
    }
  }
}
