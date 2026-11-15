/**
 * Keeps History's full-text index (`history_fts` in workhub.db) in step with the agents' own
 * session files. Each round lists every history source, reads again only the sessions whose stamp
 * (transcript time and size, title) changed since they were indexed, writes them in transactions
 * of at most about 1 MB of text with a macrotask between them, and drops the sessions whose
 * transcript is gone or whose account is no longer configured. A session that could not be read
 * is skipped until its stamp changes. Rounds run at start, every few minutes and shortly after a
 * session stops (then with a fresh listing).
 */
import type { HistoryEntry, HistoryMessage } from '@workhub/core'
import { HISTORY_WRITE_CHARS, historyContent, historyIndexKey, historyStamp, type IndexedSession, type IndexedStamps } from '@workhub/adapters/sqlite-store'
import type { HistoryIndexProgress, HistoryResult } from '../shared/api'
import { historyAccountKey } from './history'

/** What the indexer needs of the index (`SqliteHistoryIndex`). */
export interface HistoryIndexStore {
  readonly isOpen: boolean
  stamps(): IndexedStamps
  write(sessions: readonly IndexedSession[], maxChars?: number): Iterator<number>
  remove(keys: readonly string[]): void
}

export interface HistoryIndexerDeps {
  index: HistoryIndexStore
  /**
   * Every history source's sessions; `listed` names the accounts listed completely, `accounts`
   * every account tried. `fresh`: a session just stopped, so a listing more than a few seconds old will not do.
   */
  list: (fresh: boolean) => Promise<Pick<HistoryResult, 'entries' | 'listed' | 'accounts'>>
  /** A past session's conversation. */
  messages: (entry: HistoryEntry) => Promise<HistoryMessage[]>
  onProgress?: (progress: HistoryIndexProgress) => void
  log?: (message: string) => void
  /** Most sessions read before they are written. */
  batchSize?: number
  /** Characters of text per transaction. */
  writeChars?: number
  /** Time between rounds. */
  intervalMs?: number
  /** Lets other work run between batches (tests pass an immediate one). */
  pause?: () => Promise<void>
}

export const HISTORY_INDEX_INTERVAL_MS = 5 * 60_000
/** After a session stops, its transcript is read again this much later (it may still be written). */
export const HISTORY_INDEX_AFTER_STOP_MS = 5_000
const BATCH = 20

/** The account key `listed` and `accounts` use. */
export const listedKey = historyAccountKey

export class HistoryIndexer {
  private state: HistoryIndexProgress = { indexing: false, indexed: 0, total: 0 }
  private running: Promise<void> | null = null
  private again = false
  private freshNext = false
  /** Sessions that could not be read, with the stamp they had then: skipped until it changes. */
  private readonly failed = new Map<string, string | null>()
  private stopped = false
  private timer: ReturnType<typeof setInterval> | null = null
  private soon: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: HistoryIndexerDeps) {}

  progress(): HistoryIndexProgress {
    return { ...this.state }
  }

  /** Indexes now, then every `intervalMs`. */
  start(): void {
    if (this.stopped || this.timer) return
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), this.deps.intervalMs ?? HISTORY_INDEX_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** A round shortly (a session stopped); several calls make one round. */
  refreshSoon(delayMs = HISTORY_INDEX_AFTER_STOP_MS): void {
    if (this.stopped || this.soon) return
    this.soon = setTimeout(() => {
      this.soon = null
      void this.refresh(true)
    }, delayMs)
    this.soon.unref?.()
  }

  /** One round (`fresh`: with a new listing); a call while one runs makes one more round after it. */
  refresh(fresh = false): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.freshNext ||= fresh
    if (this.running) {
      this.again = true
      return this.running
    }
    const run = (async () => {
      try {
        do {
          this.again = false
          const useFresh = this.freshNext
          this.freshNext = false
          await this.round(useFresh)
        } while (this.again && !this.stopped)
      } catch (err) {
        this.deps.log?.(`history index: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        this.running = null
        this.set({ indexing: false })
      }
    })()
    this.running = run
    return run
  }

  /** No more rounds; a round running stops before its next write (the database is closing). */
  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.soon) clearTimeout(this.soon)
    this.timer = this.soon = null
  }

  private writable(): boolean {
    return !this.stopped && this.deps.index.isOpen
  }

  private set(change: Partial<HistoryIndexProgress>): void {
    const next = { ...this.state, ...change }
    if (next.indexing === this.state.indexing && next.indexed === this.state.indexed && next.total === this.state.total) return
    this.state = next
    this.deps.onProgress?.(this.progress())
  }

  private pause(): Promise<void> {
    return (this.deps.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0))))()
  }

  private async round(fresh: boolean): Promise<void> {
    if (!this.writable()) return
    const listing = await this.deps.list(fresh)
    if (!this.writable()) return
    // One row per session: the same transcript copied into two accounts is indexed once, the newest copy.
    const current = new Map<string, HistoryEntry>()
    for (const e of listing.entries) {
      const key = historyIndexKey(e)
      const prev = current.get(key)
      if (!prev || e.lastModified > prev.lastModified) current.set(key, e)
    }
    const stamps = this.deps.index.stamps()
    const listed = new Set(listing.listed ?? [])
    const accounts = listing.accounts ? new Set(listing.accounts) : null
    const gone = [...stamps]
      .filter(([key, s]) => {
        const account = listedKey(s.agent, s.accountId)
        return !current.has(key) && (listed.has(account) || (accounts !== null && !accounts.has(account)))
      })
      .map(([key]) => key)
    if (gone.length) this.deps.index.remove(gone)
    for (const key of this.failed.keys()) if (!current.has(key)) this.failed.delete(key)
    const stale = [...current].filter(([key, e]) => {
      const now = historyStamp(e)
      if (this.failed.has(key) && this.failed.get(key) === now && now !== null) return false
      return now === null || stamps.get(key)?.stamp !== now
    })
    // Newest first: what the user most likely searches for is searchable soonest.
    stale.sort((a, b) => b[1].lastModified - a[1].lastModified)
    const total = current.size
    let indexed = total - stale.length
    this.set({ total, indexed, indexing: stale.length > 0 })
    const maxChars = this.deps.writeChars ?? HISTORY_WRITE_CHARS
    const most = Math.max(1, this.deps.batchSize ?? BATCH)
    let batch: IndexedSession[] = []
    let chars = 0
    const flush = async () => {
      const writer = this.deps.index.write(batch, maxChars)
      let finished = 0
      for (;;) {
        if (!this.writable()) return false
        const step = writer.next()
        if (step.done) break
        indexed += step.value - finished
        finished = step.value
        this.set({ indexed })
        await this.pause()
      }
      batch = []
      chars = 0
      return true
    }
    for (const [key, entry] of stale) {
      if (!this.writable()) return
      try {
        const content = historyContent(await this.deps.messages(entry))
        this.failed.delete(key)
        batch.push({ entry, content })
        chars += content.length
      } catch (err) {
        this.failed.set(key, historyStamp(entry))
        this.deps.log?.(`history index: ${entry.agentId} session could not be read: ${err instanceof Error ? err.message : String(err)}`)
      }
      if ((chars >= maxChars || batch.length >= most) && !(await flush())) return
    }
    if (batch.length) await flush()
  }
}
