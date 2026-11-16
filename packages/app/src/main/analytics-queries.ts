/**
 * Runs agents' read-only SQL in a separate process (`analytics-worker.ts`), one query at a time.
 * A query that outlives the time budget gets its process killed, answers `timedOut: true` with no
 * rows, and the next query starts a new process. The main process never runs agents' SQL, so a
 * pathological query (a recursive CTE without end, a huge cross join) cannot freeze the app.
 *
 * `report` runs a Usage and reports query by name the same way (the app keeps a second instance for
 * the screen); one that outlives the budget kills the process too and is rejected with an error.
 * `storage` reads the rows and sizes of Settings → Advanced → Data the same way.
 *
 * `exclusive` runs a task while no worker holds the file open (Compact now's VACUUM): after the
 * queries queued before it, with the process stopped; the ones queued after it wait and start a
 * new process.
 */
import { fork } from 'node:child_process'
import { DENIED_FUNCTIONS, DENIED_NAMES, QUERY_LIMITS, type AnalyticsReport, type QueryParams, type QueryResult, type StorageStats } from '@workhub/adapters/sqlite-store'
import type { WorkerInit, WorkerQuery, WorkerReply, WorkerReport, WorkerStorage } from './analytics-worker'

/** A running worker process, whatever started it (Electron's utilityProcess, Node's fork). */
export interface QueryWorker {
  post(msg: WorkerInit | WorkerQuery | WorkerReport | WorkerStorage): void
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

type Settle = (reply: WorkerReply | { type: 'exit'; code: number | null } | { type: 'guard' }) => void

interface Live {
  /** False once the worker said it has no authorizer: every SQL query is refused (reports still run). */
  guarded: boolean
  worker: QueryWorker
  pending: Map<number, { report: boolean; done: Settle }>
}

/** The error a report gets when it outlives the budget (its process is killed). */
export class ReportTimedOut extends Error {
  constructor(budgetMs: number) {
    super(`the usage report took longer than ${Math.round(budgetMs / 1000)} s and was stopped`)
  }
}

export class AnalyticsQueries {
  private live: Live | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private nextId = 1
  private warned = false

  constructor(private readonly options: AnalyticsQueriesOptions) {}

  /** Runs one query (already checked) after the ones before it; rejects with SQLite's error or when the worker dies. */
  run(sql: string, params: QueryParams, limit: number, deniedTables: readonly string[]): Promise<QueryResult> {
    return this.queue(() => this.one(sql, params, limit, deniedTables))
  }

  /** Runs a named report (arguments already checked) after the ones before it; rejects with its error, on timeout or when the worker dies. */
  report(report: AnalyticsReport): Promise<unknown> {
    return this.queue(() => this.oneReport(report.name, (id) => ({ type: 'report', id, report })))
  }

  /** The rows and sizes per group of tables, read in the worker; rejects like `report`. */
  storage(): Promise<StorageStats> {
    return this.queue(() => this.oneReport('storage', (id) => ({ type: 'storage', id }))) as Promise<StorageStats>
  }

  /** Runs `task` with no worker process alive, between the queries queued before and after it. */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    return this.queue(async () => {
      await this.closeAndWait()
      return task()
    })
  }

  private queue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task)
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
          // Whatever SQL was sent before this answer is refused too (the worker refuses it as well).
          for (const [id, p] of live.pending) {
            if (p.report) continue
            live.pending.delete(id)
            p.done({ type: 'guard' })
          }
        }
        return
      }
      const p = live.pending.get(msg.id)
      live.pending.delete(msg.id)
      p?.done(msg)
    })
    worker.onExit((code) => {
      if (this.live === live) this.live = null
      for (const p of live.pending.values()) p.done({ type: 'exit', code })
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
      live.pending.set(id, {
        report: false,
        done: (reply) => {
          clearTimeout(timer)
          const elapsedMs = Math.round(now() - started)
          if (reply.type === 'result') resolve({ columns: reply.columns, rows: reply.rows, rowCount: reply.rows.length, truncated: reply.truncated, timedOut: false, elapsedMs })
          else if (reply.type === 'guard') reject(new QueryGuardUnavailable())
          else if (reply.type === 'error') reject(reply.message === 'read-only guard unavailable' ? new QueryGuardUnavailable() : new Error(reply.message))
          else if (reply.type === 'exit') reject(new Error(`the query process stopped (exit code ${String(reply.code)})`))
          else reject(new Error('unexpected reply from the query process'))
        }
      })
      live.worker.post({ type: 'query', id, sql, params, limit, deniedTables: [...deniedTables] })
    })
  }

  private oneReport(name: string, message: (id: number) => WorkerReport | WorkerStorage): Promise<unknown> {
    const budget = this.options.budgetMs ?? QUERY_LIMITS.budgetMs
    const live = this.start()
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        live.pending.delete(id)
        this.stop(live)
        this.options.log?.(`analytics worker: report ${name} stopped after ${budget} ms (process killed)`)
        reject(new ReportTimedOut(budget))
      }, budget)
      live.pending.set(id, {
        report: true,
        done: (reply) => {
          clearTimeout(timer)
          if (reply.type === 'report') resolve(reply.value)
          else if (reply.type === 'error') reject(new Error(reply.message))
          else if (reply.type === 'exit') reject(new Error(`the report process stopped (exit code ${String(reply.code)})`))
          else reject(new Error('unexpected reply from the report process'))
        }
      })
      live.worker.post(message(id))
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
