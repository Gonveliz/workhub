/**
 * Runs agents' read-only SQL in a separate process (`analytics-worker.ts`), one query at a time.
 * A query that outlives the time budget gets its process killed, answers `timedOut: true` with no
 * rows, and the next query starts a new process. The main process never runs agents' SQL, so a
 * pathological query (a recursive CTE without end, a huge cross join) cannot freeze the app.
 */
import { fork } from 'node:child_process'
import { DENIED_FUNCTIONS, DENIED_NAMES, QUERY_LIMITS, type QueryParams, type QueryResult } from '@workhub/adapters/sqlite-store'
import type { WorkerInit, WorkerQuery, WorkerReply } from './analytics-worker'

/** A running worker process, whatever started it (Electron's utilityProcess, Node's fork). */
export interface QueryWorker {
  post(msg: WorkerInit | WorkerQuery): void
  onMessage(fn: (msg: WorkerReply) => void): void
  onExit(fn: (code: number | null) => void): void
  kill(): void
}

export type SpawnQueryWorker = () => QueryWorker

/** A worker through `child_process.fork` (tests; `execPath` picks another runtime, such as Electron as Node). */
export function forkQueryWorker(script: string, options: { execPath?: string; env?: NodeJS.ProcessEnv } = {}): SpawnQueryWorker {
  return () => {
    const child = fork(script, [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], ...(options.execPath ? { execPath: options.execPath } : {}), ...(options.env ? { env: options.env } : {}) })
    return {
      post: (m) => {
        if (child.connected) child.send(m)
      },
      onMessage: (fn) => child.on('message', (m) => fn(m as WorkerReply)),
      onExit: (fn) => child.on('exit', (code) => fn(code)),
      kill: () => child.kill('SIGKILL')
    }
  }
}

export interface AnalyticsQueriesOptions {
  spawn: SpawnQueryWorker
  /** The database file. */
  path: string
  budgetMs?: number
  log?: (message: string) => void
  now?: () => number
}

/** The worker runs where SQLite's authorizer is missing: queries are refused, not run unguarded. */
export class QueryGuardUnavailable extends Error {
  constructor() {
    super('read-only guard unavailable')
  }
}

interface Live {
  /** False once the worker said it has no authorizer: every query is refused. */
  guarded: boolean
  worker: QueryWorker
  pending: Map<number, (reply: WorkerReply | { type: 'exit'; code: number | null } | { type: 'guard' }) => void>
}

export class AnalyticsQueries {
  private live: Live | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private nextId = 1
  private warned = false

  constructor(private readonly options: AnalyticsQueriesOptions) {}

  /** Runs one query (already checked) after the ones before it; rejects with SQLite's error or when the worker dies. */
  run(sql: string, params: QueryParams, limit: number, deniedTables: readonly string[]): Promise<QueryResult> {
    const result = this.tail.then(() => this.one(sql, params, limit, deniedTables))
    this.tail = result.catch(() => undefined)
    return result
  }

  private start(): Live {
    if (this.live) return this.live
    const worker = this.options.spawn()
    const live: Live = { guarded: true, worker, pending: new Map() }
    worker.onMessage((msg) => {
      if (msg.type === 'ready') {
        if (!msg.authorizer) {
          live.guarded = false
          if (!this.warned) {
            this.warned = true
            this.options.log?.('analytics worker: SQLite authorizer unavailable (setAuthorizer missing); queries are refused')
          }
          // Whatever was sent before this answer is refused too (the worker refuses them as well).
          for (const done of live.pending.values()) done({ type: 'guard' })
          live.pending.clear()
        }
        return
      }
      const done = live.pending.get(msg.id)
      live.pending.delete(msg.id)
      done?.(msg)
    })
    worker.onExit((code) => {
      if (this.live === live) this.live = null
      for (const done of live.pending.values()) done({ type: 'exit', code })
      live.pending.clear()
    })
    const init: WorkerInit = { type: 'init', path: this.options.path, deniedNames: [...DENIED_NAMES], deniedFunctions: [...DENIED_FUNCTIONS], cellChars: QUERY_LIMITS.cellChars }
    worker.post(init)
    this.live = live
    return live
  }

  private one(sql: string, params: QueryParams, limit: number, deniedTables: readonly string[]): Promise<QueryResult> {
    const now = this.options.now ?? (() => performance.now())
    const budget = this.options.budgetMs ?? QUERY_LIMITS.budgetMs
    const started = now()
    const live = this.start()
    if (!live.guarded) return Promise.reject(new QueryGuardUnavailable())
    const id = this.nextId++
    return new Promise<QueryResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        live.pending.delete(id)
        this.stop(live)
        this.options.log?.(`analytics worker: query stopped after ${budget} ms (process killed)`)
        resolve({ columns: [], rows: [], rowCount: 0, truncated: true, timedOut: true, elapsedMs: Math.round(now() - started) })
      }, budget)
      live.pending.set(id, (reply) => {
        clearTimeout(timer)
        const elapsedMs = Math.round(now() - started)
        if (reply.type === 'result') resolve({ columns: reply.columns, rows: reply.rows, rowCount: reply.rows.length, truncated: reply.truncated, timedOut: false, elapsedMs })
        else if (reply.type === 'guard') reject(new QueryGuardUnavailable())
        else if (reply.type === 'error') reject(reply.message === 'read-only guard unavailable' ? new QueryGuardUnavailable() : new Error(reply.message))
        else if (reply.type === 'exit') reject(new Error(`the query process stopped (exit code ${String(reply.code)})`))
      })
      live.worker.post({ type: 'query', id, sql, params, limit, deniedTables: [...deniedTables] })
    })
  }

  private stop(live: Live): void {
    if (this.live === live) this.live = null
    try {
      live.worker.kill()
    } catch {
      // Already gone.
    }
  }

  /** Stops the worker (on quit). */
  close(): void {
    if (this.live) this.stop(this.live)
  }

  /** Stops the worker and resolves once its process has exited (its read connection closed), or after `timeoutMs`. */
  closeAndWait(timeoutMs = 2000): Promise<void> {
    const live = this.live
    if (!live) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      live.worker.onExit(() => {
        clearTimeout(timer)
        resolve()
      })
      this.stop(live)
    })
  }
}
