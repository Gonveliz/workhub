import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import type { AutomationRun, PrEvent } from '@workhub/core'
import {
  ANALYTICS_TABLES,
  AutomationRunLog,
  DB_FILE,
  filterValues,
  MIGRATIONS,
  parseRunCursor,
  repoProjects,
  runCursor,
  schemaDescription,
  SessionRecords,
  sessionsTable,
  spendSeries,
  spendTotals,
  Timelines,
  transcriptSessionId,
  TurnIngest,
  UNKNOWN_ACCOUNT,
  weeklySummary,
  weekStartOf,
  WorkhubDb
} from '../src/sqlite-store'
import { claudeSpendLine, codexSpendLine, kiroSpendFile, TURN_IDLE_CAP_MS, type SpendTurn } from '../src/token-spend'

const dirs: string[] = []
const dbs: WorkhubDb[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wh-analytics-'))
  dirs.push(d)
  return d
}
const openDb = (dir = tmp()) => {
  const db = WorkhubDb.open(join(dir, DB_FILE), { log: () => {} })
  dbs.push(db)
  return db
}
const count = (db: WorkhubDb, table: string) => Number((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
const all = (db: WorkhubDb, sql: string, ...p: (string | number)[]) => db.raw.prepare(sql).all(...p) as Record<string, unknown>[]

const MIN = 60_000
const DAY = 86_400_000
const T0 = Date.parse('2026-10-26T09:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

const prompt = (at: number, cwd = '/w/acme', extra: object = {}) => JSON.stringify({ type: 'user', cwd, timestamp: iso(at), ...extra, message: { role: 'user', content: 'synthetic prompt' } })
const toolResult = (at: number, cwd = '/w/acme') => JSON.stringify({ type: 'user', cwd, timestamp: iso(at), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } })
const reply = (id: string, at: number, output: number, cwd = '/w/acme', extra: object = {}) =>
  JSON.stringify({ type: 'assistant', cwd, timestamp: iso(at), ...extra, message: { id, model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'synthetic' }], usage: { input_tokens: 10, output_tokens: output, cache_creation_input_tokens: 5, cache_read_input_tokens: 100 } } })
const lines = (...l: string[]) => l.join('\n') + '\n'

interface Home {
  claude: string
  codex: string
  kiro: string
}
function fakeHome(): Home {
  const root = tmp()
  const home = { claude: join(root, '.claude'), codex: join(root, '.codex'), kiro: join(root, '.kiro') }
  mkdirSync(join(home.claude, 'projects', '-w-acme'), { recursive: true })
  return home
}
const sources = (h: Home) => ({ claudeDirs: [h.claude], codexHomes: [h.codex], kiroDirs: [h.kiro] })
const claudeFile = (h: Home, name: string) => join(h.claude, 'projects', '-w-acme', name)
const codexLines = (id: string) =>
  [
    { timestamp: iso(T0), type: 'session_meta', payload: { id, cwd: '/w/web' } },
    { timestamp: iso(T0), type: 'turn_context', payload: { cwd: '/w/web', model: 'gpt-5' } },
    { timestamp: iso(T0 + MIN), type: 'event_msg', payload: { type: 'user_message', message: 'synthetic' } },
    { timestamp: iso(T0 + 3 * MIN), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } } } },
    { timestamp: iso(T0 + 4 * MIN), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } } } }
  ]
    .map((l) => JSON.stringify(l))
    .join('\n') + '\n'
const kiroSession = () =>
  JSON.stringify({
    cwd: '/w/tools',
    updated_at: iso(T0),
    session_state: { rts_model_state: { model_info: { model_id: 'auto' } }, conversation_metadata: { user_turn_metadatas: [{ input_token_count: 5, output_token_count: 2, end_timestamp: iso(T0 + MIN), turn_duration: { secs: 30, nanos: 0 } }] } }
  })

describe('migration 2', () => {
  it('creates the analytics tables with their indexes', () => {
    const db = openDb()
    expect(db.schemaVersion()).toBe(MIGRATIONS.at(-1)!.version)
    const tables = all(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t['name'])
    expect(tables).toEqual(expect.arrayContaining(['sessions', 'turns', 'turn_files', 'session_links', 'session_tags', 'automation_runs', 'pr_events', 'ticket_events']))
    const indexes = all(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").map((t) => t['name'])
    expect(indexes).toEqual(expect.arrayContaining(['turns_at', 'turns_project_at', 'turns_agent_key', 'sessions_project', 'session_links_ref', 'automation_runs_automation', 'pr_events_url', 'ticket_events_key']))
    expect(() => db.raw.prepare("INSERT INTO session_links (session_id, kind, ref, at) VALUES ('s', 'nope', 'r', 0)").run()).toThrow()
  })

  it('upgrades a version 1 database in place, keeping its state', () => {
    const dir = tmp()
    const v1 = WorkhubDb.open(join(dir, DB_FILE), { log: () => {}, migrations: MIGRATIONS.filter((m) => m.version === 1) })
    v1.raw.prepare("INSERT INTO kv_state (key, value, updated_at) VALUES ('k', '{}', 1)").run()
    v1.close()
    const db = openDb(dir)
    expect(db.schemaVersion()).toBe(MIGRATIONS.at(-1)!.version)
    expect(count(db, 'kv_state')).toBe(1)
    expect(count(db, 'turns_daily')).toBe(0)
  })

  it('describes every analytics table and column, with types, and lists what may be read', () => {
    const db = openDb()
    for (const table of schemaDescription()) {
      const columns = (db.raw.prepare(`PRAGMA table_info(${table.name})`).all() as { name: string; type: string }[]).map((c) => [c.name, c.type])
      expect(table.columns.map((c) => [c.name, c.type]).sort()).toEqual(columns.sort())
      expect(table.writer.length).toBeGreaterThan(5)
      expect(ANALYTICS_TABLES).toContain(table.name)
    }
    const usd = schemaDescription().find((t) => t.name === 'turns')!.columns.find((c) => c.name === 'usd')!
    expect(usd).toMatchObject({ unit: 'usd', nullable: expect.stringContaining('Kiro') })
    expect(ANALYTICS_TABLES).not.toContain('kv_state')
    expect(ANALYTICS_TABLES).not.toContain('schema_migrations')
  })

  it('describes every table an agent may read, and keeps local paths and prompts out', () => {
    const described = schemaDescription().map((t) => t.name)
    for (const table of ANALYTICS_TABLES) expect(described, table).toContain(table)
    expect(described).toHaveLength(ANALYTICS_TABLES.length)
    for (const hidden of ['turn_files', 'history_index', 'history_fts']) expect(ANALYTICS_TABLES).not.toContain(hidden)
  })
})

describe('parsers report turns', () => {
  it('Claude: one turn per message copy, the prompt starts its time, a sub-agent line has none', () => {
    const got: SpendTurn[] = []
    const state = {}
    for (const l of [prompt(T0), reply('m1', T0 + MIN, 1), reply('m1', T0 + 2 * MIN, 5), reply('s1', T0 + 3 * MIN, 2, '/w/acme', { isSidechain: true })]) claudeSpendLine(l, state, {}, '/h', undefined, undefined, (t) => got.push(t))
    expect(got.map((t) => [t.key, t.output, t.ms, t.sidechain ?? false])).toEqual([
      ['m1', 1, MIN, false],
      ['m1', 5, 2 * MIN, false],
      ['s1', 2, 0, true]
    ])
    expect(state).toMatchObject({ firstCwd: '/w/acme', firstPromptAt: T0 })
  })

  it('Codex: one turn per growth of the running totals', () => {
    const got: SpendTurn[] = []
    const state = {}
    for (const l of codexLines('x').trim().split('\n')) codexSpendLine(l, state, {}, undefined, undefined, (t) => got.push(t))
    expect(got.map((t) => [t.key, t.input, t.cacheRead, t.output, t.model, t.ms])).toEqual([['100:40:10', 60, 40, 10, 'gpt-5', 2 * MIN]])
  })

  it('Kiro: one turn per user turn, keyed by end time and index', () => {
    const got: SpendTurn[] = []
    kiroSpendFile(kiroSession(), {}, undefined, (t) => got.push(t))
    expect(got).toEqual([{ key: `${iso(T0 + MIN)}#0`, at: T0 + MIN, model: 'auto', input: 5, output: 2, cacheWrite: 0, cacheRead: 0, cwd: '/w/tools', ms: 30_000 }])
  })
})

describe('TurnIngest', () => {
  it('reads every agent into turns and sessions; sub-agents count tokens, not time', async () => {
    const h = fakeHome()
    writeFileSync(claudeFile(h, 'aaaa-1111.jsonl'), lines(prompt(T0), reply('m1', T0 + 2 * MIN, 1), reply('m1', T0 + 3 * MIN, 20), toolResult(T0 + 5 * MIN), reply('m2', T0 + 6 * MIN, 7, '/w/acme/api')))
    // A sub-agent ran inside m1's turn: its time must not add to the parent's.
    const sub = join(h.claude, 'projects', '-w-acme', 'aaaa-1111', 'subagents')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'agent-x.jsonl'), lines(prompt(T0 + MIN, '/w/acme', { isSidechain: true }), reply('s1', T0 + 2 * MIN, 3, '/w/acme', { isSidechain: true })))
    const codexDir = join(h.codex, 'sessions', '2026', '10', '26')
    mkdirSync(codexDir, { recursive: true })
    const codexId = '0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000'
    // A compressed rollout is read whole.
    writeFileSync(join(codexDir, `rollout-2026-10-26T09-00-00-${codexId}.jsonl.zst`), zstdCompressSync(Buffer.from(codexLines(codexId))))
    mkdirSync(join(h.kiro, 'sessions', 'cli'), { recursive: true })
    writeFileSync(join(h.kiro, 'sessions', 'cli', 'kiro-1.json'), kiroSession())
    const db = openDb()
    const logs: string[] = []
    const ingest = new TurnIngest(db, {
      log: (m) => logs.push(m),
      accountOf: (agent) => (agent === 'claude' ? 'work' : UNKNOWN_ACCOUNT),
      profileOf: (cwd) => (cwd.startsWith('/w/') ? 'p1' : null),
      projects: async (paths) => Object.fromEntries(paths.map((p) => [p, p.startsWith('/w/acme') ? '/w/acme' : p])),
      progressEvery: 1
    })
    expect(await ingest.scan(sources(h))).toMatchObject({ files: 4, read: 4, backfill: true })
    expect(logs.some((l) => l.includes('first scan done'))).toBe(true)
    const turns = all(db, 'SELECT session_id, agent, msg_key, output_tokens, turn_ms, sidechain, cwd, project FROM turns ORDER BY session_id, at')
    expect(turns.map((t) => `${t['session_id']}/${t['msg_key']}/${t['output_tokens']}/${t['sidechain']}`)).toEqual([codexId + '/100:40:10/10/0', 'aaaa-1111/s1/3/1', 'aaaa-1111/m1/20/0', 'aaaa-1111/m2/7/0', `kiro-1/${iso(T0 + MIN)}#0/2/0`])
    const byKey = Object.fromEntries(turns.map((t) => [t['msg_key'], t]))
    expect(byKey['m1']).toMatchObject({ turn_ms: 3 * MIN, project: '/w/acme' })
    expect(byKey['m2']).toMatchObject({ turn_ms: 3 * MIN, cwd: '/w/acme/api', project: '/w/acme' })
    expect(byKey['s1']).toMatchObject({ turn_ms: 0, sidechain: 1 })
    const claude = all(db, "SELECT * FROM sessions WHERE id = 'aaaa-1111'")[0]!
    expect(claude).toMatchObject({ agent: 'claude', account_id: 'work', profile_id: 'p1', cwd: '/w/acme', work_path: '/w/acme/api', project: '/w/acme', source: 'transcript', last_model: 'claude-sonnet-4-5' })
    expect(claude['active_ms']).toBe(6 * MIN)
    expect(claude['started_at']).toBe(T0)
    expect(claude['ended_at']).toBe(T0 + 6 * MIN)
    expect(all(db, `SELECT agent, account_id, last_model, cwd FROM sessions WHERE id = '${codexId}'`)[0]).toEqual({ agent: 'codex', account_id: UNKNOWN_ACCOUNT, last_model: 'gpt-5', cwd: '/w/web' })
    // The next scan is not a backfill.
    expect((await ingest.scan(sources(h))).backfill).toBe(false)
  })

  it('reads only what was appended, and never counts a turn twice when a file is read again', async () => {
    const h = fakeHome()
    const file = claudeFile(h, 'bbbb.jsonl')
    writeFileSync(file, lines(prompt(T0), reply('m1', T0 + MIN, 5)))
    const db = openDb()
    const ingest = new TurnIngest(db)
    await ingest.scan(sources(h))
    expect((await ingest.scan(sources(h))).read).toBe(0)
    appendFileSync(file, lines(reply('m1', T0 + 2 * MIN, 9), reply('m2', T0 + 3 * MIN, 4)) + '{"type":"assis')
    expect(await ingest.scan(sources(h))).toMatchObject({ read: 1, backfill: false })
    expect(all(db, 'SELECT msg_key, output_tokens FROM turns ORDER BY at')).toEqual([
      { msg_key: 'm1', output_tokens: 9 },
      { msg_key: 'm2', output_tokens: 4 }
    ])
    db.raw.prepare('DELETE FROM turn_files').run()
    await ingest.scan(sources(h))
    expect(count(db, 'turns')).toBe(2)
  })

  it('reads a rewritten file from the start, whether it kept its size or grew', async () => {
    const h = fakeHome()
    const file = claudeFile(h, 'cccc.jsonl')
    const first = lines(prompt(T0), reply('a1', T0 + MIN, 5))
    writeFileSync(file, first)
    const db = openDb()
    const ingest = new TurnIngest(db)
    await ingest.scan(sources(h))
    // Same size, other content (ids of equal length).
    writeFileSync(file, lines(prompt(T0), reply('b1', T0 + MIN, 5)))
    utimesSync(file, new Date(), new Date(Date.now() + 5_000))
    await ingest.scan(sources(h))
    expect(all(db, "SELECT msg_key FROM turns WHERE msg_key = 'b1'")).toHaveLength(1)
    // Larger, other content: resuming at the old offset would skip c1.
    writeFileSync(file, lines(prompt(T0), reply('c1', T0 + MIN, 5), reply('c2', T0 + 2 * MIN, 5)))
    await ingest.scan(sources(h))
    expect(all(db, "SELECT msg_key FROM turns WHERE msg_key IN ('c1', 'c2') ORDER BY msg_key").map((r) => r['msg_key'])).toEqual(['c1', 'c2'])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('records nothing for a file it cannot open, and reads it once it can', async () => {
    const h = fakeHome()
    const file = claudeFile(h, 'dddd.jsonl')
    writeFileSync(file, lines(prompt(T0), reply('m1', T0 + MIN, 5)))
    chmodSync(file, 0o000)
    const db = openDb()
    const ingest = new TurnIngest(db)
    expect((await ingest.scan(sources(h))).read).toBe(0)
    expect(count(db, 'turn_files')).toBe(0)
    chmodSync(file, 0o600)
    expect((await ingest.scan(sources(h))).read).toBe(1)
    expect(count(db, 'turns')).toBe(1)
  })

  it('counts a Claude message once when a forked session repeats it, and forgets deleted files', async () => {
    const h = fakeHome()
    writeFileSync(claudeFile(h, 'orig.jsonl'), lines(prompt(T0), reply('m1', T0 + MIN, 5)))
    utimesSync(claudeFile(h, 'orig.jsonl'), new Date(T0), new Date(T0))
    writeFileSync(claudeFile(h, 'fork.jsonl'), lines(prompt(T0), reply('m1', T0 + MIN, 5), prompt(T0 + 2 * MIN), reply('m9', T0 + 3 * MIN, 1)))
    const db = openDb()
    const ingest = new TurnIngest(db)
    await ingest.scan(sources(h))
    expect(all(db, 'SELECT session_id, msg_key FROM turns ORDER BY at')).toEqual([
      { session_id: 'orig', msg_key: 'm1' },
      { session_id: 'fork', msg_key: 'm9' }
    ])
    unlinkSync(claudeFile(h, 'fork.jsonl'))
    await ingest.scan(sources(h))
    expect(all(db, 'SELECT session_id FROM turn_files').map((r) => r['session_id'])).toEqual(['orig'])
    expect(count(db, 'turns')).toBe(2)
  })

  it('is a backfill until a first scan finished, even with no transcripts', async () => {
    const db = openDb()
    const ingest = new TurnIngest(db)
    const h = fakeHome()
    expect((await ingest.scan(sources(h))).backfill).toBe(true)
    expect((await ingest.scan(sources(h))).backfill).toBe(false)
  })

  it('caps the agent time of a turn after a long idle gap at 30 minutes', async () => {
    const h = fakeHome()
    writeFileSync(claudeFile(h, 'eeee.jsonl'), lines(prompt(T0), reply('m1', T0 + MIN, 1), reply('m2', T0 + 5 * 3_600_000, 1)))
    const db = openDb()
    await new TurnIngest(db).scan(sources(h))
    expect(all(db, 'SELECT turn_ms FROM turns ORDER BY at').map((r) => r['turn_ms'])).toEqual([MIN, TURN_IDLE_CAP_MS])
  })

  it('takes a worktree back to its repository, else the repository root, else the folder', async () => {
    const root = tmp()
    const repo = join(root, 'acme')
    mkdirSync(join(repo, '.git', 'worktrees', 'fix'), { recursive: true })
    mkdirSync(join(repo, 'api', 'src'), { recursive: true })
    const wt = join(root, 'acme-fix')
    mkdirSync(join(wt, 'web'), { recursive: true })
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'fix')}\n`)
    writeFileSync(join(repo, '.git', 'worktrees', 'fix', 'commondir'), '../..\n')
    const loose = join(root, 'notes')
    mkdirSync(loose)
    const got = await repoProjects([join(repo, 'api', 'src'), join(wt, 'web'), loose])
    expect(got).toEqual({ [join(repo, 'api', 'src')]: repo, [join(wt, 'web')]: repo, [loose]: loose })
  })

  it('names the session of each kind of transcript', () => {
    expect(transcriptSessionId('claude', '/c/projects/-w/abc.jsonl')).toBe('abc')
    expect(transcriptSessionId('claude', '/c/projects/-w/abc/subagents/agent-1.jsonl')).toBe('abc')
    expect(transcriptSessionId('codex', '/x/rollout-2026-10-26T09-00-00-0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000.jsonl.zst')).toBe('0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000')
    expect(transcriptSessionId('kiro', '/k/sessions/cli/k1.json')).toBe('k1')
  })
})

/** Inserts sessions and turns straight into the tables, for the queries. */
function seed(db: WorkhubDb) {
  const session = db.raw.prepare("INSERT INTO sessions (id, agent, account_id, profile_id, cwd, project, title, started_at, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'transcript', 0)")
  session.run('s1', 'claude', 'work', 'p1', '/w/acme', '/w/acme', 'Bravo', T0)
  session.run('s2', 'codex', null, 'p1', '/w/web', '/w/web', 'Alpha', T0)
  session.run('s3', 'claude', 'home', 'p2', '/w/other', '/w/other', 'Charlie', T0 + 8 * DAY)
  const turn = db.raw.prepare('INSERT INTO turns (session_id, agent, msg_key, at, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, usd, cwd, project, turn_ms, sidechain) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  turn.run('s1', 'claude', 'a', T0, 'opus', 100, 10, 1, 1000, 1.5, '/w/acme', '/w/acme', MIN, 0)
  turn.run('s1', 'claude', 'b', T0 + DAY, 'opus', 50, 5, 0, 500, 0.5, '/w/acme/api', '/w/acme', 2 * MIN, 0)
  turn.run('s1', 'claude', 'c', T0 + DAY, 'opus', 1, 1, 0, 0, 0.01, '/w/acme/api', '/w/acme', 0, 1)
  turn.run('s2', 'codex', 'a', T0, 'gpt-5', 20, 2, 0, 0, null, '/w/web', '/w/web', 3 * MIN, 0)
  turn.run('s3', 'claude', 'a', T0 + 8 * DAY, 'sonnet', 10, 1, 0, 0, 0.25, '/w/other', '/w/other', 4 * MIN, 0)
  const records = new SessionRecords(db, () => T0)
  records.addLinks('s1', [
    { kind: 'ticket', ref: 'ABC-1', source: 'user' },
    { kind: 'ticket', ref: 'ABC-2', source: 'reply' },
    { kind: 'pr', ref: 'https://example.com/acme/api/pull/7', source: 'acted' }
  ])
  records.addLinks('s2', [{ kind: 'ticket', ref: 'ABC-1' }])
  records.setTags('s2', ['Spike '])
}

const localDay = (ms: number) => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

describe('spendSeries', () => {
  it('sums per day and project, a project rolling up its sub-folders, sub-agents adding tokens but no time', () => {
    const db = openDb()
    seed(db)
    const rows = spendSeries(db, { since: T0 - DAY, until: T0 + 30 * DAY, bucket: 'day', groupBy: 'project' })
    expect(rows.map((r) => [r.bucketStart, r.group, r.tokensIn, r.usd, r.unpricedTokens, r.activeMs, r.turns])).toEqual([
      [localDay(T0), '/w/acme', 100, 1.5, 0, MIN, 1],
      [localDay(T0), '/w/web', 20, 0, 22, 3 * MIN, 1],
      [localDay(T0 + DAY), '/w/acme', 51, 0.51, 0, 2 * MIN, 2],
      [localDay(T0 + 8 * DAY), '/w/other', 10, 0.25, 0, 4 * MIN, 1]
    ])
  })

  it('groups by week, agent, model, account, ticket, PR, tag or nothing; linked groups fan out', () => {
    const db = openDb()
    seed(db)
    const q = (groupBy: Parameters<typeof spendSeries>[1]['groupBy']) => spendSeries(db, { since: 0, until: T0 + 30 * DAY, bucket: 'week', groupBy })
    const monday = weekStartOf(T0)
    const none = q('none')
    expect(none[0]).toMatchObject({ bucketStart: monday, group: null, turns: 4, sessions: 2, tokensIn: 171 })
    const tickets = q('ticket').filter((r) => r.bucketStart === monday)
    expect(tickets.map((r) => [r.group, r.turns])).toEqual([
      ['ABC-1', 4],
      ['ABC-2', 3]
    ])
    // Fan-out: a session with two tickets counts in both, so the groups add up to more than `none`.
    expect(tickets.reduce((a, r) => a + r.turns, 0)).toBeGreaterThan(none[0]!.turns)
    expect(q('agent').filter((r) => r.bucketStart === monday).map((r) => r.group)).toEqual(['claude', 'codex'])
    expect(q('model').map((r) => r.group)).toEqual(['opus', 'gpt-5', 'sonnet'])
    expect(q('account').map((r) => r.group)).toEqual(['work', null, 'home'])
    expect(q('pr').map((r) => r.group)).toEqual(['https://example.com/acme/api/pull/7', null, null])
    expect(q('tag').map((r) => r.group)).toEqual([null, 'spike', null])
    expect(() => spendSeries(db, { since: 0, until: 1, bucket: 'day', groupBy: 'toString' as never })).toThrow(/unknown grouping/)
  })

  it('filters by profile, folder, agent, account, model, ticket, PR and tag, values bound', () => {
    const db = openDb()
    seed(db)
    const turns = (filters: Parameters<typeof spendSeries>[1]['filters']) => spendSeries(db, { since: 0, until: T0 + 30 * DAY, bucket: 'week', groupBy: 'none', filters }).reduce((a, r) => a + r.turns, 0)
    expect(turns({ profileId: 'p1' })).toBe(4)
    expect(turns({ cwdPrefix: '/w/acme/' })).toBe(3)
    expect(turns({ cwdPrefix: '/w/ac' })).toBe(0)
    expect(turns({ cwdPrefix: '/w/acme/api' })).toBe(2)
    expect(turns({ agent: 'codex' })).toBe(1)
    expect(turns({ account: 'home' })).toBe(1)
    expect(turns({ model: 'opus' })).toBe(3)
    expect(turns({ ticket: 'ABC-1' })).toBe(4)
    expect(turns({ pr: 'https://example.com/acme/api/pull/7' })).toBe(3)
    expect(turns({ tag: 'spike' })).toBe(1)
    expect(turns({ agent: "claude' OR '1'='1" })).toBe(0)
    expect(turns({ cwdPrefix: '/w/%' })).toBe(0)
  })

  it('matches Windows folders with either separator, case as stored', () => {
    const db = openDb()
    db.raw.prepare("INSERT INTO sessions (id, agent, source, updated_at) VALUES ('w', 'codex', 'transcript', 0)").run()
    db.raw.prepare("INSERT INTO turns (session_id, agent, msg_key, at, cwd, project) VALUES ('w', 'codex', 'k', ?, 'C:\\w\\acme\\api', 'C:\\w\\acme')").run(T0)
    const turns = (cwdPrefix: string) => spendSeries(db, { since: 0, until: T0 + DAY, bucket: 'day', groupBy: 'none', filters: { cwdPrefix } }).reduce((a, r) => a + r.turns, 0)
    expect(turns('C:\\w\\acme')).toBe(1)
    expect(turns('C:\\w\\acme\\')).toBe(1)
    expect(turns('C:\\w')).toBe(1)
    expect(turns('C:\\w\\ac')).toBe(0)
    expect(turns('c:\\w\\acme')).toBe(0)
  })
})

describe('sessionsTable', () => {
  it('pages most recent first, totals under the same turn filters', () => {
    const db = openDb()
    seed(db)
    const first = sessionsTable(db, {}, { limit: 2 })
    expect(first.rows.map((r) => r.id)).toEqual(['s3', 's2'])
    const second = sessionsTable(db, {}, { limit: 2, cursor: first.nextCursor })
    expect(second.rows.map((r) => r.id)).toEqual(['s1'])
    expect(second.rows[0]).toMatchObject({ project: '/w/acme', tokensIn: 151, usd: 2.01, activeMs: 3 * MIN, turns: 3, tickets: ['ABC-1', 'ABC-2'], links: expect.arrayContaining([{ kind: 'pr', ref: 'https://example.com/acme/api/pull/7' }]) })
    expect(second.nextCursor).toBeNull()
    // Only the first day's turns count.
    const day = sessionsTable(db, { since: T0, until: T0 + 1 }, {})
    expect(day.rows.map((r) => [r.id, r.turns, r.usd, r.unpricedTokens])).toEqual([
      ['s2', 1, 0, 22],
      ['s1', 1, 1.5, 0]
    ])
    expect(sessionsTable(db, { profileId: 'p1', ticket: 'ABC-1' }).rows.map((r) => r.id).sort()).toEqual(['s1', 's2'])
    expect(sessionsTable(db, { model: 'gpt-5' }).rows.map((r) => r.id)).toEqual(['s2'])
  })

  it('sorts by spend, tokens, time or title, both ways', () => {
    const db = openDb()
    seed(db)
    const ids = (sort: 'usd' | 'tokens' | 'activeMs' | 'title', dir: 'asc' | 'desc') => sessionsTable(db, {}, { sort, dir }).rows.map((r) => r.id)
    expect(ids('usd', 'desc')).toEqual(['s1', 's3', 's2'])
    expect(ids('usd', 'asc')).toEqual(['s2', 's3', 's1'])
    expect(ids('tokens', 'desc')).toEqual(['s1', 's2', 's3'])
    expect(ids('activeMs', 'desc')).toEqual(['s3', 's2', 's1']) // s1 and s2 tie: the id breaks it
    expect(ids('title', 'asc')).toEqual(['s2', 's1', 's3'])
  })

  it('pages across sessions that started at the same time, each once', () => {
    const db = openDb()
    const insert = db.raw.prepare("INSERT INTO sessions (id, agent, started_at, source, updated_at) VALUES (?, 'claude', ?, 'transcript', 0)")
    for (let i = 0; i < 7; i++) insert.run(`t${i}`, T0)
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page = sessionsTable(db, {}, { limit: 3, cursor })
      seen.push(...page.rows.map((r) => r.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(seen).toEqual(['t6', 't5', 't4', 't3', 't2', 't1', 't0'])
  })
})

describe('weeklySummary', () => {
  it('sums a week per project, with PRs opened, merged, reviewed and ticket moves; any day snaps to Monday', () => {
    const db = openDb()
    seed(db)
    const timelines = new Timelines(db)
    const pr = (kind: string, at: number): PrEvent => ({ id: `acme/api#7|${kind}`, kind: kind as PrEvent['kind'], url: 'https://example.com/acme/api/pull/7', title: 'Add things', name: 'api#7', at })
    timelines.appendPrEvents('p1', [pr('opened', T0), pr('merged', T0 + DAY), { ...pr('reviewed', T0), id: 'acme/web#2|reviewed|1', url: 'https://example.com/acme/web/pull/2' }, pr('approved', T0 + 9 * DAY)])
    timelines.appendTicketChanges('p1', [{ kind: 'status', key: 'ABC-1', title: 'Fix', from: 'To do', to: 'Done' }], T0 + DAY)
    const week = weeklySummary(db, { profileId: 'p1', weekStart: T0 + 2 * DAY })
    expect(week.weekStart).toBe(weekStartOf(T0))
    expect(week).toMatchObject({ sessions: 2, activeMs: 6 * MIN })
    expect(week.projects.map((p) => [p.project, p.activeMs, p.sessions])).toEqual([
      ['/w/acme', 3 * MIN, 1],
      ['/w/web', 3 * MIN, 1]
    ])
    expect(week.tickets.map((t) => t.ref)).toEqual(['ABC-1', 'ABC-2'])
    expect(week.prsOpened.map((p) => p.number)).toEqual([7])
    expect(week.prsMerged.map((p) => p.url)).toEqual(['https://example.com/acme/api/pull/7'])
    expect(week.prsReviewed.map((p) => p.repo)).toEqual(['acme/web'])
    expect(week.ticketMoves).toEqual([{ key: 'ABC-1', from: 'To do', to: 'Done', title: 'Fix', at: T0 + DAY }])
    expect(() => weeklySummary(db, { weekStart: Number.NaN })).toThrow(/weekStart/)
  })
})

describe('records', () => {
  it('keeps the first stop time across renames, clears it on resume, and keeps the turns totals', () => {
    const db = openDb()
    const records = new SessionRecords(db, () => T0)
    const base = { id: 'w1', agent: 'claude', accountId: 'work', profileId: 'p1', cwd: '/w/acme', startedAt: T0 }
    records.upsertSession({ ...base, title: 'Synthetic task' })
    db.raw.prepare("INSERT INTO turns (session_id, agent, msg_key, at, turn_ms) VALUES ('w1', 'claude', 'a', ?, 1000)").run(T0 + MIN)
    records.upsertSession({ ...base, title: 'Synthetic task', endedAt: T0 + 2 * MIN })
    records.upsertSession({ ...base, title: 'Renamed', endedAt: T0 + 9 * MIN })
    expect(all(db, 'SELECT source, title, started_at, ended_at, active_ms FROM sessions')).toEqual([{ source: 'workhub', title: 'Renamed', started_at: T0, ended_at: T0 + 2 * MIN, active_ms: 1000 }])
    records.upsertSession({ ...base, endedAt: null })
    expect(all(db, 'SELECT ended_at FROM sessions')).toEqual([{ ended_at: null }])
  })

  it('moves early rows, links and tags to the agent session id', () => {
    const db = openDb()
    const records = new SessionRecords(db, () => T0)
    records.upsertSession({ id: 'early', agent: 'claude', accountId: null, profileId: 'p1', cwd: '/w/acme', startedAt: T0, title: 'Early' })
    records.addLinks('early', [{ kind: 'ticket', ref: 'ABC-1' }])
    records.setTags('early', ['idea'])
    records.rekey('early', 'agent-1')
    expect(all(db, 'SELECT id, title, source FROM sessions')).toEqual([{ id: 'agent-1', title: 'Early', source: 'workhub' }])
    expect(records.links('agent-1')).toEqual([{ kind: 'ticket', ref: 'ABC-1' }])
    expect(records.tags('agent-1')).toEqual(['idea'])
  })

  it('adds links once; tags are validated, for known sessions only', () => {
    const db = openDb()
    const records = new SessionRecords(db)
    db.raw.prepare("INSERT INTO sessions (id, agent, source, updated_at) VALUES ('s', 'claude', 'transcript', 0)").run()
    expect(records.addLinks('s', [{ kind: 'branch', ref: 'feat/x', source: 'git' }])).toBe(1)
    expect(records.addLinks('s', [{ kind: 'branch', ref: 'feat/x', source: 'git' }, { kind: 'worktree', ref: '/w/acme-x' }])).toBe(1)
    expect(records.setTags('s', ['  Big   Idea ', 'big idea', 'perf.v2'])).toEqual(['big idea', 'perf.v2'])
    expect(() => records.setTags('nope', ['x'])).toThrow(/unknown session/)
    expect(() => records.setTags('s', ['drop table;'])).toThrow(/invalid tag/)
    expect(() => records.setTags('s', [''])).toThrow(/invalid tag/)
    expect(() => records.setTags('s', Array.from({ length: 21 }, (_, i) => `t${i}`))).toThrow(/at most 20/)
    expect(records.tags('s')).toEqual(['big idea', 'perf.v2'])
  })

  it('logs every automation run and pages them with a cursor, ties included', () => {
    const db = openDb()
    const log = new AutomationRunLog(db)
    const run = (i: number, at: number): AutomationRun => ({ id: `r${String(i).padStart(2, '0')}`, automationId: 'a1', automationName: 'Nightly', trigger: 'interval', queuedAt: at, startedAt: at, outcome: 'ok', merged: 0 })
    // Five runs share one start time.
    const runs = [...Array.from({ length: 5 }, (_, i) => run(i, T0)), ...Array.from({ length: 5 }, (_, i) => run(i + 5, T0 + (i + 1) * MIN))]
    expect(log.record(runs, () => 'p1')).toBe(10)
    expect(log.record(runs, () => 'p1')).toBe(0)
    const seen: string[] = []
    let cursor: { startedAt: number; id: string } | undefined
    for (;;) {
      const page = log.list({ limit: 3, ...(cursor ? { cursor } : {}) })
      if (!page.length) break
      seen.push(...page.map((r) => r.id))
      cursor = parseRunCursor(runCursor(page.at(-1)!))!
    }
    expect(seen).toEqual(['r09', 'r08', 'r07', 'r06', 'r05', 'r04', 'r03', 'r02', 'r01', 'r00'])
    expect(parseRunCursor('not a cursor')).toBeNull()
    expect(log.list({ limit: 100, automationIds: ['other'] })).toEqual([])
  })

  it('appends PR events and ticket changes once; a repeated status change within 10 minutes is one', () => {
    const db = openDb()
    const timelines = new Timelines(db)
    const event: PrEvent = { id: 'acme/api#7|approved|sha|1', kind: 'approved', url: 'https://example.com/acme/api/pull/7', title: 'Add things', name: 'api#7', at: T0 }
    expect(timelines.appendPrEvents('p1', [event, { ...event, id: 'acme/api#7|merged', kind: 'merged', at: T0 + MIN }])).toBe(2)
    expect(timelines.appendPrEvents('p1', [event])).toBe(0)
    expect(timelines.prTimeline('acme/api', 7).map((e) => e.kind)).toEqual(['approved', 'merged'])
    const done = { kind: 'status' as const, key: 'ABC-1', title: 'Fix', from: 'To do', to: 'Done' }
    expect(timelines.appendTicketChanges('p1', [done], T0)).toBe(1)
    expect(timelines.appendTicketChanges('p1', [done], T0 + 5 * MIN)).toBe(0)
    expect(timelines.appendTicketChanges('p1', [done], T0 + 11 * MIN)).toBe(1)
    expect(timelines.appendTicketChanges('p1', [{ kind: 'left', key: 'ABC-1', title: 'Fix' }], T0 + 12 * MIN)).toBe(1)
    expect(timelines.ticketTimeline('ABC-1').map((e) => e.kind)).toEqual(['status', 'status', 'left'])
  })
})

describe('report totals, filter values and the sessions list agree', () => {
  /** A: two days, two tickets, a model switch; B: no turns; C: one turn in another project; D: outside the period. */
  function seedAgreement(db: WorkhubDb) {
    const session = db.raw.prepare("INSERT INTO sessions (id, agent, account_id, profile_id, cwd, project, title, started_at, source, updated_at) VALUES (?, ?, NULL, 'p1', ?, ?, ?, ?, 'workhub', 0)")
    session.run('A', 'claude', '/w/acme', '/w/acme', 'Two days', T0)
    session.run('B', 'claude', '/w/acme', '/w/acme', 'No turns yet', T0 + DAY)
    session.run('C', 'codex', '/w/web', '/w/web', 'One turn', T0)
    session.run('D', 'codex', '/w/web', '/w/web', 'Before', T0 - 10 * DAY)
    const turn = db.raw.prepare('INSERT INTO turns (session_id, agent, msg_key, at, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, usd, cwd, project, turn_ms, sidechain) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)')
    turn.run('A', 'claude', 'a', T0, 'sonnet', 100, 10, 0, 0, 1, '/w/acme', '/w/acme', MIN)
    turn.run('A', 'claude', 'b', T0 + DAY, 'opus', 200, 20, 0, 0, 2, '/w/acme/api', '/w/acme', 2 * MIN)
    turn.run('C', 'codex', 'a', T0, 'gpt-5', 50, 5, 0, 0, 0.5, '/w/web', '/w/web', 3 * MIN)
    turn.run('D', 'codex', 'a', T0 - 10 * DAY, 'gpt-5', 999, 9, 0, 0, 9, '/w/web', '/w/web', 9 * MIN)
    new SessionRecords(db, () => T0).addLinks('A', [
      { kind: 'ticket', ref: 'ABC-1', source: 'user' },
      { kind: 'ticket', ref: 'ABC-2', source: 'user' }
    ])
  }
  const period = { since: T0 - DAY, until: T0 + 3 * DAY }

  it('counts the same sessions, tokens and time in the tiles, the table, the chart and the list', () => {
    const db = openDb()
    seedAgreement(db)
    const [overall] = spendTotals(db, { ...period, groupBy: 'none' })
    expect(overall).toMatchObject({ sessions: 2, turns: 3, tokensIn: 350, usd: 3.5, activeMs: 6 * MIN })
    const byProject = spendTotals(db, { ...period, groupBy: 'project' })
    expect(byProject.reduce((a, r) => a + r.tokensIn, 0)).toBe(overall!.tokensIn)
    expect(spendSeries(db, { ...period, bucket: 'day', groupBy: 'project' }).reduce((a, r) => a + r.tokensIn, 0)).toBe(overall!.tokensIn)
    // Grouped by ticket, a session linked to two tickets counts in both: more than the total.
    expect(spendTotals(db, { ...period, groupBy: 'ticket' }).reduce((a, r) => a + r.tokensIn, 0)).toBe(300 * 2 + 50)
    const list = sessionsTable(db, period, { turnsOnly: true })
    expect(list.rows.map((r) => r.id).sort()).toEqual(['A', 'C'])
    expect(list.rows.reduce((a, r) => a + r.tokensIn, 0)).toBe(overall!.tokensIn)
    expect(list.rows.reduce((a, r) => a + r.activeMs, 0)).toBe(overall!.activeMs)
    // Without turnsOnly, a session with no turn yet still lists by its start (the default kept for other callers).
    expect(sessionsTable(db, period).rows.map((r) => r.id).sort()).toEqual(['A', 'B', 'C'])
  })

  it('applies the model and project filters to the turns, in totals and list alike', () => {
    const db = openDb()
    seedAgreement(db)
    const opus = { ...period, filters: { model: 'opus' } }
    const [t] = spendTotals(db, { ...opus, groupBy: 'none' })
    const list = sessionsTable(db, { ...period, model: 'opus' }, { turnsOnly: true })
    expect(list.rows.map((r) => [r.id, r.tokensIn, r.usd, r.activeMs])).toEqual([['A', t!.tokensIn, t!.usd, t!.activeMs]])
    expect(t!.tokensIn).toBe(200)
    expect(spendTotals(db, { ...period, groupBy: 'none', filters: { project: '/w/acme' } })[0]).toMatchObject({ tokensIn: 300, sessions: 1 })
    expect(spendTotals(db, { ...period, groupBy: 'none', filters: { project: '/w/acme/api' } })).toEqual([])
    expect(sessionsTable(db, { ...period, project: '/w/acme' }, { turnsOnly: true }).rows.map((r) => r.id)).toEqual(['A'])
  })

  it('lists the filter values of the period, most used first, optionally for one profile', () => {
    const db = openDb()
    seed(db)
    expect(filterValues(db)).toEqual({
      profiles: ['p1', 'p2'],
      projects: ['/w/acme', '/w/other', '/w/web'],
      agents: ['claude', 'codex'],
      accounts: ['work', 'home'],
      models: ['opus', 'gpt-5', 'sonnet'],
      tickets: ['ABC-1', 'ABC-2'],
      prs: ['https://example.com/acme/api/pull/7'],
      tags: ['spike']
    })
    expect(filterValues(db, { profileId: 'p2' })).toMatchObject({ profiles: ['p1', 'p2'], projects: ['/w/other'], agents: ['claude'], tickets: [], tags: [] })
    expect(filterValues(db, { since: T0 + 7 * DAY, until: T0 + 30 * DAY })).toMatchObject({ profiles: ['p2'], projects: ['/w/other'], models: ['sonnet'] })
    expect(() => spendTotals(db, { since: 0, until: 1, groupBy: 'nope' as never })).toThrow()
  })
})
