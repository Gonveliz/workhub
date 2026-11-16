/**
 * The process that runs agents' read-only SQL (`/v1/analytics/query`) away from the main process:
 * Electron's `utilityProcess` in the app, a Node `child_process.fork` in tests. The main process
 * checks the text first (`checkReadOnlySql`) and kills this process when a query outlives its time
 * budget, so a runaway query never freezes the app.
 *
 * Here the connection is opened read-only with `PRAGMA query_only = 1` and an SQLite authorizer: only
 * SELECT, recursive CTEs, reads of tables not on the denied lists in the main database, and functions
 * not on the denied list. Where Node has no authorizer (`setAuthorizer`, missing in Node 22) the worker
 * says so in `ready` and refuses every query ("read-only guard unavailable").
 *
 * It also runs the Usage and reports screen's queries by name (`report`: the same functions from
 * `sqlite-store/analytics`, never SQL from the renderer), on the same read-only connection; those need
 * no authorizer (their SQL is fixed), so they still run where it is missing.
 *
 * Self-contained on purpose (only `node:sqlite` and `sqlite-store/analytics`, which has type imports
 * only): the lists come in the `init` message, so tests can fork this file as is. Messages: `init` →
 * `ready`; `query` → `result` or `error`; `report` → `report` or `error`.
 */
import { constants as sqliteConstants, DatabaseSync } from 'node:sqlite'
import { runAnalyticsReport, type AnalyticsReport } from '@workhub/adapters/sqlite-store/analytics'

export interface WorkerInit {
  type: 'init'
  path: string
  deniedNames: string[]
  deniedFunctions: string[]
  cellChars: number
}
export interface WorkerQuery {
  type: 'query'
  id: number
  sql: string
  params: unknown
  limit: number
  /** The file's tables and views a query may not read (as of now). */
  deniedTables: string[]
}
/** A Usage and reports query by name, its arguments checked by the main process. */
export interface WorkerReport {
  type: 'report'
  id: number
  report: AnalyticsReport
}
export type WorkerReply =
  | { type: 'ready'; authorizer: boolean }
  | { type: 'report'; id: number; value: unknown }
  | { type: 'result'; id: number; columns: string[]; rows: unknown[][]; truncated: boolean }
  | { type: 'error'; id: number; message: string }

type Authorizer = (action: number, arg1: string | null, arg2: string | null, dbName: string | null, trigger: string | null) => number

interface Port {
  post(msg: WorkerReply): void
  listen(fn: (msg: unknown) => void): void
}

/** Electron's utility process has `process.parentPort`; a forked Node process has `process.send`. */
function port(): Port | null {
  const parent = (process as unknown as { parentPort?: { on(e: 'message', fn: (e: { data: unknown }) => void): void; postMessage(m: unknown): void } }).parentPort
  if (parent) return { post: (m) => parent.postMessage(m), listen: (fn) => parent.on('message', (e) => fn(e.data)) }
  if (typeof process.send === 'function') return { post: (m) => process.send!(m), listen: (fn) => process.on('message', fn) }
  return null
}

let config: WorkerInit | null = null
let conn: DatabaseSync | null = null
/** Whether `conn` has the authorizer: SQL from agents runs only then. */
let guarded = false
let denied = new Set<string>()
/** The message a query gets when this runtime cannot install the authorizer. */
export const GUARD_UNAVAILABLE = 'read-only guard unavailable'

/** Whether this runtime's `node:sqlite` has the authorizer and its constants. */
export function authorizerAvailable(): boolean {
  const c = (sqliteConstants ?? {}) as Record<string, number | undefined>
  return typeof (DatabaseSync.prototype as unknown as { setAuthorizer?: unknown }).setAuthorizer === 'function' && c['SQLITE_OK'] !== undefined && c['SQLITE_DENY'] !== undefined
}

/** Installs the authorizer; false where `setAuthorizer` does not exist. */
function authorize(db: DatabaseSync, cfg: WorkerInit): boolean {
  const set = (db as unknown as { setAuthorizer?: (fn: Authorizer | null) => void }).setAuthorizer
  const c = (sqliteConstants ?? {}) as Record<string, number | undefined>
  const { SQLITE_OK, SQLITE_DENY, SQLITE_SELECT, SQLITE_READ, SQLITE_FUNCTION, SQLITE_RECURSIVE } = c
  if (typeof set !== 'function' || SQLITE_OK === undefined || SQLITE_DENY === undefined) return false
  const names = new Set(cfg.deniedNames)
  const functions = new Set(cfg.deniedFunctions)
  set.call(db, (action, arg1, arg2, dbName) => {
    // Recursive CTEs stay allowed (reports use them); a runaway one is killed by the main process.
    if (action === SQLITE_SELECT || action === SQLITE_RECURSIVE) return SQLITE_OK
    if (action === SQLITE_READ) {
      // Only the main database (COUNT(*) reads with no database name). A name that is no table of
      // the file (a CTE, json_each) passes; the file's denied tables, internal tables and the
      // pragma_* functions do not.
      if (dbName !== null && dbName !== 'main') return SQLITE_DENY
      const table = (arg1 ?? '').toLowerCase()
      return table && !denied.has(table) && !names.has(table) && !table.startsWith('pragma_') ? SQLITE_OK : SQLITE_DENY
    }
    if (action === SQLITE_FUNCTION) return arg2 !== null && !functions.has(arg2.toLowerCase()) ? SQLITE_OK : SQLITE_DENY
    return SQLITE_DENY
  })
  return true
}

/** The read-only connection; without the authorizer it serves reports only (`run` refuses SQL). */
function open(cfg: WorkerInit): DatabaseSync {
  if (conn) return conn
  const db = new DatabaseSync(cfg.path, { readOnly: true, timeout: 2000 })
  db.exec('PRAGMA query_only = 1')
  guarded = authorize(db, cfg)
  conn = db
  return db
}

function report(cfg: WorkerInit, r: WorkerReport): WorkerReply {
  try {
    const db = open(cfg)
    // The tables an agent's last query could not read do not apply to the reports.
    denied = new Set()
    return { type: 'report', id: r.id, value: runAnalyticsReport({ raw: db }, r.report) }
  } catch (e) {
    return { type: 'error', id: r.id, message: e instanceof Error ? e.message : String(e) }
  }
}

/** A cell as a message can carry it: blobs as `{ blob: base64 }` (first 4 KB), very long text cut. */
function cell(v: unknown, cellChars: number): unknown {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()
  if (v instanceof Uint8Array) return { blob: Buffer.from(v.subarray(0, 4096)).toString('base64'), bytes: v.byteLength }
  if (typeof v === 'string' && v.length > cellChars) return `${v.slice(0, cellChars - 1)}…`
  return v
}

function run(cfg: WorkerInit, q: WorkerQuery): WorkerReply {
  if (!authorizerAvailable()) return { type: 'error', id: q.id, message: GUARD_UNAVAILABLE }
  try {
    const db = open(cfg)
    if (!guarded) return { type: 'error', id: q.id, message: GUARD_UNAVAILABLE }
    denied = new Set(q.deniedTables.map((t) => t.toLowerCase()))
    const stmt = db.prepare(q.sql)
    stmt.setReadBigInts(false)
    const arrays = typeof (stmt as { setReturnArrays?: unknown }).setReturnArrays === 'function'
    if (arrays) (stmt as unknown as { setReturnArrays(on: boolean): void }).setReturnArrays(true)
    let columns: string[] = typeof stmt.columns === 'function' ? stmt.columns().map((c) => c.name) : []
    const params = q.params
    const iterator = (Array.isArray(params) ? stmt.iterate(...(params as (string | number | null)[])) : stmt.iterate((params ?? {}) as Record<string, string | number | null>)) as Iterator<unknown>
    const rows: unknown[][] = []
    let truncated = false
    try {
      for (;;) {
        const next = iterator.next()
        if (next.done) break
        if (rows.length >= q.limit) {
          truncated = true
          break
        }
        const row = next.value
        if (Array.isArray(row)) rows.push(row.map((v) => cell(v, cfg.cellChars)))
        else {
          const record = row as Record<string, unknown>
          if (!columns.length) columns = Object.keys(record)
          rows.push(columns.map((c) => cell(record[c], cfg.cellChars)))
        }
      }
    } finally {
      iterator.return?.()
    }
    return { type: 'result', id: q.id, columns, rows, truncated }
  } catch (e) {
    return { type: 'error', id: q.id, message: e instanceof Error ? e.message : String(e) }
  }
}

const channel = port()
channel?.listen((raw) => {
  const msg = raw as WorkerInit | WorkerQuery | WorkerReport
  if (msg?.type === 'init') {
    config = msg
    const authorizer = authorizerAvailable()
    try {
      open(msg)
    } catch {
      // Reported with the first query.
    }
    channel.post({ type: 'ready', authorizer })
    return
  }
  if (msg?.type === 'query') {
    if (!config) return channel.post({ type: 'error', id: msg.id, message: 'the query worker was not initialized' })
    channel.post(run(config, msg))
  }
  if (msg?.type === 'report') {
    if (!config) return channel.post({ type: 'error', id: msg.id, message: 'the query worker was not initialized' })
    channel.post(report(config, msg))
  }
})
// A forked Node process outlives a parent that died without killing it; leave with the parent.
if (typeof process.send === 'function') process.on('disconnect', () => process.exit(0))
