import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  backupDatabase,
  DB_FILE,
  describeImport,
  FLOW_HISTORY_DAYS,
  flowMapIdFromFileName,
  importLegacyJson,
  isCorruptionError,
  KvState,
  legacyImportDone,
  listBackups,
  MIGRATIONS,
  RECOVERED_KEY,
  SqliteFlowHistory,
  SqliteFlowMaps,
  SqlitePrEventStore,
  WorkhubDb
} from '../src/sqlite-store'

const dirs: string[] = []
const dbs: WorkhubDb[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const db of dbs.splice(0)) db.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wh-sqlite-'))
  dirs.push(d)
  return d
}
const open = (dir: string, log: (m: string) => void = () => {}) => {
  const db = WorkhubDb.open(join(dir, DB_FILE), { log })
  dbs.push(db)
  return db
}
const kv = (db: WorkhubDb, key: string): unknown => {
  const row = db.raw.prepare('SELECT value FROM kv_state WHERE key = ?').get(key) as { value: string } | undefined
  return row ? JSON.parse(row.value) : undefined
}
const DAY = 86_400_000

describe('WorkhubDb', () => {
  it('creates the schema once; opening again applies nothing new', () => {
    const dir = tmp()
    const db = open(dir)
    expect(db.schemaVersion()).toBe(MIGRATIONS.at(-1)!.version)
    const tables = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name)
    expect(tables).toEqual(expect.arrayContaining(['schema_migrations', 'kv_state', 'flow_maps', 'flow_history_measures', 'flow_history_hours']))
    expect(String((db.raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode)).toBe('wal')
    db.close()
    const again = open(dir)
    expect((again.raw.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(MIGRATIONS.length)
  })

  it.skipIf(process.platform === 'win32')('keeps the file readable by the user only', () => {
    const dir = tmp()
    open(dir)
    expect(statSync(join(dir, DB_FILE)).mode & 0o777).toBe(0o600)
  })

  it('applies a later migration on top of an existing database', () => {
    const dir = tmp()
    open(dir).close()
    const db = WorkhubDb.open(join(dir, DB_FILE), { log: () => {}, migrations: [...MIGRATIONS, { version: 99, sql: 'CREATE TABLE extra (x INTEGER)' }] })
    dbs.push(db)
    expect(db.schemaVersion()).toBe(99)
    expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'extra'").get()).toBeTruthy()
  })

  it('moves a file that is not a database aside, records it, and opens a fresh one', () => {
    const dir = tmp()
    writeFileSync(join(dir, DB_FILE), 'this is not a database, just some text that is long enough '.repeat(40))
    const logged: string[] = []
    const db = open(dir, (m) => logged.push(m))
    expect(db.schemaVersion()).toBe(MIGRATIONS.at(-1)!.version)
    const aside = readdirSync(dir).find((n) => n.startsWith(`${DB_FILE}.corrupt-`))
    expect(aside).toBeTruthy()
    expect(logged.join('\n')).toContain('is damaged')
    expect(db.recovered()).toMatchObject({ movedTo: join(dir, aside!), reason: expect.stringContaining('not a database') })
    expect(kv(db, RECOVERED_KEY)).toMatchObject({ movedTo: join(dir, aside!) })
  })

  it('creates a missing data folder instead of failing', () => {
    const dir = join(tmp(), 'nested', 'data')
    const db = open(dir)
    expect(db.schemaVersion()).toBe(MIGRATIONS.at(-1)!.version)
    expect(db.recovered()).toBeNull()
  })

  it('leaves a locked database alone and fails with a clear error', () => {
    const dir = tmp()
    open(dir).close()
    const holder = new DatabaseSync(join(dir, DB_FILE))
    holder.exec('PRAGMA locking_mode=EXCLUSIVE')
    holder.exec('BEGIN EXCLUSIVE')
    try {
      expect(() => WorkhubDb.open(join(dir, DB_FILE), { log: () => {}, busyTimeoutMs: 50 })).toThrow(/could not be opened/)
      expect(readdirSync(dir).some((n) => n.includes('.corrupt-'))).toBe(false)
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
    }
  })

  it('tells damage from other failures', () => {
    expect(isCorruptionError(Object.assign(new Error('file is not a database'), { errcode: 26 }))).toBe(true)
    expect(isCorruptionError(Object.assign(new Error('malformed'), { errcode: 11 }))).toBe(true)
    expect(isCorruptionError(Object.assign(new Error('malformed'), { errcode: 11 | (1 << 8) }))).toBe(true)
    for (const errcode of [5, 6, 8, 10, 13, 14]) expect(isCorruptionError(Object.assign(new Error('x'), { errcode }))).toBe(false)
    expect(isCorruptionError(new Error('no code'))).toBe(false)
  })

  it('drops writes after close instead of throwing', async () => {
    const logged: string[] = []
    const dir = tmp()
    const db = WorkhubDb.open(join(dir, DB_FILE), { log: (m) => logged.push(m) })
    db.close()
    new SqliteFlowMaps(db).put('a', '{}')
    expect(new SqliteFlowMaps(db).remove('a')).toBe(false)
    await new SqlitePrEventStore(db).save({ version: 1, profiles: {} })
    new SqliteFlowHistory(db).write('s', 'm', { hours: [], settledUntil: 0, fetchedAt: 0 }, undefined, 0)
    expect(logged.filter((m) => m.includes('database is closed'))).toHaveLength(4)
  })

  it('rolls a failed transaction back', () => {
    const db = open(tmp())
    expect(() =>
      db.transaction(() => {
        db.raw.prepare("INSERT INTO kv_state (key, value, updated_at) VALUES ('a', '{}', 0)").run()
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(kv(db, 'a')).toBeUndefined()
  })

  it('backs up to a dated file once a day, keeping the newest seven, and manual copies apart', async () => {
    const dir = tmp()
    const db = open(dir)
    db.state<{ n: number }>('x', 0).save({ n: 1 })
    db.flushAll()
    const folder = join(dir, 'backups')
    const first = await backupDatabase(db, folder, { now: new Date(2026, 0, 1, 12).getTime() })
    expect(first).toBe(join(folder, 'workhub-2026-01-01.db'))
    expect(await backupDatabase(db, folder, { now: new Date(2026, 0, 1, 18).getTime() })).toBeNull()
    expect(await backupDatabase(db, folder, { now: new Date(2026, 0, 1, 18, 5).getTime(), manual: true })).toBe(join(folder, 'workhub-2026-01-01-1805.db'))
    for (let d = 2; d <= 9; d++) await backupDatabase(db, folder, { now: new Date(2026, 0, d, 12).getTime() })
    expect(listBackups(folder).map((p) => basename(p))).toEqual(['workhub-2026-01-09.db', 'workhub-2026-01-08.db', 'workhub-2026-01-07.db', 'workhub-2026-01-06.db', 'workhub-2026-01-05.db', 'workhub-2026-01-04.db', 'workhub-2026-01-03.db', 'workhub-2026-01-01-1805.db'])
    const copy = WorkhubDb.open(listBackups(folder)[0]!, { log: () => {} })
    dbs.push(copy)
    expect(kv(copy, 'x')).toEqual({ n: 1 })
    expect(db.sizeBytes()).toBeGreaterThan(0)
    if (process.platform !== 'win32') {
      expect(statSync(folder).mode & 0o777).toBe(0o700)
      expect(statSync(listBackups(folder)[0]!).mode & 0o777).toBe(0o600)
    }
  })

  it('lists backups newest first by the time in the name: a day\'s manual copy before its automatic one', () => {
    const folder = tmp()
    const names = ['workhub-2026-11-14.db', 'workhub-2026-11-15.db', 'workhub-2026-11-15-1406.db', 'workhub-2026-11-15-0905.db', 'workhub-2026-11-14-2359.db', 'notes.db']
    for (const n of names) writeFileSync(join(folder, n), '')
    expect(listBackups(folder).map((p) => basename(p))).toEqual(['workhub-2026-11-15-1406.db', 'workhub-2026-11-15-0905.db', 'workhub-2026-11-15.db', 'workhub-2026-11-14-2359.db', 'workhub-2026-11-14.db'])
    // Same time in the name (a manual copy at 00:00 and the day's automatic one): the newer file first.
    writeFileSync(join(folder, 'workhub-2026-11-16.db'), '')
    writeFileSync(join(folder, 'workhub-2026-11-16-0000.db'), '')
    utimesSync(join(folder, 'workhub-2026-11-16.db'), new Date(2026, 10, 16, 0, 0, 30), new Date(2026, 10, 16, 0, 0, 30))
    utimesSync(join(folder, 'workhub-2026-11-16-0000.db'), new Date(2026, 10, 16, 0, 0, 10), new Date(2026, 10, 16, 0, 0, 10))
    expect(listBackups(folder).slice(0, 2).map((p) => basename(p))).toEqual(['workhub-2026-11-16.db', 'workhub-2026-11-16-0000.db'])
  })

  it('empties the write-ahead log on close, even while a reader still has the file open', () => {
    const dir = tmp()
    const path = join(dir, DB_FILE)
    const db = WorkhubDb.open(path, { log: () => {} })
    db.raw.exec('PRAGMA wal_autocheckpoint = 0')
    const reader = new DatabaseSync(path, { readOnly: true })
    try {
      for (let i = 0; i < 50; i++) db.raw.prepare('INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, ?)').run(`k${i}`, 'x'.repeat(1000), i)
      expect(statSync(`${path}-wal`).size).toBeGreaterThan(0)
      db.close()
      expect(existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0).toBe(0)
      expect((reader.prepare('SELECT COUNT(*) AS n FROM kv_state').get() as { n: number }).n).toBeGreaterThanOrEqual(50)
    } finally {
      reader.close()
    }
    // The quit order: the reader (the analytics worker) gone first, no -wal is left at all.
    const again = WorkhubDb.open(path, { log: () => {} })
    again.raw.prepare('INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, ?)').run('late', 'x', 1)
    again.close()
    expect(existsSync(`${path}-wal`)).toBe(false)
  })

  it('prunes nothing while a damaged database lies next to it, and never the last copy before a recovery', async () => {
    const dir = tmp()
    const db = open(dir)
    const folder = join(dir, 'backups')
    writeFileSync(join(dir, `${DB_FILE}.corrupt-1`), 'x')
    for (let d = 1; d <= 9; d++) {
      const path = await backupDatabase(db, folder, { now: new Date(2026, 0, d, 12).getTime() })
      utimesSync(path!, new Date(2026, 0, d, 12), new Date(2026, 0, d, 12))
    }
    expect(listBackups(folder)).toHaveLength(9)
    rmSync(join(dir, `${DB_FILE}.corrupt-1`))
    db.raw.prepare('INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, 0)').run(RECOVERED_KEY, JSON.stringify({ movedTo: 'x', at: new Date(2026, 0, 2, 13).getTime(), reason: 'test' }))
    await backupDatabase(db, folder, { now: new Date(2026, 0, 10, 12).getTime() })
    expect(listBackups(folder).map((p) => p.slice(-13))).toEqual(['2026-01-10.db', '2026-01-09.db', '2026-01-08.db', '2026-01-07.db', '2026-01-06.db', '2026-01-05.db', '2026-01-04.db', '2026-01-02.db'])
  })
})

describe('KvState', () => {
  it('merges the stored object over the fallback, and ignores what is not an object', () => {
    const db = open(tmp())
    const s = db.state<{ a: number; b?: number }>('k', 0)
    expect(s.load({ a: 1 })).toEqual({ a: 1 })
    db.raw.prepare("INSERT INTO kv_state (key, value, updated_at) VALUES ('k', '{\"b\":2}', 0)").run()
    expect(s.load({ a: 1 })).toEqual({ a: 1, b: 2 })
    db.raw.prepare("UPDATE kv_state SET value = '[1,2]' WHERE key = 'k'").run()
    expect(s.load({ a: 1 })).toEqual({ a: 1 })
    db.raw.prepare("UPDATE kv_state SET value = 'nope' WHERE key = 'k'").run()
    expect(s.load({ a: 1 })).toEqual({ a: 1 })
  })

  it('writes the latest value once after the delay, or at once on flush', () => {
    vi.useFakeTimers()
    const db = open(tmp())
    const s = db.state<{ n: number }>('k', 1000)
    expect(db.state('k')).toBe(s)
    s.save({ n: 1 })
    s.save({ n: 2 })
    expect(kv(db, 'k')).toBeUndefined()
    expect(s.load({ n: 0 })).toEqual({ n: 2 })
    vi.advanceTimersByTime(1000)
    expect(kv(db, 'k')).toEqual({ n: 2 })
    s.save({ n: 3 })
    s.flush()
    expect(kv(db, 'k')).toEqual({ n: 3 })
  })

  it('keeps a failed write pending and writes it on the next flush', () => {
    const logged: string[] = []
    const dir = tmp()
    const db = WorkhubDb.open(join(dir, DB_FILE), { log: (m) => logged.push(m) })
    dbs.push(db)
    const s = db.state<{ n: number }>('k', 60_000)
    db.raw.exec('ALTER TABLE kv_state RENAME TO kv_state_away')
    s.save({ n: 1 })
    s.flush()
    expect(logged.join('\n')).toContain('could not write state k')
    db.raw.exec('ALTER TABLE kv_state_away RENAME TO kv_state')
    s.flush()
    expect(kv(db, 'k')).toEqual({ n: 1 })
  })

  it('writes what is pending on close and logs saves after it', () => {
    const dir = tmp()
    const logged: string[] = []
    const db = WorkhubDb.open(join(dir, DB_FILE), { log: (m) => logged.push(m) })
    const s = db.state<{ n: number }>('k', 60_000)
    s.save({ n: 7 })
    db.close()
    s.save({ n: 8 })
    s.flush()
    expect(logged.join('\n')).toContain('closed')
    expect(new KvState<{ n: number }>(open(dir), 'k').load({ n: 0 })).toEqual({ n: 7 })
  })
})

describe('SqlitePrEventStore', () => {
  it('round-trips the memory, and reads an unknown version as empty', async () => {
    const db = open(tmp())
    const store = new SqlitePrEventStore(db)
    expect(await store.load()).toEqual({ version: 1, profiles: {} })
    const state = { version: 1 as const, profiles: { work: { mine: { 'https://example.com/acme/shop/pull/1': { url: 'https://example.com/acme/shop/pull/1', title: 'Fix', name: 'shop#1' } as never }, seen: ['e1'] } } }
    await store.save(state)
    expect(await store.load()).toEqual(state)
    db.raw.prepare("UPDATE kv_state SET value = '{\"version\":2,\"profiles\":{}}' WHERE key = 'pr-events'").run()
    expect(await store.load()).toEqual({ version: 1, profiles: {} })
  })
})

describe('SqliteFlowMaps and SqliteFlowHistory', () => {
  it('stores, lists and removes maps', () => {
    const maps = new SqliteFlowMaps(open(tmp()))
    maps.put('b', '{"id":"b"}')
    maps.put('a', '{"id":"a"}')
    maps.put('a', '{"id":"a","name":"A"}')
    expect(maps.list().map((r) => r.id)).toEqual(['a', 'b'])
    expect(maps.get('a')).toContain('"A"')
    expect(maps.remove('a')).toBe(true)
    expect(maps.remove('a')).toBe(false)
  })

  it('reads a measure from a given hour on', () => {
    const now = Date.UTC(2026, 0, 15)
    const history = new SqliteFlowHistory(open(tmp()), () => now)
    const hours = [1, 2, 3].map((i) => ({ at: now - i * 3_600_000, count: i, failed: 0, latency: [] }))
    history.write('s', 'm', { hours, settledUntil: now, fetchedAt: now }, undefined, 0)
    expect(history.read('s', 'm', now - 2 * 3_600_000)?.hours.map((h) => h.count)).toEqual([2, 1])
    expect(history.read('s', 'other', 0)).toBeUndefined()
  })
})

describe('importLegacyJson', () => {
  const NOW = Date.UTC(2026, 0, 15)
  const run = (db: WorkhubDb, dir: string) => importLegacyJson(db, dir, () => {}, () => NOW)

  it('imports each state file under its base name, renames it to .migrated and removes temp leftovers', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'open-sessions.json'), JSON.stringify({ sessions: [{ id: 'a' }] }))
    writeFileSync(join(dir, 'token-spend.json'), JSON.stringify({ version: 1, files: {} }))
    writeFileSync(join(dir, 'pr-events.json'), JSON.stringify({ version: 1, profiles: {} }))
    writeFileSync(join(dir, 'open-sessions.json.123.abc.tmp'), '{')
    writeFileSync(join(dir, 'config.json'), '{"version":1}')
    writeFileSync(join(dir, 'secrets.json'), '{}')
    const db = open(dir)
    const summary = run(db, dir)
    expect(summary.imported.sort()).toEqual(['open-sessions.json', 'pr-events.json', 'token-spend.json'])
    expect(kv(db, 'open-sessions')).toEqual({ sessions: [{ id: 'a' }] })
    expect(kv(db, 'pr-events')).toEqual({ version: 1, profiles: {} })
    expect(legacyImportDone(db)).toBe(true)
    expect(readdirSync(dir).filter((n) => !n.startsWith(DB_FILE)).sort()).toEqual(['config.json', 'open-sessions.json.migrated', 'pr-events.json.migrated', 'secrets.json', 'token-spend.json.migrated'])
    expect(describeImport(summary)).toContain('imported 3')
  })

  it('stores what is imported in the main database file before renaming anything', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'planner-state.json'), JSON.stringify({ profiles: { work: {} } }))
    const db = open(dir)
    run(db, dir)
    // A plain reader of the main file (no write-ahead log) sees the rows: the checkpoint ran.
    const copy = join(tmp(), 'main-only.db')
    copyFileSync(join(dir, DB_FILE), copy)
    const reader = new DatabaseSync(copy, { readOnly: true })
    expect(reader.prepare("SELECT value FROM kv_state WHERE key = 'planner-state'").get()).toBeTruthy()
    reader.close()
  })

  it('skips what is not an object or already stored, renaming files to .skipped (never deleted) and broken ones to .corrupt', () => {
    const dir = tmp()
    const db = open(dir)
    db.state('session-names', 0).save({ names: { a: 'kept' } })
    db.flushAll()
    writeFileSync(join(dir, 'session-names.json'), JSON.stringify({ names: { a: 'old' } }))
    writeFileSync(join(dir, 'remote.json'), '[1, 2]')
    writeFileSync(join(dir, 'slack-state.json'), '{ broken')
    const summary = run(db, dir)
    expect(summary).toEqual({ imported: [], skipped: ['session-names.json', 'remote.json'], corrupt: ['slack-state.json'] })
    expect(kv(db, 'session-names')).toEqual({ names: { a: 'kept' } })
    expect(kv(db, 'remote')).toBeUndefined()
    expect(JSON.parse(readFileSync(join(dir, 'session-names.json.skipped'), 'utf8'))).toEqual({ names: { a: 'old' } })
    expect(readFileSync(join(dir, 'remote.json.skipped'), 'utf8')).toBe('[1, 2]')
    expect(readFileSync(join(dir, 'slack-state.json.corrupt'), 'utf8')).toBe('{ broken')
  })

  it('runs once: a later start imports nothing, and a file an older version wrote again is kept as .skipped', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'planner-state.json'), JSON.stringify({ profiles: { work: { inbox: ['first'] } } }))
    const db = open(dir)
    expect(run(db, dir).imported).toEqual(['planner-state.json'])
    expect(run(db, dir)).toEqual({ imported: [], skipped: [], corrupt: [] })
    expect(describeImport({ imported: [], skipped: [], corrupt: [] })).toBeNull()
    // A downgrade writes the file again (twice): the database keeps its rows, both files stay on disk.
    for (const item of ['downgrade-1', 'downgrade-2']) {
      writeFileSync(join(dir, 'planner-state.json'), JSON.stringify({ profiles: { work: { inbox: [item] } } }))
      writeFileSync(join(dir, 'kiro-usage.json'), JSON.stringify({ sessionId: item }))
      expect(run(db, dir)).toEqual({ imported: [], skipped: ['kiro-usage.json', 'planner-state.json'], corrupt: [] })
    }
    expect(kv(db, 'planner-state')).toEqual({ profiles: { work: { inbox: ['first'] } } })
    expect(kv(db, 'kiro-usage')).toBeUndefined()
    const kept = readdirSync(dir).filter((n) => n.startsWith('planner-state.json'))
    expect(kept.sort()).toEqual(['planner-state.json.migrated', 'planner-state.json.skipped', `planner-state.json.skipped-${NOW}`])
  })

  it('moves the flow maps folder into rows and renames it to flow-maps.migrated', () => {
    const dir = tmp()
    mkdirSync(join(dir, 'flow-maps'))
    writeFileSync(join(dir, 'flow-maps', 'checkout.json'), JSON.stringify({ version: 1, id: 'checkout', name: 'Checkout' }))
    writeFileSync(join(dir, 'flow-maps', 'named-differently.json'), JSON.stringify({ version: 1, id: 'orders' }))
    writeFileSync(join(dir, 'flow-maps', 'Checkout Flow.json'), JSON.stringify({ version: 1 }))
    writeFileSync(join(dir, 'flow-maps', 'broken.json'), '{ nope')
    const db = open(dir)
    const summary = run(db, dir)
    expect(summary.imported.sort()).toEqual(['flow-maps/Checkout Flow.json', 'flow-maps/checkout.json', 'flow-maps/named-differently.json'])
    expect(summary.corrupt).toEqual(['flow-maps/broken.json'])
    // A map without a usable id is stored under a slug of its file name, so it can be deleted.
    expect(new SqliteFlowMaps(db).list().map((r) => r.id)).toEqual(['checkout', 'checkout-flow', 'orders'])
    expect(flowMapIdFromFileName('Checkout Flow.json')).toBe('checkout-flow')
    expect(existsSync(join(dir, 'flow-maps'))).toBe(false)
    expect(readdirSync(join(dir, 'flow-maps.migrated')).sort()).toEqual(['Checkout Flow.json', 'broken.json.corrupt', 'checkout.json', 'named-differently.json'])
  })

  it('on a duplicate map id keeps <id>.json and leaves the other file as .skipped', () => {
    const dir = tmp()
    mkdirSync(join(dir, 'flow-maps'))
    writeFileSync(join(dir, 'flow-maps', 'a-copy.json'), JSON.stringify({ version: 1, id: 'orders', name: 'Copy' }))
    writeFileSync(join(dir, 'flow-maps', 'orders.json'), JSON.stringify({ version: 1, id: 'orders', name: 'Original' }))
    writeFileSync(join(dir, 'flow-maps', 'b.json'), JSON.stringify({ version: 1, id: 'pay', name: 'B' }))
    writeFileSync(join(dir, 'flow-maps', 'c.json'), JSON.stringify({ version: 1, id: 'pay', name: 'C' }))
    const db = open(dir)
    const summary = run(db, dir)
    expect(summary.skipped.sort()).toEqual(['flow-maps/a-copy.json', 'flow-maps/c.json'])
    const maps = new SqliteFlowMaps(db)
    expect(maps.get('orders')).toContain('Original')
    expect(maps.get('pay')).toContain('"B"')
    expect(readdirSync(join(dir, 'flow-maps.migrated')).sort()).toEqual(['a-copy.json.skipped', 'b.json', 'c.json.skipped', 'orders.json'])
  })

  it('a flow-maps folder that shows up after the import is not read, and is kept as flow-maps.skipped', () => {
    const dir = tmp()
    const db = open(dir)
    run(db, dir)
    mkdirSync(join(dir, 'flow-maps'))
    writeFileSync(join(dir, 'flow-maps', 'late.json'), JSON.stringify({ version: 1, id: 'late' }))
    expect(run(db, dir).skipped).toEqual(['flow-maps/late.json'])
    expect(new SqliteFlowMaps(db).list()).toEqual([])
    expect(readdirSync(join(dir, 'flow-maps.skipped'))).toEqual(['late.json.skipped'])
  })

  it('moves the flow history files into the history tables, within the retention', () => {
    const dir = tmp()
    mkdirSync(join(dir, 'flow-history'))
    const recent = { at: NOW - 3_600_000, count: 2, failed: 0, latency: [[27, 2]] }
    const ancient = { at: NOW - (FLOW_HISTORY_DAYS + 5) * DAY, count: 1, failed: 0, latency: [] }
    const file = { version: 1, measures: { 'tx|shop|POST /checkout': { hours: [ancient, recent], settledUntil: NOW - 3_600_000, fetchedAt: NOW } } }
    writeFileSync(join(dir, 'flow-history', 'abc123.json'), JSON.stringify(file))
    writeFileSync(join(dir, 'flow-history', 'old.json'), JSON.stringify({ version: 0 }))
    const db = open(dir)
    const summary = run(db, dir)
    expect(summary.imported).toEqual(['flow-history/abc123.json'])
    expect(summary.skipped).toEqual(['flow-history/old.json'])
    expect(new SqliteFlowHistory(db, () => NOW).read('abc123', 'tx|shop|POST /checkout', 0)).toEqual({ hours: [recent], settledUntil: NOW - 3_600_000, fetchedAt: NOW })
    expect(readdirSync(join(dir, 'flow-history.migrated')).sort()).toEqual(['abc123.json', 'old.json.skipped'])
    expect(run(db, dir)).toEqual({ imported: [], skipped: [], corrupt: [] })
  })
})
