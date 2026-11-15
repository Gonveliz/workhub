import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import { SessionRecords, type WorkhubDb } from '@workhub/adapters/sqlite-store'
import { MAX_RANGE_MS, parseFilters, parseSessionsQuery, parseSpendQuery, registerAnalyticsIpc } from '../src/main/analytics-ipc'
import { REMOTE_INVOKES } from '../src/main/remote'
import { openTestDb } from './test-db'

const DAY = 86_400_000
const T0 = Date.parse('2026-11-10T12:00:00.000Z')

function seed(db: WorkhubDb): void {
  const session = db.raw.prepare("INSERT INTO sessions (id, agent, account_id, profile_id, cwd, title, started_at, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'workhub', 0)")
  session.run('s1', 'claude', null, 'p1', '/w/acme-api', 'Fix login', T0)
  session.run('s2', 'codex', 'work', 'p1', '/w/acme-web', 'Spike', T0 + DAY)
  const turn = db.raw.prepare("INSERT INTO turns (session_id, agent, msg_key, at, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, usd, cwd, project, turn_ms, sidechain) VALUES (?, 'claude', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)")
  turn.run('s1', 'a', T0, 'sonnet', 1000, 200, 0, 5000, 0.5, '/w/acme-api', '/w/acme-api', 60_000)
  turn.run('s2', 'a', T0 + DAY, 'gpt-5', 400, 100, 0, 0, 0.25, '/w/acme-web', '/w/acme-web', 120_000)
  new SessionRecords(db, () => T0).addLinks('s1', [{ kind: 'ticket', ref: 'ABC-123', source: 'user' }])
}

function setup(extra: { scan?: () => Promise<void>; refreshCapMs?: number } = {}) {
  const db = openTestDb()
  seed(db)
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  registerAnalyticsIpc({ handle: (c, h) => void handlers.set(c, h), on: () => undefined }, { db, records: new SessionRecords(db, () => T0), ...extra })
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as IpcMainInvokeEvent, ...args)
  return { handlers, invoke }
}

const period = { since: T0 - DAY, until: T0 + 7 * DAY }

describe('analytics IPC', () => {
  it('registers every report channel, none of them offered to paired devices', () => {
    const { handlers } = setup()
    const channels = ['analytics:tags', 'analytics:setTags', 'analytics:spend', 'analytics:totals', 'analytics:sessions', 'analytics:weekly', 'analytics:filters', 'analytics:refresh']
    expect([...handlers.keys()].sort()).toEqual([...channels].sort())
    for (const c of channels) expect(REMOTE_INVOKES[c], c).toBeUndefined()
  })

  it('refresh runs the transcript scan and waits for it, at most the cap; a failed scan still resolves', async () => {
    let scanned = false
    const { invoke } = setup({ scan: async () => void (await new Promise((r) => setTimeout(r, 20)), (scanned = true)) })
    await expect(invoke('analytics:refresh')).resolves.toBeUndefined()
    expect(scanned).toBe(true)
    const slow = setup({ scan: () => new Promise<void>(() => undefined), refreshCapMs: 30 })
    const started = Date.now()
    await slow.invoke('analytics:refresh')
    expect(Date.now() - started).toBeLessThan(1000)
    await expect(setup({ scan: () => Promise.reject(new Error('disk')) }).invoke('analytics:refresh')).resolves.toBeUndefined()
    await expect(setup().invoke('analytics:refresh')).resolves.toBeUndefined()
  })

  it('answers spend, totals, sessions, weekly and filter values for valid queries', () => {
    const { invoke } = setup()
    const spend = invoke('analytics:spend', { ...period, bucket: 'day', groupBy: 'project' }) as { group: string; turns: number }[]
    expect(spend.map((r) => [r.group, r.turns])).toEqual([
      ['/w/acme-api', 1],
      ['/w/acme-web', 1]
    ])
    const totals = invoke('analytics:totals', { ...period, groupBy: 'ticket', filters: { profileId: 'p1', agent: '' } }) as { group: string | null; usd: number }[]
    expect(totals).toEqual([expect.objectContaining({ group: 'ABC-123', usd: 0.5 }), expect.objectContaining({ group: null, usd: 0.25 })])
    const page = invoke('analytics:sessions', { since: period.since, agent: 'codex', limit: 10 }) as { rows: { id: string }[] }
    expect(page.rows.map((r) => r.id)).toEqual(['s2'])
    const week = invoke('analytics:weekly', { weekStart: T0, profileId: 'p1' }) as { sessions: number }
    expect(week.sessions).toBe(2)
    expect(invoke('analytics:filters', {})).toMatchObject({ agents: ['claude', 'codex'], tickets: ['ABC-123'], accounts: ['work'] })
    expect(invoke('analytics:filters', { profileId: 'p2' })).toMatchObject({ profiles: ['p1'], projects: [] })
    // Bounded to a period that holds nothing: only the profiles stay (the profile menu is never scoped).
    expect(invoke('analytics:filters', { since: 0, until: 1000 })).toMatchObject({ agents: [], tickets: [] })
  })

  it('refuses malformed queries instead of guessing', () => {
    const { invoke } = setup()
    const bad: unknown[] = [
      null,
      'spend',
      { ...period, bucket: 'month', groupBy: 'project' },
      { ...period, bucket: 'day', groupBy: 'project; DROP TABLE turns' },
      { since: period.until, until: period.since, bucket: 'day', groupBy: 'agent' },
      { since: 0, until: MAX_RANGE_MS + 1, bucket: 'week', groupBy: 'agent' },
      { since: Number.NaN, until: 1, bucket: 'day', groupBy: 'agent' },
      { ...period, bucket: 'day', groupBy: 'agent', filters: { agent: 7 } },
      { ...period, bucket: 'day', groupBy: 'agent', filters: ['agent'] },
      { ...period, bucket: 'day', groupBy: 'agent', filters: { model: 'x'.repeat(3000) } }
    ]
    for (const q of bad) expect(() => invoke('analytics:spend', q), JSON.stringify(q)?.slice(0, 80)).toThrow(/Invalid analytics query/)
    expect(() => invoke('analytics:sessions', { limit: 0 })).toThrow()
    expect(() => invoke('analytics:sessions', { since: 'yesterday' })).toThrow()
    expect(() => invoke('analytics:weekly', { weekStart: -5 })).toThrow()
    expect(() => invoke('analytics:weekly', { weekStart: T0, profileId: 42 })).toThrow()
    expect(() => invoke('analytics:sessions', { turnsOnly: 'yes' })).toThrow(/turnsOnly/)
    expect(() => invoke('analytics:filters', { since: T0 })).toThrow(/period/)
    expect(() => invoke('analytics:filters', { profileId: 42 })).toThrow(/profileId/)
  })

  it('keeps only known filter keys and drops empty ones', () => {
    expect(parseFilters({ agent: 'claude', cwdPrefix: '', tag: null, extra: 'x' })).toEqual({ agent: 'claude' })
    expect(parseSpendQuery({ ...period, bucket: 'week', groupBy: 'none' })).toEqual({ ...period, bucket: 'week', groupBy: 'none', filters: {} })
    expect(parseSessionsQuery({ tag: 'spike', cursor: null, other: 1 })).toEqual({ tag: 'spike' })
    expect(parseSessionsQuery({ tag: 'spike', turnsOnly: true })).toEqual({ tag: 'spike', turnsOnly: true })
  })

  it('reads and replaces tags, refusing anything that is not a tag list', () => {
    const { invoke } = setup()
    expect(invoke('analytics:setTags', 's1', ['Spike ', 'spike', 'Client  A'])).toEqual(['client a', 'spike'])
    expect(invoke('analytics:tags', 's1')).toEqual(['client a', 'spike'])
    expect(() => invoke('analytics:setTags', 's1', 'spike')).toThrow(/list of strings/)
    expect(() => invoke('analytics:setTags', 's1', ['ok', 3])).toThrow(/list of strings/)
    expect(() => invoke('analytics:setTags', '', ['x'])).toThrow(/session id/)
    expect(() => invoke('analytics:setTags', 'nobody', ['x'])).toThrow(/unknown session/)
    // A refused call leaves the stored tags as they were.
    expect(invoke('analytics:tags', 's1')).toEqual(['client a', 'spike'])
    expect(invoke('analytics:filters', {})).toMatchObject({ tags: ['client a', 'spike'] })
  })

})
