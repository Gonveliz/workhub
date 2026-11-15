import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { WorkhubDb } from './db'

export const BACKUP_FOLDER = 'backups'
/** Automatic copies kept (one per day), and manual ones ("Back up now") kept, each. */
export const BACKUPS_KEPT = 7
const AUTOMATIC = /^workhub-(\d{4}-\d{2}-\d{2})\.db$/
const MANUAL = /^workhub-(\d{4}-\d{2}-\d{2}-\d{4})\.db$/

const pad = (n: number) => String(n).padStart(2, '0')
const localDate = (t: number): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const localMinute = (t: number): string => {
  const d = new Date(t)
  return `${localDate(t)}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

/** The automatic backup of the day `now` falls in: `<dir>/workhub-YYYY-MM-DD.db`. */
export const backupPath = (dir: string, now: number): string => join(dir, `workhub-${localDate(now)}.db`)
/** A manual backup ("Back up now"): `<dir>/workhub-YYYY-MM-DD-HHmm.db`, never the day's automatic one. */
export const manualBackupPath = (dir: string, now: number): string => join(dir, `workhub-${localMinute(now)}.db`)

/** The time a backup's name says, as `YYYY-MM-DD-HHmm` (a daily copy counts as 00:00 of its day). */
const nameTime = (name: string): string => AUTOMATIC.exec(name)?.[1]?.concat('-0000') ?? MANUAL.exec(name)?.[1] ?? ''

/**
 * The backups in `dir` (automatic and manual), newest first: by the date and time in the name (a
 * day's automatic copy as 00:00, so that day's manual ones come before it), then by modification time.
 */
export function listBackups(dir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => AUTOMATIC.test(n) || MANUAL.test(n))
    .map((n) => ({ path: join(dir, n), key: nameTime(n) }))
    .map((b) => ({ ...b, mtime: statTime(b.path) }))
    .sort((a, b) => (a.key === b.key ? b.mtime - a.mtime : a.key < b.key ? 1 : -1))
    .map((b) => b.path)
}

function statTime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** Whether a damaged database moved aside (`workhub.db.corrupt-*`) is next to the database. */
function corruptCopyExists(dbPath: string): boolean {
  try {
    const name = basename(dbPath)
    return readdirSync(dirname(dbPath)).some((n) => n.startsWith(`${name}.corrupt-`))
  } catch {
    return false
  }
}

/**
 * The backups to delete: beyond the newest `keep` automatic and the newest `keep` manual ones.
 * Never while a damaged database lies next to the live one (the user may still need an older
 * copy), and never the newest copy made before the last move-aside: that is the last good state.
 */
function prunable(db: WorkhubDb, dir: string, keep: number): string[] {
  if (db.path === ':memory:' || corruptCopyExists(db.path)) return []
  const all = listBackups(dir)
  const recovered = db.recovered()
  const lastGood = recovered ? all.find((p) => statTime(p) < recovered.at) : undefined
  const automatic = all.filter((p) => AUTOMATIC.test(basename(p)))
  const manual = all.filter((p) => MANUAL.test(basename(p)))
  return [...automatic.slice(keep), ...manual.slice(keep)].filter((p) => p !== lastGood)
}

/**
 * Copies the database into `dir` and prunes old copies (see `prunable`). Automatic: today's
 * `workhub-YYYY-MM-DD.db`, skipped (null) when today has one. `manual`: a new
 * `workhub-YYYY-MM-DD-HHmm.db`. The folder is owner-only (not on Windows).
 */
export async function backupDatabase(db: WorkhubDb, dir: string, options: { now?: number; keep?: number; manual?: boolean } = {}): Promise<string | null> {
  const now = options.now ?? Date.now()
  const target = options.manual ? manualBackupPath(dir, now) : backupPath(dir, now)
  if (!options.manual && listBackups(dir).includes(target)) return null
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    try {
      chmodSync(dir, 0o700)
    } catch {
      // Not ours to change.
    }
  }
  await db.backup(target)
  for (const old of prunable(db, dir, options.keep ?? BACKUPS_KEPT)) rmSync(old, { force: true })
  return target
}
