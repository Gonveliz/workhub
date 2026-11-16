/**
 * Settings → Advanced → Data → Restore…: puts a backup (or a copy an earlier restore set aside) in
 * place of `workhub.db`. In this order:
 *
 * 1. `request` checks the copy while nothing is touched (it opens, `PRAGMA integrity_check`, a
 *    schema no newer than this app's); a refusal goes back to the window and nothing else happens.
 * 2. It stops the daily jobs and asks the app to relaunch and quit. Quitting stops the background
 *    jobs and agents, waits for the report workers' processes to exit and closes the database
 *    (`will-quit` in index.ts), so nothing writes to the file any more.
 * 3. `finish`, called once the database is closed, moves the current file aside as
 *    `workhub.db.before-restore-<timestamp>` (listed too, so the restore can be undone) and copies
 *    the backup into place; when a step fails the original is put back and the error shown.
 * 4. The app starts again on whichever file is then in place.
 *
 * Settings window only: `storage:restore*` is not in the remote allowlist, and the control endpoint
 * has no route for it.
 */
import { listRestorePoints, swapInBackup, verifyBackup, type SwapOptions } from '@workhub/adapters/sqlite-store'
import type { StorageRestorePoint, StorageRestoreResult } from '../shared/api'
import type { IpcRegistrar } from './ipc-guard'

export interface DatabaseRestoreDeps {
  dbPath: string
  backupDir: string
  /** Stops what would still write before the quit gets to it (the storage maintenance's timers). */
  stopJobs: () => void
  /** `app.relaunch()` then `app.quit()`: the quit closes the database and calls `finish`. */
  relaunchAndQuit: () => void
  /** Tells the person a swap that failed (a dialog: the windows are gone by then). */
  showError: (message: string) => void
  log: (message: string) => void
  /** The schema version this app knows (tests); the app's migrations by default. */
  knownVersion?: number
  swap?: SwapOptions
}

export class DatabaseRestore {
  private pending: string | null = null

  constructor(private readonly deps: DatabaseRestoreDeps) {}

  list(): StorageRestorePoint[] {
    return listRestorePoints(this.deps.dbPath, this.deps.backupDir)
  }

  /** The copy waiting for the database to close, if a restore was asked for. */
  get pendingPath(): string | null {
    return this.pending
  }

  /** Checks `path` (one of `list()` only) and, when it passes, starts the restart that swaps it in. */
  request(path: unknown): StorageRestoreResult {
    if (this.pending) return { ok: false, reason: 'failed', error: 'a restore is already under way' }
    // Only a listed copy: the window never names an arbitrary file to put in place of the database.
    if (typeof path !== 'string' || !this.list().some((p) => p.path === path)) return { ok: false, reason: 'unknown', error: 'not one of the listed copies' }
    const check = verifyBackup(path, this.deps.knownVersion)
    if (!check.ok) {
      this.deps.log(`restore: ${path} refused (${check.reason}): ${check.error}`)
      return check
    }
    this.deps.log(`restore: ${path} passed its checks (schema ${check.schemaVersion}); restarting to swap it in`)
    this.pending = path
    this.deps.stopJobs()
    this.deps.relaunchAndQuit()
    return { ok: true }
  }

  /** Once the database is closed: swaps the pending copy in. Nothing to do without one. */
  finish(): void {
    const path = this.pending
    if (!path) return
    this.pending = null
    const r = swapInBackup(this.deps.dbPath, path, this.deps.swap)
    if (r.ok) {
      this.deps.log(`restore: ${path} is in place; the replaced database was kept as ${r.movedTo}`)
      return
    }
    this.deps.log(`restore: swapping ${path} in failed, the original database was put back: ${r.error}`)
    this.deps.showError(`The backup ${path} could not be put in place: ${r.error}\n\nThe database was left as it was; Workhub starts again on it.`)
  }
}

/** `storage:restorePoints` and `storage:restore` (Settings window only: not in the remote allowlist). */
export function registerDatabaseRestoreIpc(ipc: IpcRegistrar, restore: Pick<DatabaseRestore, 'list' | 'request'>): void {
  ipc.handle('storage:restorePoints', () => restore.list())
  ipc.handle('storage:restore', (_e, path: unknown) => restore.request(path))
}
