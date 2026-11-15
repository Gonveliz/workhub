import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HISTORY_MARK, snippetParts, type HistoryEntry, type HistoryMessage } from '@workhub/core'
import { DB_FILE, ftsQuery, historyChunks, historyContent, historyStamp, HISTORY_INDEX_VERSION, SqliteHistoryIndex, WorkhubDb } from '../src/sqlite-store'

const dirs: string[] = []
const dbs: WorkhubDb[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function openDb(): WorkhubDb {
  const dir = mkdtempSync(join(tmpdir(), 'wh-fts-'))
  dirs.push(dir)
  const db = WorkhubDb.open(join(dir, DB_FILE), { log: () => {} })
  dbs.push(db)
  return db
}

function openIndex(): { db: WorkhubDb; index: SqliteHistoryIndex } {
  const db = openDb()
  return { db, index: new SqliteHistoryIndex(db) }
}

const T = Date.UTC(2026, 10, 1, 12)
const { open: O, close: C } = HISTORY_MARK

function entry(id: string, fields: Partial<HistoryEntry> = {}): HistoryEntry {
  return { agentId: 'claude', accountId: null, agentSessionId: id, title: `Session ${id}`, lastModified: T, sizeBytes: 100, cwd: '/w/acme/api', ...fields }
}

const said = (user: string, agent: string): HistoryMessage[] => [
  { kind: 'user', text: user },
  { kind: 'tool', id: 't1', title: 'Read secret.txt', detail: 'toolpayloadword' },
  { kind: 'agent', text: agent }
]

const ids = (keys: string[]) => keys.map((k) => k.split(':')[1])
const ftsRows = (db: WorkhubDb) => Number((db.raw.prepare('SELECT COUNT(*) AS n FROM history_fts').get() as { n: number }).n)

describe('historyContent and chunks', () => {
  it('keeps user and agent text only, without snippet markers, and caps the total', () => {
    const text = historyContent([...said(`fix the ${O}login${C}`, 'done with the login'), { kind: 'notice', title: 'n', text: 'banner' }, { kind: 'compaction', summary: 'summary text' }])
    expect(text).toBe('fix the login\ndone with the login')
    expect(historyContent([{ kind: 'user', text: 'a'.repeat(50) }, { kind: 'agent', text: 'b'.repeat(50) }], 60).length).toBeLessThanOrEqual(61)
  })

  it('cuts long text at whitespace into chunks that add back up', () => {
    const text = Array.from({ length: 5000 }, (_, i) => `word${i}`).join(' ')
    const chunks = historyChunks(text, 1000)
    expect(chunks.join('')).toBe(text)
    expect(chunks.every((c) => c.length <= 1000)).toBe(true)
    expect(chunks.slice(0, -1).every((c) => c.endsWith(' '))).toBe(true)
  })

  it('stamps time, size and title; nothing when neither time nor size is known', () => {
    expect(historyStamp(entry('x'))).toBe(`${T}:100:Session x`)
    expect(historyStamp(entry('x', { title: 'Renamed' }))).not.toBe(historyStamp(entry('x')))
    expect(historyStamp(entry('x', { lastModified: 0, sizeBytes: undefined }))).toBeNull()
  })
})

describe('ftsQuery', () => {
  it('quotes every word, doubles quotes and makes the last one a prefix from two characters', () => {
    expect(ftsQuery('deploy  api')).toBe('"deploy" "api"*')
    expect(ftsQuery('say "hi"')).toBe('"say" """hi"""*')
    expect(ftsQuery('a AND b')).toBe('"a" "AND" "b"')
    expect(ftsQuery('-x *')).toBe('"-x"*')
    expect(ftsQuery('  - * ')).toBe('')
    expect(ftsQuery('e')).toBe('')
    expect(ftsQuery('a b')).toBe('')
  })

  it('drops control characters, NUL included', () => {
    expect(ftsQuery('dep\u0000loy\u0007 x\u001fy')).toBe('"dep" "loy" "x" "y"')
  })
})

describe('SqliteHistoryIndex', () => {
  it('creates its tables idempotently, and rebuilds them for another version', () => {
    const { db, index } = openIndex()
    index.upsert([{ entry: entry('v'), content: 'kept' }])
    expect(() => new SqliteHistoryIndex(db)).not.toThrow()
    expect(index.count()).toBe(1)
    db.raw.prepare("UPDATE history_meta SET value = '1' WHERE key = 'version'").run()
    const again = new SqliteHistoryIndex(db)
    expect(again.count()).toBe(0)
    expect((db.raw.prepare("SELECT value FROM history_meta WHERE key = 'version'").get() as { value: string }).value).toBe(String(HISTORY_INDEX_VERSION))
  })

  it('finds conversation text with a marked snippet, best match first; never tool payloads', () => {
    const { index } = openIndex()
    index.upsert([
      { entry: entry('s1', { title: 'Payments retry' }), content: historyContent(said('the retry loop on payments fails', 'I fixed the retry backoff')) },
      { entry: entry('s2', { title: 'Docs' }), content: historyContent(said('update the readme', 'a retry is mentioned once')) },
      { entry: entry('s3', { title: 'Other' }), content: 'nothing relevant here' }
    ])
    const page = index.search('retry')
    expect(page.hits.map((h) => h.agentSessionId)).toEqual(['s1', 's2'])
    expect(page.total).toBe(2)
    expect(page.hits[0]!.snippet).toContain(`${O}retry${C}`)
    expect(page.hits[0]!.titleSnippet).toBe(`Payments ${O}retry${C}`)
    expect(page.hits[1]!.titleSnippet).toBeUndefined()
    expect(snippetParts(page.hits[0]!.titleSnippet!)).toEqual([
      { text: 'Payments ', marked: false },
      { text: 'retry', marked: true }
    ])
    expect(index.search('toolpayloadword').hits).toEqual([])
  })

  it('finds a session by branch, by agent session id and by a title without conversation', () => {
    const { index } = openIndex()
    index.upsert([
      { entry: entry('3f2a9c1e-77aa', { gitBranch: 'feature/checkout-flow', title: 'Codex work' }), content: '' },
      { entry: entry('other'), content: 'unrelated' }
    ])
    expect(ids(index.match('checkout'))).toEqual(['3f2a9c1e-77aa'])
    expect(ids(index.match('3f2a9c1e'))).toEqual(['3f2a9c1e-77aa'])
    expect(ids(index.match('codex'))).toEqual(['3f2a9c1e-77aa'])
  })

  it('takes a rename into the index when the session is written again', () => {
    const { index } = openIndex()
    index.upsert([{ entry: entry('r'), content: 'body' }])
    expect(index.match('invoices')).toEqual([])
    index.upsert([{ entry: entry('r', { title: 'Invoices cleanup' }), content: 'body' }])
    expect(ids(index.match('invoices'))).toEqual(['r'])
    expect(index.stamps().get('claude:r')!.stamp).toBe(historyStamp(entry('r', { title: 'Invoices cleanup' })))
  })

  it('matches prefixes of the last word and ignores accents both ways', () => {
    const { index } = openIndex()
    index.upsert([{ entry: entry('es'), content: 'La canción de la migración quedó lista' }])
    expect(index.search('cancion').hits).toHaveLength(1)
    expect(index.search('CANCIÓN migr').hits).toHaveLength(1)
    expect(index.search('migr cancion').hits).toHaveLength(0)
    expect(index.search('migración').hits[0]!.snippet).toContain(`${O}migración${C}`)
  })

  it('treats operators, quotes and control characters as text, never as query syntax', () => {
    const { index } = openIndex()
    index.upsert([
      { entry: entry('q1'), content: 'she said "hello" AND left; also NOT here -flag *glob*' },
      { entry: entry('q2'), content: 'hello world' }
    ])
    for (const q of ['"hello', 'hello"', 'AND', 'NOT', 'hello OR', '-flag', '*', 'title:hello', '(hello', 'NEAR(hello', '"', 'hel\u0000lo', 'e']) {
      expect(() => index.search(q)).not.toThrow()
    }
    expect(index.search('hello AND').hits.map((h) => h.agentSessionId)).toEqual(['q1'])
    expect(index.search('hello OR').hits).toEqual([])
    expect(index.search('-flag').hits.map((h) => h.agentSessionId)).toEqual(['q1'])
    expect(index.search('*').hits).toEqual([])
  })

  it('keeps literal <mark> in text as text and markers only from the index', () => {
    const { index } = openIndex()
    index.upsert([{ entry: entry('m'), content: `use <mark>tags</mark> for highlight ${O}fake${C}` }])
    const s = index.search('highlight').hits[0]!.snippet
    expect(s).toContain('<mark>tags</mark>')
    expect(snippetParts(s).filter((p) => p.marked).map((p) => p.text)).toEqual(['highlight'])
    expect(index.search('fake').hits[0]!.snippet).toContain(`${O}fake${C}`)
  })

  it('filters by agent, accounts, folders, keys and time inside the query, and pages with a cursor', () => {
    const { index } = openIndex()
    index.upsert(
      Array.from({ length: 5 }, (_, i) => ({
        entry: entry(`p${i}`, { lastModified: T + i, cwd: i % 2 ? '/w/acme/web' : '/w/acme/api', agentId: i === 4 ? 'codex' : 'claude', accountId: i === 0 ? 'acct-2' : null }),
        content: `common word ${i}`
      }))
    )
    expect(ids(index.match('common', { agent: 'codex' }))).toEqual(['p4'])
    expect(ids(index.match('common', { accountIds: ['acct-2'] }))).toEqual(['p0'])
    expect(ids(index.match('common', { cwdPrefixes: ['/w/acme/web/'] })).sort()).toEqual(['p1', 'p3'])
    expect(index.match('common', { cwdPrefixes: ['/w/acme/we'] })).toEqual([])
    expect(index.match('common', { cwdPrefixes: [] })).toEqual([])
    expect(ids(index.match('common', { keys: ['claude:p2', 'claude:none'] }))).toEqual(['p2'])
    expect(index.match('common', { since: T + 3 })).toHaveLength(2)
    expect(index.match('common', { until: T + 1 })).toHaveLength(2)
    const first = index.search('common', { limit: 2 })
    expect(first).toMatchObject({ total: 5, nextCursor: '2' })
    const second = index.search('common', { limit: 2, cursor: first.nextCursor })
    const third = index.search('common', { limit: 2, cursor: second.nextCursor })
    expect(third.nextCursor).toBeUndefined()
    expect(new Set([...first.hits, ...second.hits, ...third.hits].map((h) => h.agentSessionId)).size).toBe(5)
  })

  it('stores a long conversation in chunks, re-indexes it in place and removes it', () => {
    const { db, index } = openIndex()
    const long = `${'filler '.repeat(30_000)}needle at the end`
    index.upsert([{ entry: entry('r1'), content: long }])
    expect(ftsRows(db)).toBeGreaterThan(2)
    expect(index.search('needle').hits[0]!.snippet).toContain(`${O}needle${C}`)
    index.upsert([{ entry: entry('r1', { lastModified: T + 1000, sizeBytes: 200 }), content: 'second version beta' }])
    expect(index.search('needle').hits).toEqual([])
    expect(index.search('beta').hits).toHaveLength(1)
    expect(ftsRows(db)).toBe(1)
    index.remove(['claude:r1'])
    expect(index.count()).toBe(0)
    expect(ftsRows(db)).toBe(0)
  })

  it('writes in transactions of bounded text, the stamp set only once a session is complete', () => {
    const { db, index } = openIndex()
    const big = 'word '.repeat(100_000)
    const steps = index.write([{ entry: entry('w1'), content: big }, { entry: entry('w2'), content: 'small' }], 100_000)
    const first = steps.next()
    expect(first.done).toBe(false)
    expect(first.value).toBe(0)
    expect(index.stamps().get('claude:w1')!.stamp).toBe('')
    let last = 0
    for (let s = steps.next(); !s.done; s = steps.next()) last = s.value
    expect(last).toBe(2)
    expect(index.stamps().get('claude:w1')!.stamp).toBe(historyStamp(entry('w1')))
    db.close()
    expect([...index.write([{ entry: entry('w3'), content: 'x' }])]).toEqual([])
  })

  it('computes snippets only for the page asked for', () => {
    const { db, index } = openIndex()
    index.upsert(Array.from({ length: 30 }, (_, i) => ({ entry: entry(`g${i}`), content: `shared term ${i} ${'pad '.repeat(2000)}` })))
    const original = db.raw.prepare.bind(db.raw)
    let snippetRuns = 0
    const prepare = vi.spyOn(db.raw, 'prepare').mockImplementation((sql: string) => {
      const statement = original(sql)
      if (!sql.includes('snippet(')) return statement
      const get = statement.get.bind(statement)
      return Object.assign(statement, { get: (...args: never[]) => (snippetRuns++, get(...args)) })
    })
    const page = index.search('shared', { limit: 5 })
    prepare.mockRestore()
    expect(page.hits).toHaveLength(5)
    expect(page.total).toBe(30)
    // One content and one title snippet per row of the page, none for the 25 other matches.
    expect(snippetRuns).toBe(10)
  })

  it('answers a search over 200 sessions of 100 KB quickly', () => {
    const { index } = openIndex()
    const words = 'error deploy retry value file test build config update change run code line type'.split(' ')
    const text = (n: number) => Array.from({ length: 14_000 }, (_, i) => words[(i * 3 + n) % words.length]).join(' ')
    index.upsert(Array.from({ length: 200 }, (_, i) => ({ entry: entry(`b${i}`), content: text(i) })))
    const started = performance.now()
    const page = index.search('error', { limit: 50 })
    const took = performance.now() - started
    expect(page.hits).toHaveLength(50)
    expect(took).toBeLessThan(1500)
  })

  it('finds nothing once the database is closed', () => {
    const { db, index } = openIndex()
    index.upsert([{ entry: entry('c1'), content: 'closing time' }])
    db.close()
    expect(index.search('closing').hits).toEqual([])
  })
})
