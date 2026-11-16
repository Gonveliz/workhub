/**
 * Restoring the database from a copy (Settings → Advanced → Data → Restore…). The copy is checked
 * first, while nothing has been touched; the swap itself runs only once the database is closed
 * (on the way out of the app, which then starts again on the restored file). The file it replaces
 * is kept next to it as `workhub.db.before-restore-<timestamp>`, so a restore can be undone.
 */
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { listBackups } from './backup'
import { MIGRATIONS } from './migrations'

export type RestorePointKind = 'automatic' | 'manual' | 'beforeRestore'

export interface RestorePoint {
  path: string
  kind: RestorePointKind
  /** When the copy was last written (epoch ms). */
  at: number
  sizeBytes: number
}

export type RestoreFailure = 'unreadable' | 'damaged' | 'newerSchema' | 'failed'
export type RestoreCheck = { ok: true; schemaVersion: number } | { ok: false; reason: RestoreFailure; error: string }
export type RestoreSwap = { ok: true; movedTo: string } | { ok: false; reason: RestoreFailure; error: string }

const AUTOMATIC = /^workhub-\d{4}-\d{2}-\d{2}\.db$/
const SIDE_FILES = ['-wal', '-shm']
const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Where the current database goes before a restore: `<db>.before-restore-<epoch ms>`. */
export const beforeRestorePath = (dbPath: string, now: number): string => `${dbPath}.before-restore-${now}`

/** The copies a restore can start from: the backups, then the files earlier restores set aside; newest first in each. */
export function listRestorePoints(dbPath: string, backupDir: string): RestorePoint[] {
  const point = (path: string, kind: RestorePointKind): RestorePoint | null => {
    try {
      const s = statSync(path)
      return { path, kind, at: s.mtimeMs, sizeBytes: s.size }
    } catch {
      return null
    }
  }
  const backups = listBackups(backupDir).map((p) => point(p, AUTOMATIC.test(basename(p)) ? 'automatic' : 'manual'))
  const prefix = `${basename(dbPath)}.before-restore-`
  let names: string[] = []
  try {
    names = readdirSync(dirname(dbPath))
  } catch {
    // No data folder yet: nothing set aside.
  }
  const aside = names
    .filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)))
    .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)))
    .map((n) => point(join(dirname(dbPath), n), 'beforeRestore'))
  return [...backups, ...aside].filter((p): p is RestorePoint => p !== null)
}

/**
 * Whether `path` can replace the database: it opens (read-only), `PRAGMA integrity_check` says ok,
 * and its schema is not newer than `knownVersion` (an older one is brought up to date on start).
 */
export function verifyBackup(path: string, knownVersion = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)): RestoreCheck {
  if (!existsSync(path)) return { ok: false, reason: 'unreadable', error: `${path} does not exist` }
  // Opening a WAL file, even read-only, leaves empty side files next to it: remove the ones it made.
  const hadSide = SIDE_FILES.filter((s) => existsSync(path + s))
  let raw: DatabaseSync | null = null
  try {
    try {
      raw = new DatabaseSync(path, { readOnly: true })
    } catch (err) {
      return { ok: false, reason: 'unreadable', error: describe(err) }
    }
    let result: string
    try {
      const rows = raw.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]
      result = rows.map((r) => r.integrity_check).join('; ')
    } catch (err) {
      return { ok: false, reason: 'damaged', error: describe(err) }
    }
    if (result !== 'ok') return { ok: false, reason: 'damaged', error: result }
    let version: number
    try {
      const row = raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined
      version = row?.v ?? 0
    } catch (err) {
      return { ok: false, reason: 'unreadable', error: `not a Workhub database: ${describe(err)}` }
    }
    if (version > knownVersion) return { ok: false, reason: 'newerSchema', error: `schema version ${version} is newer than this app's (${knownVersion})` }
    return { ok: true, schemaVersion: version }
  } finally {
    try {
      raw?.close()
    } catch {
      // Already unusable.
    }
    for (const s of SIDE_FILES) if (!hadSide.includes(s)) rmSync(path + s, { force: true })
  }
}

export interface SwapOptions {
  now?: number
  /** File operations (tests make one fail half-way). */
  copy?: (from: string, to: string) => void
  rename?: (from: string, to: string) => void
}

/**
 * Puts `backupPath` in place of the CLOSED database at `dbPath`: copies it next to the database
 * first (a full disk fails here, with nothing moved), moves the database and its side files aside
 * as `<db>.before-restore-<now>`, then renames the copy into place. When any step fails, what was
 * moved is put back and the copy removed, so the original database is as it was.
 */
export function swapInBackup(dbPath: string, backupPath: string, options: SwapOptions = {}): RestoreSwap {
  const copy = options.copy ?? ((from: string, to: string) => copyFileSync(from, to))
  const rename = options.rename ?? ((from: string, to: string) => renameSync(from, to))
  const aside = beforeRestorePath(dbPath, options.now ?? Date.now())
  const incoming = `${dbPath}.restore-tmp`
  const moved: [string, string][] = []
  try {
    rmSync(incoming, { force: true })
    copy(backupPath, incoming)
    for (const suffix of ['', ...SIDE_FILES]) {
      if (!existsSync(dbPath + suffix)) continue
      rename(dbPath + suffix, aside + suffix)
      moved.push([dbPath + suffix, aside + suffix])
    }
    rename(incoming, dbPath)
  } catch (err) {
    for (const [from, to] of moved.reverse()) {
      try {
        rmSync(from, { force: true })
        renameSync(to, from)
      } catch {
        // Best effort: the error below names the file set aside.
      }
    }
    rmSync(incoming, { force: true })
    return { ok: false, reason: 'failed', error: describe(err) }
  }
  // The close emptied the write-ahead log: empty side files set aside are noise in the data folder.
  try {
    if (existsSync(`${aside}-wal`) && statSync(`${aside}-wal`).size === 0) for (const s of SIDE_FILES) rmSync(aside + s, { force: true })
  } catch {
    // Harmless leftovers.
  }
  return { ok: true, movedTo: aside }
}
