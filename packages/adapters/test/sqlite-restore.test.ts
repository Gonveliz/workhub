import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, writeSync, closeSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { backupDatabase, beforeRestorePath, DB_FILE, listRestorePoints, MIGRATIONS, swapInBackup, verifyBackup, WorkhubDb } from '../src/sqlite-store'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wh-restore-'))
  dirs.push(d)
  return d
}
const latest = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)
const kv = (db: WorkhubDb, key: string): unknown => {
  const row = db.raw.prepare('SELECT value FROM kv_state WHERE key = ?').get(key) as { value: string } | undefined
  return row ? JSON.parse(row.value) : undefined
}

/** A database with `marker` stored, closed, plus a backup of it in `<dir>/backups`. */
async function withBackup(dir: string, marker: string): Promise<{ dbPath: string; backup: string }> {
  const dbPath = join(dir, DB_FILE)
  const db = WorkhubDb.open(dbPath, { log: () => {} })
  db.state<string>('marker', 0).save(marker)
  db.flushAll()
  const backup = (await backupDatabase(db, join(dir, 'backups'), { now: new Date(2026, 0, 2, 12).getTime(), manual: true }))!
  db.close()
  return { dbPath, backup }
}

const markerOf = (path: string): unknown => {
  const db = WorkhubDb.open(path, { log: () => {} })
  try {
    return kv(db, 'marker')
  } finally {
    db.close()
  }
}

describe('verifyBackup', () => {
  it('accepts a good backup and leaves no side files next to it', async () => {
    const dir = tmp()
    const { backup } = await withBackup(dir, 'a')
    expect(verifyBackup(backup)).toEqual({ ok: true, schemaVersion: latest })
    expect(readdirSync(join(dir, 'backups'))).toEqual([basename(backup)])
  })

  it('refuses a backup that fails the integrity check', async () => {
    const dir = tmp()
    const { backup } = await withBackup(dir, 'a')
    // Scribble over the pages after the header: the file still opens, its b-trees do not hold.
    const fd = openSync(backup, 'r+')
    writeSync(fd, Buffer.alloc(8192, 0x5a), 0, 8192, 4096)
    closeSync(fd)
    const r = verifyBackup(backup)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('damaged')
  })

  it('refuses a file that is not a database', () => {
    const dir = tmp()
    const path = join(dir, 'workhub-2026-01-01.db')
    writeFileSync(path, 'not a database at all, just some text that is long enough to have a header')
    const r = verifyBackup(path)
    expect(r.ok).toBe(false)
  })

  it('refuses a backup whose schema is newer than this app knows', async () => {
    const dir = tmp()
    const { backup } = await withBackup(dir, 'a')
    const newer = WorkhubDb.open(backup, { log: () => {} })
    newer.raw.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(latest + 1, 1)
    newer.close()
    const r = verifyBackup(backup)
    expect(r).toMatchObject({ ok: false, reason: 'newerSchema' })
    expect(verifyBackup(backup, latest + 1)).toEqual({ ok: true, schemaVersion: latest + 1 })
  })
})

describe('swapInBackup', () => {
  it('puts the backup in place and keeps the replaced database as a before-restore copy', async () => {
    const dir = tmp()
    const { dbPath, backup } = await withBackup(dir, 'old')
    const later = WorkhubDb.open(dbPath, { log: () => {} })
    later.state<string>('marker', 0).save('new')
    later.close()
    const r = swapInBackup(dbPath, backup, { now: 1_700_000_000_000 })
    expect(r).toEqual({ ok: true, movedTo: beforeRestorePath(dbPath, 1_700_000_000_000) })
    expect(markerOf(dbPath)).toBe('old')
    expect(markerOf(`${dbPath}.before-restore-1700000000000`)).toBe('new')
    expect(existsSync(backup)).toBe(true)
    expect(existsSync(`${dbPath}.restore-tmp`)).toBe(false)
    // The copy set aside is offered as a restore point, so the restore can be undone.
    const points = listRestorePoints(dbPath, join(dir, 'backups'))
    expect(points.map((p) => [basename(p.path), p.kind])).toEqual([
      [basename(backup), 'manual'],
      [`${DB_FILE}.before-restore-1700000000000`, 'beforeRestore']
    ])
  })

  it('moves the write-ahead log aside with the database, so the restored file never pairs with it', async () => {
    const dir = tmp()
    const { dbPath, backup } = await withBackup(dir, 'old')
    writeFileSync(`${dbPath}-wal`, 'pending pages')
    writeFileSync(`${dbPath}-shm`, 'index')
    expect(swapInBackup(dbPath, backup, { now: 5 }).ok).toBe(true)
    expect(existsSync(`${dbPath}-wal`)).toBe(false)
    expect(existsSync(`${dbPath}.before-restore-5-wal`)).toBe(true)
  })

  it('puts the original back when a step fails half-way', async () => {
    const dir = tmp()
    const { dbPath, backup } = await withBackup(dir, 'old')
    const later = WorkhubDb.open(dbPath, { log: () => {} })
    later.state<string>('marker', 0).save('current')
    later.close()
    writeFileSync(`${dbPath}-shm`, 'index')
    // The database and its side file are moved aside; renaming the copy into place fails.
    const rename = (from: string, to: string) => {
      if (to === dbPath) throw new Error('EPERM: operation not permitted')
      renameSync(from, to)
    }
    const r = swapInBackup(dbPath, backup, { now: 9, rename })
    expect(r).toMatchObject({ ok: false, reason: 'failed', error: 'EPERM: operation not permitted' })
    expect(existsSync(`${dbPath}-shm`)).toBe(true)
    expect(markerOf(dbPath)).toBe('current')
    expect(readdirSync(dir).filter((n) => n.includes('before-restore') || n.includes('restore-tmp'))).toEqual([])
  })

  it('touches nothing when the copy cannot be made', async () => {
    const dir = tmp()
    const { dbPath } = await withBackup(dir, 'old')
    mkdirSync(join(dir, 'gone'))
    const r = swapInBackup(dbPath, join(dir, 'gone', 'missing.db'), { now: 9 })
    expect(r.ok).toBe(false)
    expect(markerOf(dbPath)).toBe('old')
    expect(readdirSync(dir).filter((n) => n.includes('before-restore'))).toEqual([])
  })
})
