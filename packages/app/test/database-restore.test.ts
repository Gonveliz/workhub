import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { backupDatabase, DB_FILE, WorkhubDb } from '@workhub/adapters/sqlite-store'
import { DatabaseRestore, registerDatabaseRestoreIpc } from '../src/main/database-restore'
import { REMOTE_INVOKES } from '../src/main/remote/allowlist'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const marker = (path: string): unknown => {
  const db = WorkhubDb.open(path, { log: () => {} })
  try {
    const row = db.raw.prepare("SELECT value FROM kv_state WHERE key = 'marker'").get() as { value: string } | undefined
    return row ? JSON.parse(row.value) : undefined
  } finally {
    db.close()
  }
}

/** A data folder whose database holds 'current' and whose one backup holds 'backed up'. */
async function dataFolder() {
  const dir = mkdtempSync(join(tmpdir(), 'wh-restore-app-'))
  dirs.push(dir)
  const dbPath = join(dir, DB_FILE)
  const backupDir = join(dir, 'backups')
  const db = WorkhubDb.open(dbPath, { log: () => {} })
  db.state<string>('marker', 0).save('backed up')
  db.flushAll()
  const backup = (await backupDatabase(db, backupDir, { manual: true }))!
  db.state<string>('marker', 0).save('current')
  db.close()
  return { dir, dbPath, backupDir, backup }
}

const deps = (dbPath: string, backupDir: string) => ({
  dbPath,
  backupDir,
  stopJobs: vi.fn(),
  relaunchAndQuit: vi.fn(),
  showError: vi.fn(),
  log: vi.fn()
})

describe('DatabaseRestore', () => {
  it('lists the backups and refuses a file that is not one of them, touching nothing', async () => {
    const { dir, dbPath, backupDir, backup } = await dataFolder()
    const d = deps(dbPath, backupDir)
    const restore = new DatabaseRestore(d)
    expect(restore.list()).toEqual([expect.objectContaining({ path: backup, kind: 'manual' })])
    expect(restore.request(join(dir, 'elsewhere.db'))).toMatchObject({ ok: false, reason: 'unknown' })
    expect(restore.request(dbPath)).toMatchObject({ ok: false, reason: 'unknown' })
    expect(d.relaunchAndQuit).not.toHaveBeenCalled()
    expect(restore.pendingPath).toBeNull()
  })

  it('refuses a damaged backup before stopping anything', async () => {
    const { dbPath, backupDir, backup } = await dataFolder()
    const fd = openSync(backup, 'r+')
    writeSync(fd, Buffer.alloc(8192, 0x5a), 0, 8192, 4096)
    closeSync(fd)
    const d = deps(dbPath, backupDir)
    const restore = new DatabaseRestore(d)
    expect(restore.request(backup)).toMatchObject({ ok: false, reason: 'damaged' })
    expect(d.stopJobs).not.toHaveBeenCalled()
    expect(d.relaunchAndQuit).not.toHaveBeenCalled()
    restore.finish()
    expect(marker(dbPath)).toBe('current')
  })

  it('refuses a backup made by a newer Workhub', async () => {
    const { dbPath, backupDir, backup } = await dataFolder()
    const d = deps(dbPath, backupDir)
    const restore = new DatabaseRestore({ ...d, knownVersion: 1 })
    expect(restore.request(backup)).toMatchObject({ ok: false, reason: 'newerSchema' })
    expect(d.relaunchAndQuit).not.toHaveBeenCalled()
  })

  it('restarts to swap a good backup in, keeping the current database as a copy that is listed', async () => {
    const { dir, dbPath, backupDir, backup } = await dataFolder()
    const d = deps(dbPath, backupDir)
    const restore = new DatabaseRestore({ ...d, swap: { now: 1234 } })
    expect(restore.request(backup)).toEqual({ ok: true })
    expect(d.stopJobs).toHaveBeenCalledOnce()
    expect(d.relaunchAndQuit).toHaveBeenCalledOnce()
    // Nothing moves until the quit has closed the database.
    expect(marker(dbPath)).toBe('current')
    restore.finish()
    expect(marker(dbPath)).toBe('backed up')
    expect(marker(join(dir, `${DB_FILE}.before-restore-1234`))).toBe('current')
    expect(restore.list().map((p) => p.kind)).toEqual(['manual', 'beforeRestore'])
    expect(d.showError).not.toHaveBeenCalled()
  })

  it('puts the original back and says so when the swap fails half-way', async () => {
    const { dir, dbPath, backupDir, backup } = await dataFolder()
    const d = deps(dbPath, backupDir)
    const rename = (from: string, to: string) => {
      if (to === dbPath) throw new Error('EBUSY: resource busy or locked')
      // The real move aside, so there is something to put back.
      renameSync(from, to)
    }
    const restore = new DatabaseRestore({ ...d, swap: { now: 99, rename } })
    expect(restore.request(backup)).toEqual({ ok: true })
    restore.finish()
    expect(d.showError).toHaveBeenCalledWith(expect.stringContaining('EBUSY'))
    expect(marker(dbPath)).toBe('current')
    expect(existsSync(backup)).toBe(true)
    expect(readdirSync(dir).filter((n) => n.includes('before-restore'))).toEqual([])
  })

  it('is reachable from the Settings window only, never from a paired device', () => {
    const handlers = new Map<string, (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
    registerDatabaseRestoreIpc({ handle: (channel: string, fn: (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void handlers.set(channel, fn) } as never, { list: () => [], request: () => ({ ok: true }) })
    expect([...handlers.keys()]).toEqual(['storage:restorePoints', 'storage:restore'])
    for (const channel of handlers.keys()) expect(REMOTE_INVOKES[channel]).toBeUndefined()
  })
})
