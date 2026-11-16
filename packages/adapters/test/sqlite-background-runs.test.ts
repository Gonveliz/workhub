import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BACKGROUND_AGENT, backgroundSessionId } from '@workhub/core'
import { BackgroundRuns, DB_FILE, spendGroups, WorkhubDb, type BackgroundRun } from '../src/sqlite-store'

const dirs: string[] = []
const dbs: WorkhubDb[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const openDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-background-'))
  dirs.push(dir)
  const db = WorkhubDb.open(join(dir, DB_FILE), { log: () => {} })
  dbs.push(db)
  return db
}
const count = (db: WorkhubDb, sql: string) => Number((db.raw.prepare(sql).get() as { n: number }).n)

const T0 = new Date(2026, 5, 10, 12, 0).getTime()
const DAY = 86_400_000
const run = (patch: Partial<BackgroundRun> = {}): BackgroundRun => ({
  id: 'run-1',
  kind: 'slackWatch',
  at: T0,
  durationMs: 4_000,
  accountId: null,
  usage: { model: 'claude-haiku-4-5', inputTokens: 3_000, outputTokens: 200, cacheWriteTokens: 500, cacheReadTokens: 300 },
  costUsd: 0.004,
  ...patch
})

describe('Workhub background runs as usage', () => {
  it('records a run as exactly one turn, and recording it again changes nothing', () => {
    const db = openDb()
    const runs = new BackgroundRuns(db)
    expect(runs.record(run())).toBe(true)
    expect(runs.record(run())).toBe(false)
    expect(count(db, 'SELECT COUNT(*) AS n FROM turns')).toBe(1)
    const turn = db.raw.prepare('SELECT * FROM turns').get() as Record<string, unknown>
    expect(turn).toMatchObject({ session_id: backgroundSessionId('slackWatch', null), agent: BACKGROUND_AGENT, msg_key: 'run-1', model: 'claude-haiku-4-5', input_tokens: 3_000, output_tokens: 200, cache_write_tokens: 500, cache_read_tokens: 300, usd: 0.004, cwd: null, turn_ms: 4_000 })
    const session = db.raw.prepare('SELECT * FROM sessions').get() as Record<string, unknown>
    expect(session).toMatchObject({ agent: BACKGROUND_AGENT, source: 'workhub', started_at: T0, ended_at: T0, last_model: 'claude-haiku-4-5' })
  })

  it('is grouped as its own agent in the reports', () => {
    const db = openDb()
    const runs = new BackgroundRuns(db)
    runs.record(run())
    runs.record(run({ id: 'run-2', kind: 'listenSummary', costUsd: 0.001 }))
    const rows = spendGroups(db, { since: T0 - DAY, until: T0 + DAY, groupBy: 'agent' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ group: BACKGROUND_AGENT, turns: 2, sessions: 2 })
    expect(rows[0]!.usd).toBeCloseTo(0.005)
  })

  it('sums a kind today and over the week', () => {
    const db = openDb()
    const runs = new BackgroundRuns(db)
    runs.record(run())
    runs.record(run({ id: 'run-2', at: T0 - 3 * DAY, accountId: 'work' }))
    runs.record(run({ id: 'run-3', kind: 'listenSummary' }))
    // A run that ended before any result: counted as a read, with no tokens and no price.
    runs.record(run({ id: 'run-4', at: T0 + 1_000, usage: undefined, costUsd: undefined }))
    const summary = runs.summary('slackWatch', T0 - 60_000, T0 - 6 * DAY)
    expect(summary.today).toEqual({ runs: 2, tokens: 4_000, usd: 0.004 })
    expect(summary.week.runs).toBe(3)
    expect(summary.week.tokens).toBe(8_000)
    expect(runs.total(T0 - 60_000).runs).toBe(3)
  })
})
