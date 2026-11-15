import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { DB_FILE, WorkhubDb } from '@workhub/adapters/sqlite-store'

const opened: { db: WorkhubDb; dir: string }[] = []

// Every test file that opens a database through here closes it and removes its folder afterwards.
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A fresh database in a temp folder, as the app opens it; closed and removed after the test. */
export function openTestDb(): WorkhubDb {
  const dir = mkdtempSync(join(tmpdir(), 'wh-test-db-'))
  const db = WorkhubDb.open(join(dir, DB_FILE), { log: () => {} })
  opened.push({ db, dir })
  return db
}

/** The JSON stored under a `kv_state` key, parsed; undefined when there is none. */
export function storedState(db: WorkhubDb, key: string): unknown {
  const row = db.raw.prepare('SELECT value FROM kv_state WHERE key = ?').get(key) as { value: string } | undefined
  return row ? (JSON.parse(row.value) as unknown) : undefined
}
