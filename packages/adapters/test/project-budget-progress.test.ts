import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { monthBounds, projectProgress, projectSpendOf } from '@workhub/core'
import { DB_FILE, spendTotals, WorkhubDb } from '../src/sqlite-store'

const dirs: string[] = []
const dbs: WorkhubDb[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const openDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'wh-budget-'))
  dirs.push(dir)
  const db = WorkhubDb.open(join(dir, DB_FILE), { log: () => {} })
  dbs.push(db)
  return db
}

const HOUR = 3_600_000
const NOW = new Date(2026, 10, 15, 12).getTime()
const at = (m: number, d: number, h = 10) => new Date(2026, m - 1, d, h).getTime()

const turn = (db: WorkhubDb, key: string, when: number, project: string | null, usd: number | null, input = 100, output = 10, write = 5) =>
  db.raw
    .prepare('INSERT INTO turns (session_id, agent, msg_key, at, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, usd, cwd, project, turn_ms, sidechain) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)')
    .run('s1', 'claude', key, when, usd === null ? 'unknown' : 'sonnet', input, output, write, 1000, usd, `${project ?? '/w/loose'}/api`, project, 60_000)

/** A daily summary standing for `turns` turns of one day (what the retention job writes). */
const summary = (db: WorkhubDb, when: number, project: string, usd: number | null, turns: number, input: number, output: number, write: number) =>
  db.raw
    .prepare(
      'INSERT INTO turns_daily (day, session_id, agent, model, cwd, project, priced, at, last_at, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, usd, turn_ms, turns) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(new Date(when).setHours(0, 0, 0, 0), 's1', 'claude', usd === null ? 'unknown' : 'sonnet', `${project}/api`, project, usd === null ? 0 : 1, when, when + HOUR, input, output, write, 0, usd, 0, turns)

function month(db: WorkhubDb, now = NOW) {
  const m = monthBounds(now)
  return spendTotals(db, { since: m.since, until: m.until, groupBy: 'project' })
}

describe('project budget progress over detail and daily summaries', () => {
  it('adds the month`s detail turns and daily summaries of the same project, and nothing outside the month', () => {
    const db = openDb()
    turn(db, 'a', at(11, 2), '/w/acme', 2.5)
    turn(db, 'b', at(11, 14), '/w/acme', 1.25)
    summary(db, at(11, 5), '/w/acme', 4, 3, 300, 30, 15)
    // Outside the month: the day before it starts and the first day of the next one.
    turn(db, 'c', at(10, 31, 23), '/w/acme', 100)
    summary(db, at(12, 1), '/w/acme', 100, 1, 1000, 1000, 1000)
    // Another project.
    turn(db, 'd', at(11, 3), '/w/other', 9)

    const acme = month(db).find((r) => r.group === '/w/acme')!
    expect(acme.usd).toBe(7.75)
    expect(acme.turns).toBe(5)
    const spend = projectSpendOf(acme)
    expect(spend).toEqual({ usd: 7.75, tokens: 100 * 2 + 10 * 2 + 5 * 2 + 300 + 30 + 15, unpricedTokens: 0 })

    const p = projectProgress({ usd: 10, tokens: 1000 }, spend)
    expect(p.usdPercent).toBeCloseTo(77.5)
    expect(p.tokensPercent).toBeCloseTo(57.5)
    expect(p.state).toBe('ok')
    expect(projectProgress({ usd: 9.5 }, spend).state).toBe('warn')
    expect(projectProgress({ usd: 7 }, spend).state).toBe('over')
  })

  it('matches the same spend held entirely as detail, so a project does not jump when its days are summarized', () => {
    const whole = openDb()
    turn(whole, 'a', at(11, 5), '/w/acme', 1)
    turn(whole, 'b', at(11, 5, 11), '/w/acme', 3)
    turn(whole, 'c', at(11, 5, 12), '/w/acme', 0.5)
    const rolled = openDb()
    summary(rolled, at(11, 5), '/w/acme', 4.5, 3, 300, 30, 15)
    const a = projectSpendOf(month(whole)[0]!)
    const b = projectSpendOf(month(rolled)[0]!)
    expect(b).toEqual(a)
    expect(projectProgress({ usd: 9, tokens: 1000 }, b)).toEqual(projectProgress({ usd: 9, tokens: 1000 }, a))
  })

  it('keeps the tokens of unpriced turns apart: in the tokens, in no dollar', () => {
    const db = openDb()
    turn(db, 'a', at(11, 4), '/w/acme', 2, 100, 10, 0)
    turn(db, 'b', at(11, 4, 11), '/w/acme', null, 1000, 100, 0)
    const spend = projectSpendOf(month(db)[0]!)
    expect(spend.usd).toBe(2)
    expect(spend.tokens).toBe(1210)
    expect(spend.unpricedTokens).toBe(1000 + 100 + 0 + 1000)
  })

  it('groups a turn with no resolved project by its folder, the key the Usage screen uses', () => {
    const db = openDb()
    turn(db, 'a', at(11, 4), null, 1)
    expect(month(db)[0]?.group).toBe('/w/loose/api')
  })
})
