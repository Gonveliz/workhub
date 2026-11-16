import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it } from 'vitest'
import { runAnalyticsReport, SessionRecords, type AnalyticsReport, type WorkhubDb } from '@workhub/adapters/sqlite-store'
import { registerAnalyticsIpc } from '../src/main/analytics-ipc'
import { AnalyticsQueries, forkQueryWorker, ReportTimedOut, type QueryWorker } from '../src/main/analytics-queries'
import type { WorkerInit, WorkerQuery, WorkerReply, WorkerReport } from '../src/main/analytics-worker'
import { openTestDb } from './test-db'

const DAY = 86_400_000
const T0 = Date.parse('2026-11-10T12:00:00.000Z')
const period = { since: T0 - DAY, until: T0 + 7 * DAY }

function seed(db: WorkhubDb): void {
  const session = db.raw.prepare("INSERT INTO sessions (id, agent, profile_id, cwd, title, started_at, source, updated_at) VALUES (?, ?, 'p1', ?, ?, ?, 'workhub', 0)")
  session.run('s1', 'claude', '/w/acme-api', 'Fix login', T0)
  session.run('s2', 'codex', '/w/acme-web', 'Spike', T0 + DAY)
  const turn = db.raw.prepare("INSERT INTO turns (session_id, agent, msg_key, at, model, input_tokens, output_tokens, usd, cwd, project, turn_ms, sidechain) VALUES (?, ?, 'a', ?, ?, 100, 10, ?, ?, ?, 60000, 0)")
  turn.run('s1', 'claude', T0, 'sonnet', 0.5, '/w/acme-api', '/w/acme-api')
  turn.run('s2', 'codex', T0 + DAY, 'gpt-5', 0.25, '/w/acme-web', '/w/acme-web')
  new SessionRecords(db, () => T0).addLinks('s1', [{ kind: 'ticket', ref: 'PAY-123', source: 'user' }])
}

/** A worker that answers from a script: each message gets what `answer` returns (nothing: no answer). */
function fakeWorker(answer: (msg: WorkerInit | WorkerQuery | WorkerReport) => WorkerReply | undefined, ready: { authorizer: boolean } = { authorizer: true }) {
  const sent: (WorkerInit | WorkerQuery | WorkerReport)[] = []
  let spawned = 0
  let killed = 0
  let exit: (code: number | null) => void = () => undefined
  const spawn = (): QueryWorker => {
    spawned++
    let reply: (m: WorkerReply) => void = () => undefined
    return {
      post: (m) => {
        sent.push(m)
        const out = m.type === 'init' ? { type: 'ready' as const, ...ready } : answer(m)
        if (out) queueMicrotask(() => reply(out))
      },
      onMessage: (fn) => (reply = fn),
      onExit: (fn) => (exit = fn),
      kill: () => void killed++
    }
  }
  return { spawn, sent, spawned: () => spawned, killed: () => killed, exit: (code: number | null) => exit(code) }
}

describe('usage report IPC routing', () => {
  function setup() {
    const db = openTestDb()
    seed(db)
    const routed: AnalyticsReport[] = []
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
    const records = { tags: () => ['x'], setTags: (_id: string, tags: string[]) => tags }
    registerAnalyticsIpc(
      { handle: (c, h) => void handlers.set(c, h), on: () => undefined },
      { db, records, scan: async () => undefined, reports: async (r) => (routed.push(r), { from: 'worker', name: r.name }) }
    )
    const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as IpcMainInvokeEvent, ...args)
    return { routed, invoke }
  }

  it('sends each report channel to the worker by name, with the checked arguments', async () => {
    const { routed, invoke } = setup()
    expect(await invoke('analytics:spend', { ...period, bucket: 'day', groupBy: 'agent', filters: { model: 'sonnet', junk: 'x' } })).toEqual({ from: 'worker', name: 'spend' })
    await invoke('analytics:totals', { ...period, groupBy: 'none' })
    await invoke('analytics:sessions', { ...period, agent: 'claude', limit: 10, turnsOnly: true })
    await invoke('analytics:weekly', { weekStart: T0, profileId: 'p1' })
    await invoke('analytics:filters', { profileId: 'p1', ...period })
    expect(routed).toEqual([
      { name: 'spend', query: { ...period, bucket: 'day', groupBy: 'agent', filters: { model: 'sonnet' } } },
      { name: 'totals', query: { ...period, groupBy: 'none', filters: {} } },
      { name: 'sessions', filters: { agent: 'claude', ...period }, page: { limit: 10, cursor: undefined, turnsOnly: true } },
      { name: 'weekly', query: { weekStart: T0, profileId: 'p1' } },
      { name: 'filters', query: { profileId: 'p1', ...period } }
    ])
  })

  it('refuses a malformed query before it reaches the worker', () => {
    const { routed, invoke } = setup()
    expect(() => invoke('analytics:spend', { ...period, bucket: 'hour', groupBy: 'agent' })).toThrow(/bucket/)
    expect(() => invoke('analytics:weekly', {})).toThrow(/weekStart/)
    expect(routed).toEqual([])
  })

  it('keeps the tags and Refresh on the main process', async () => {
    const { routed, invoke } = setup()
    expect(await invoke('analytics:tags', 's1')).toEqual(['x'])
    expect(await invoke('analytics:setTags', 's1', ['a'])).toEqual(['a'])
    await invoke('analytics:refresh')
    expect(routed).toEqual([])
  })

  it('a worker that fails reaches the screen as a rejected call', async () => {
    const db = openTestDb()
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
    registerAnalyticsIpc({ handle: (c, h) => void handlers.set(c, h), on: () => undefined }, { db, records: new SessionRecords(db), reports: () => Promise.reject(new ReportTimedOut(30_000)) })
    await expect(handlers.get('analytics:totals')!({} as IpcMainInvokeEvent, { ...period, groupBy: 'none' }) as Promise<unknown>).rejects.toThrow(/took longer than 30 s/)
  })
})

describe('AnalyticsQueries.report with a fake worker', () => {
  const spend: AnalyticsReport = { name: 'totals', query: { ...period, groupBy: 'none', filters: {} } }

  it('posts a named report (no SQL) and resolves with its value', async () => {
    const w = fakeWorker((m) => (m.type === 'report' ? { type: 'report', id: m.id, value: [{ usd: 1 }] } : undefined))
    const queries = new AnalyticsQueries({ spawn: w.spawn, path: '/tmp/none.db' })
    expect(await queries.report(spend)).toEqual([{ usd: 1 }])
    expect(w.sent.map((m) => m.type)).toEqual(['init', 'report'])
    expect(w.sent[1]).toEqual({ type: 'report', id: 1, report: spend })
  })

  it('rejects with the worker error', async () => {
    const w = fakeWorker((m) => ({ type: 'error', id: (m as WorkerReport).id, message: 'no such table: turns' }))
    await expect(new AnalyticsQueries({ spawn: w.spawn, path: '/tmp/none.db' }).report(spend)).rejects.toThrow('no such table: turns')
  })

  it('kills the worker past the budget, rejects, and the next report starts a new process', async () => {
    let first = true
    const w = fakeWorker((m) => {
      if (m.type !== 'report') return undefined
      if (first) return void (first = false)
      return { type: 'report', id: m.id, value: 'ok' }
    })
    const logs: string[] = []
    const queries = new AnalyticsQueries({ spawn: w.spawn, path: '/tmp/none.db', budgetMs: 50, log: (l) => logs.push(l) })
    await expect(queries.report(spend)).rejects.toBeInstanceOf(ReportTimedOut)
    expect(w.killed()).toBe(1)
    expect(logs.join('\n')).toMatch(/report totals stopped after 50 ms/)
    expect(await queries.report(spend)).toBe('ok')
    expect(w.spawned()).toBe(2)
  })

  it('runs one at a time: a later report waits for the one before it', async () => {
    const order: number[] = []
    const w = fakeWorker((m) => {
      if (m.type !== 'report') return undefined
      order.push(m.id)
      return { type: 'report', id: m.id, value: m.id }
    })
    const queries = new AnalyticsQueries({ spawn: w.spawn, path: '/tmp/none.db' })
    expect(await Promise.all([queries.report(spend), queries.report(spend), queries.report(spend)])).toEqual([1, 2, 3])
    expect(order).toEqual([1, 2, 3])
  })

  it('rejects when the worker dies', async () => {
    const w = fakeWorker(() => undefined)
    const queries = new AnalyticsQueries({ spawn: w.spawn, path: '/tmp/none.db' })
    const pending = queries.report(spend)
    await new Promise((r) => setTimeout(r, 0))
    w.exit(9)
    await expect(pending).rejects.toThrow(/stopped \(exit code 9\)/)
  })

  it('still runs reports where the worker has no authorizer (their SQL is fixed)', async () => {
    const w = fakeWorker((m) => (m.type === 'report' ? { type: 'report', id: m.id, value: 'ran' } : { type: 'error', id: (m as WorkerQuery).id, message: 'read-only guard unavailable' }), { authorizer: false })
    const queries = new AnalyticsQueries({ spawn: w.spawn, path: '/tmp/none.db' })
    expect(await queries.report(spend)).toBe('ran')
    await expect(queries.run('SELECT 1', [], 10, [])).rejects.toThrow(/read-only guard unavailable/)
  })
})

const WORKER = resolve(__dirname, '../src/main/analytics-worker.ts')
/** Electron's binary as Node, where this Node cannot run the worker's TypeScript (no type stripping). */
const ELECTRON = ((): string | undefined => {
  try {
    const path: unknown = createRequire(import.meta.url)('electron')
    return typeof path === 'string' && existsSync(path) ? path : undefined
  } catch {
    return undefined
  }
})()
const STRIPS_TYPES = Number(process.versions.node.split('.')[0]) >= 23

describe.skipIf(!STRIPS_TYPES && !ELECTRON)('the real worker', () => {
  const opened: AnalyticsQueries[] = []
  afterEach(() => {
    for (const q of opened.splice(0)) q.close()
  })

  it('answers every report as the main process would', async () => {
    const db = openTestDb()
    seed(db)
    const queries = new AnalyticsQueries({ spawn: forkQueryWorker(WORKER, STRIPS_TYPES ? {} : { execPath: ELECTRON!, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }), path: db.path, budgetMs: 10_000 })
    opened.push(queries)
    const reports: AnalyticsReport[] = [
      { name: 'spend', query: { ...period, bucket: 'day', groupBy: 'ticket', filters: {} } },
      { name: 'totals', query: { ...period, groupBy: 'agent', filters: {} } },
      { name: 'sessions', filters: { ...period }, page: { limit: 10, turnsOnly: true } },
      { name: 'weekly', query: { weekStart: T0 - DAY } },
      { name: 'filters', query: { ...period } }
    ]
    for (const r of reports) expect(await queries.report(r), r.name).toEqual(runAnalyticsReport(db, r))
    await expect(queries.report({ name: 'nope' } as never)).rejects.toThrow(/unknown report nope/)
  })
})
