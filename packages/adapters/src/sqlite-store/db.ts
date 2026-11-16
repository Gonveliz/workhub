/**
 * The app's database: one SQLite file (`workhub.db`) in the data folder, through the SQLite that
 * ships with Node (`node:sqlite`, synchronous, no native module to rebuild for Electron). It holds
 * the state the main process keeps between launches; `config.json` and `secrets.json` stay files.
 */
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite'
import type { StateStore } from '@workhub/core'
import { KvState } from './kv-state'
import { MIGRATIONS, type Migration } from './migrations'

export const DB_FILE = 'workhub.db'

export interface WorkhubDbOptions {
  log?: (message: string) => void
  /** The schema steps to apply, in version order; the app's own by default (tests pass others). */
  migrations?: readonly Migration[]
  now?: () => number
  /** How long a locked database is waited for, in ms (5 s by default). */
  busyTimeoutMs?: number
}

/** The `kv_state` key that records a damaged database moved aside (see `WorkhubDb.recovered`). */
export const RECOVERED_KEY = 'storage/recovered'

export interface StorageRecovery {
  /** Where the damaged file went (`workhub.db.corrupt-<timestamp>`). */
  movedTo: string
  /** When (epoch ms). */
  at: number
  /** SQLite's message. */
  reason: string
}

/** SQLite's primary result codes that mean the file itself is damaged or not a database. */
const SQLITE_CORRUPT = 11
const SQLITE_NOTADB = 26

/** Whether an error from opening the database means the file is damaged (and only that). */
export function isCorruptionError(err: unknown): boolean {
  const code = (err as { errcode?: unknown } | null)?.errcode
  if (typeof code !== 'number') return false
  const primary = code & 0xff
  return primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The database and its side files readable by the user only, like the state files before it (best effort; a no-op on Windows). */
function ownerOnly(path: string): void {
  if (path === ':memory:' || process.platform === 'win32') return
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      chmodSync(path + suffix, 0o600)
    } catch {
      // Not there (no log yet) or not ours to change.
    }
  }
}

export class WorkhubDb {
  private readonly states = new Map<string, KvState<unknown>>()
  private depth = 0
  private closed = false

  private constructor(
    readonly path: string,
    readonly raw: DatabaseSync,
    private readonly log: (message: string) => void,
    private readonly now: () => number
  ) {}

  /**
   * Opens (or creates) the database and its folder, and brings its schema up to date. Only a file
   * SQLite reports as damaged (SQLITE_CORRUPT, SQLITE_NOTADB) is renamed to
   * `<name>.corrupt-<timestamp>`, logged and recorded under `RECOVERED_KEY`, and a fresh database is
   * opened in its place. Any other failure (locked, disk full, read-only, no access) is thrown with
   * a clear message and the file is left alone.
   */
  static open(path: string, options: WorkhubDbOptions = {}): WorkhubDb {
    const log = options.log ?? ((m: string) => console.warn(m))
    const now = options.now ?? Date.now
    const migrations = options.migrations ?? MIGRATIONS
    const timeout = options.busyTimeoutMs ?? 5000
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    try {
      return WorkhubDb.prepare(path, log, now, migrations, timeout)
    } catch (err) {
      if (path === ':memory:' || !isCorruptionError(err)) throw new Error(`The database ${path} could not be opened: ${describe(err)}`, { cause: err })
      const at = now()
      const aside = `${path}.corrupt-${at}`
      log(`database ${path} is damaged (${describe(err)}); moved aside to ${aside}`)
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(path + suffix)) renameSync(path + suffix, aside + suffix)
      }
      let db: WorkhubDb
      try {
        db = WorkhubDb.prepare(path, log, now, migrations, timeout)
      } catch (again) {
        throw new Error(`The database ${path} was damaged and moved aside to ${aside}, and a new one could not be created: ${describe(again)}`, { cause: again })
      }
      const recovery: StorageRecovery = { movedTo: aside, at, reason: describe(err) }
      db.raw.prepare('INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(RECOVERED_KEY, JSON.stringify(recovery), at)
      return db
    }
  }

  private static prepare(path: string, log: (m: string) => void, now: () => number, migrations: readonly Migration[], timeout: number): WorkhubDb {
    const raw = new DatabaseSync(path, { timeout })
    try {
      raw.exec('PRAGMA journal_mode=WAL')
      raw.exec('PRAGMA synchronous=NORMAL')
      raw.exec('PRAGMA foreign_keys=ON')
      const db = new WorkhubDb(path, raw, log, now)
      db.migrate(migrations)
      ownerOnly(path)
      return db
    } catch (err) {
      try {
        raw.close()
      } catch {
        // Already unusable.
      }
      throw err
    }
  }

  /** The last time a damaged database was moved aside, if ever. */
  recovered(): StorageRecovery | null {
    try {
      const row = this.raw.prepare('SELECT value FROM kv_state WHERE key = ?').get(RECOVERED_KEY) as { value: string } | undefined
      return row ? (JSON.parse(row.value) as StorageRecovery) : null
    } catch {
      return null
    }
  }

  /**
   * Runs a write unless the database is closed (after quit): then it is logged and dropped, and
   * `undefined` is returned. Errors of an open database are thrown to the caller.
   */
  write<T>(label: string, fn: () => T): T | undefined {
    if (this.closed) {
      this.log(`${label} not written: the database is closed`)
      return undefined
    }
    return fn()
  }

  private migrate(migrations: readonly Migration[]): void {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
    const row = this.raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined
    const current = row?.v ?? 0
    const known = migrations.reduce((max, m) => Math.max(max, m.version), 0)
    if (current > known) this.log(`database schema version ${current} is newer than this app knows (${known}); reading it as is`)
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (m.version <= current) continue
      this.transaction(() => {
        this.raw.exec(m.sql)
        this.raw.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, this.now())
      })
    }
  }

  /** The schema version applied (the highest migration). */
  schemaVersion(): number {
    const row = this.raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined
    return row?.v ?? 0
  }

  /** Runs `fn` in one transaction (nested calls join the outer one); rolled back when it throws. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++
      try {
        return fn()
      } finally {
        this.depth--
      }
    }
    this.raw.exec('BEGIN IMMEDIATE')
    this.depth = 1
    try {
      const result = fn()
      this.raw.exec('COMMIT')
      return result
    } catch (err) {
      try {
        this.raw.exec('ROLLBACK')
      } catch {
        // The transaction is gone already.
      }
      throw err
    } finally {
      this.depth = 0
    }
  }

  /**
   * The state stored under `key` (a row of `kv_state`), written at most every `delayMs`. One
   * instance per key: asking again returns the same one, so pending writes are never split.
   */
  state<T>(key: string, delayMs = 500): StateStore<T> {
    let s = this.states.get(key)
    if (!s) {
      s = new KvState<unknown>(this, key, delayMs, this.log)
      this.states.set(key, s)
    }
    return s as StateStore<T>
  }

  /** Writes every pending state now (on quit). */
  flushAll(): void {
    for (const s of this.states.values()) s.flush()
  }

  get isOpen(): boolean {
    return !this.closed
  }

  /**
   * Writes what is pending, moves the write-ahead log into the file and empties it
   * (`wal_checkpoint(TRUNCATE)`, so no `-wal` with data outlives the app even when a reader still
   * has the file open), and closes it. Saves after this are logged and dropped.
   */
  close(): void {
    if (this.closed) return
    this.flushAll()
    this.closed = true
    try {
      this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch (err) {
      this.log(`database checkpoint failed: ${describe(err)}`)
    }
    try {
      this.raw.close()
    } catch (err) {
      this.log(`database close failed: ${describe(err)}`)
    }
  }

  /** A consistent copy of the database at `toPath` (written next to it, owner-only, then renamed into place). */
  async backup(toPath: string): Promise<void> {
    const tmp = `${toPath}.tmp`
    rmSync(tmp, { force: true })
    try {
      writeFileSync(tmp, '', { mode: 0o600 })
      // On Node 26 the native backup's promise resolves but its continuation only runs when
      // another timer or I/O callback wakes the event loop (up to seconds when none is due), so
      // keep a short timer alive until it settles.
      const wake = setInterval(() => {}, 10)
      try {
        await sqliteBackup(this.raw, tmp)
      } finally {
        clearInterval(wake)
      }
      ownerOnly(tmp)
      renameSync(tmp, toPath)
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
  }

  /** The bytes the database takes on disk, its write-ahead log included. */
  sizeBytes(): number {
    let total = 0
    for (const suffix of ['', '-wal']) {
      try {
        total += statSync(this.path + suffix).size
      } catch {
        // No such file (an in-memory database, or no log yet).
      }
    }
    return total
  }
}
