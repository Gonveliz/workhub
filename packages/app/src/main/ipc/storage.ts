import { shell } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BACKUP_FOLDER, listBackups, type WorkhubDb } from '@workhub/adapters/sqlite-store'
import type { StorageBackupResult, StorageInfo } from '../../shared/api'
import { registerDatabaseRestoreIpc, type DatabaseRestore } from '../database-restore'
import type { IpcRegistrar } from '../ipc-guard'
import { registerStorageMaintenanceIpc, type StorageMaintenance } from '../storage-maintenance'

export interface StorageIpcDeps {
  db: WorkhubDb
  dataDir: string
  /** A copy of the database in the backups folder; `manual` writes a new dated one. */
  backupDb: (manual: boolean) => Promise<string | null>
  storageMaintenance: StorageMaintenance
  databaseRestore: DatabaseRestore
}

/** The database file, its backups, retention and restore (`storage:*`). */
export function registerStorageIpc(ipc: IpcRegistrar, deps: StorageIpcDeps): void {
  const { db, dataDir } = deps
  ipc.handle('storage:info', (): StorageInfo => {
    const backupFolder = join(dataDir, BACKUP_FOLDER)
    return { path: db.path, sizeBytes: db.sizeBytes(), backupFolder, lastBackup: listBackups(backupFolder)[0] ?? null, recovered: db.recovered() }
  })
  ipc.handle('storage:backup', async (): Promise<StorageBackupResult> => {
    try {
      const path = await deps.backupDb(true)
      return path ? { ok: true, path } : { ok: false, error: 'no backup written' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  registerStorageMaintenanceIpc(ipc, deps.storageMaintenance)
  registerDatabaseRestoreIpc(ipc, deps.databaseRestore)
  ipc.on('storage:revealBackups', () => {
    const folder = join(dataDir, BACKUP_FOLDER)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    void shell.openPath(folder)
  })
}
