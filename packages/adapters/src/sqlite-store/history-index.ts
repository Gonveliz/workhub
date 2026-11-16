/**
 * The full-text index of past sessions (History search). `history_index` keeps one row per session
 * with what the listing knows of it and the stamp of its transcript when it was read (time, size,
 * title); `history_fts` (FTS5) holds the searchable text in chunks of about 64 KB, user and agent
 * turns only. A chunk's rowid is its session's `doc_id` × `CHUNK_SLOTS` plus its number, so a
 * session's chunks are one rowid range. The tables are created here when missing, and rebuilt when
 * `HISTORY_INDEX_VERSION` changes, rather than by a numbered migration: the index is a cache the
 * agents' own files can always rebuild.
 *
 * A search ranks first (bm25 per chunk, the best chunk per session) without snippets, and computes
 * snippets only for the sessions of the page asked for, each from its best chunk.
 */
import { HISTORY_MARK, type HistoryEntry, type HistoryMessage } from '@workhub/core'
import type { WorkhubDb } from './db'

/** Bump when the tables, the tokenizer or what goes in them change: the index is then rebuilt. */
export const HISTORY_INDEX_VERSION = 2
/** Characters of a session's text that go into the index; the rest of a very long session is left out. */
export const HISTORY_CONTENT_MAX = 2_000_000
/** Characters per indexed chunk: a snippet reads one chunk, never a whole session. */
export const HISTORY_CHUNK_CHARS = 64_000
/** Characters of text written per transaction (a larger session spans several). */
export const HISTORY_WRITE_CHARS = 1_000_000
/** Search results per page, by default and at most. */
export const HISTORY_SEARCH_LIMIT = { default: 50, max: 200 } as const
/** Tokens of context a snippet shows around the matches. */
export const HISTORY_SNIPPET_TOKENS = 24
/** Rowids per session in `history_fts` (2 MB / 64 KB = 32 chunks used at most). */
const CHUNK_SLOTS = 1024

const OPEN = HISTORY_MARK.open
const CLOSE = HISTORY_MARK.close
/** bm25 weights by column: session_id, agent, cwd, title, branch, agent_session_id, content. */
const BM25 = 'bm25(history_fts, 0, 0, 1, 4, 2, 2, 1)'
const CONTENT_COL = 6
const TITLE_COL = 3

/** Creates the index tables when missing; drops and recreates them when they are of another version. */
export function ensureHistoryIndex(db: WorkhubDb): void {
  db.raw.exec('CREATE TABLE IF NOT EXISTS history_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const row = db.raw.prepare("SELECT value FROM history_meta WHERE key = 'version'").get() as { value: string } | undefined
  if (row?.value === String(HISTORY_INDEX_VERSION)) return
  db.transaction(() => {
    db.raw.exec(`
      DROP TABLE IF EXISTS history_fts;
      DROP TABLE IF EXISTS history_index;
      CREATE TABLE history_index (
        doc_id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        agent TEXT NOT NULL,
        account_id TEXT NOT NULL DEFAULT '',
        agent_session_id TEXT NOT NULL,
        cwd TEXT,
        branch TEXT,
        title TEXT,
        first_prompt TEXT,
        started_at INTEGER,
        updated_at INTEGER NOT NULL,
        source_mtime INTEGER NOT NULL,
        source_size INTEGER NOT NULL,
        -- historyStamp when the session was last read completely; '' while a write is under way.
        stamp TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX history_index_updated ON history_index (updated_at);
      CREATE VIRTUAL TABLE history_fts USING fts5(
        session_id UNINDEXED,
        agent UNINDEXED,
        cwd,
        title,
        branch,
        agent_session_id,
        content,
        tokenize = 'unicode61 remove_diacritics 2',
        prefix = '2 3'
      );
    `)
    db.raw.prepare("INSERT INTO history_meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(HISTORY_INDEX_VERSION))
  })
}

/** The key of a session in the index: its agent and the agent's session id. */
export function historyIndexKey(e: Pick<HistoryEntry, 'agentId' | 'agentSessionId'>): string {
  return `${e.agentId}:${e.agentSessionId}`
}

/**
 * What a session looked like when it was indexed (transcript time and size, and the title the
 * listing gives it, a Workhub rename included); a change means it is read again. Null when neither
 * time nor size is known: such a session is read again every round.
 */
export function historyStamp(e: Pick<HistoryEntry, 'lastModified' | 'sizeBytes' | 'title'>): string | null {
  const mtime = Math.round(e.lastModified || 0)
  const size = e.sizeBytes ?? -1
  if (mtime <= 0 && size < 0) return null
  return `${mtime}:${size}:${e.title}`
}

/** Text without the snippet markers (they must only ever come from the index). */
const clean = (text: string) => text.replace(/[]/g, '')

/** The searchable text of a conversation: what the user typed and what the agent answered, never tool payloads; capped. */
export function historyContent(messages: readonly HistoryMessage[], max = HISTORY_CONTENT_MAX): string {
  const parts: string[] = []
  let length = 0
  for (const m of messages) {
    if (m.kind !== 'user' && m.kind !== 'agent') continue
    const text = clean(m.text).trim()
    if (!text) continue
    const room = max - length
    if (room <= 0) break
    const piece = text.length > room ? text.slice(0, room) : text
    parts.push(piece)
    length += piece.length + 1
  }
  return parts.join('\n')
}

/** Text in chunks of about `size` characters, cut at whitespace when there is some near the end. */
export function historyChunks(text: string, size = HISTORY_CHUNK_CHARS): string[] {
  const out: string[] = []
  let at = 0
  while (at < text.length) {
    let end = Math.min(text.length, at + size)
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end)
      const newline = text.lastIndexOf('\n', end)
      const cut = Math.max(space, newline)
      if (cut > at + size / 2) end = cut + 1
    }
    out.push(text.slice(at, end))
    at = end
  }
  return out
}

/**
 * The words of a search box as an FTS5 query that matches them all, in any order: every word is a
 * quoted string (quotes doubled), so operators (`AND`, `NOT`, `-`, `*`, `:`, parentheses) are
 * searched as text and never parsed. The last word also matches as a prefix when it has two
 * characters or more. Control characters go; words without a letter or digit are dropped. Empty
 * (nothing to ask the index) when no word is left or every word is a single character.
 */
export function ftsQuery(text: string): string {
  const words = text
    .replace(/\p{Cc}/gu, ' ')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w))
  if (!words.some((w) => [...w].length >= 2)) return ''
  return words.map((w, i) => `"${w.replace(/"/g, '""')}"${i === words.length - 1 && [...w].length >= 2 ? '*' : ''}`).join(' ')
}

export interface IndexedSession {
  entry: HistoryEntry
  /** The conversation's searchable text (`historyContent`). */
  content: string
}

/** Which sessions a search considers; every field narrows it. */
export interface HistoryScope {
  agent?: string
  /** Accounts by id (`''`: an agent's default folder). */
  accountIds?: readonly string[]
  /** Sessions run in one of these folders or below; an empty list matches nothing. */
  cwdPrefixes?: readonly string[]
  /** Only these sessions (`historyIndexKey`). */
  keys?: readonly string[]
  /** Epoch ms bounds on the session's last change. */
  since?: number
  until?: number
}

export interface HistorySearchOptions extends HistoryScope {
  limit?: number
  /** The `nextCursor` of the previous page. */
  cursor?: string
}

export interface HistorySnippets {
  /** Text around the matches in the conversation, matches between `HISTORY_MARK`s; empty when none matched there. */
  snippet: string
  /** The title with its matches marked, when the title matched. */
  titleSnippet?: string
}

export interface HistoryHit extends HistorySnippets {
  key: string
  agentId: string
  accountId: string | null
  agentSessionId: string
  cwd?: string
  title: string
  updatedAt: number
}

export interface HistorySearchPage {
  hits: HistoryHit[]
  /** Sessions matching in all. */
  total: number
  /** Pass it back as `cursor` for the next page; absent on the last one. */
  nextCursor?: string
}

/** The stored stamp and account of every indexed session, by key. */
export type IndexedStamps = Map<string, { stamp: string; agent: string; accountId: string }>

/** Reads and writes the History index of a database. */
export class SqliteHistoryIndex {
  constructor(private readonly db: WorkhubDb) {
    ensureHistoryIndex(db)
  }

  get isOpen(): boolean {
    return this.db.isOpen
  }

  /** Every indexed session's stamp. */
  stamps(): IndexedStamps {
    const rows = this.db.raw.prepare('SELECT session_id, agent, account_id, stamp FROM history_index').all() as { session_id: string; agent: string; account_id: string; stamp: string }[]
    return new Map(rows.map((r) => [r.session_id, { stamp: r.stamp, agent: r.agent, accountId: r.account_id }]))
  }

  /** Writes (or rewrites) sessions and their text in one go (tests, small batches). */
  upsert(sessions: readonly IndexedSession[]): void {
    for (const _ of this.write(sessions, Number.POSITIVE_INFINITY));
  }

  /**
   * Writes sessions in transactions of at most about `maxChars` characters of text, yielding the
   * number of sessions finished after each one, so the caller can let other work run in between.
   * A session cut across transactions keeps an empty stamp until its last chunk is in: if writing
   * stops halfway (the app quits), it is read again next time. Stops when the database closes.
   */
  *write(sessions: readonly IndexedSession[], maxChars = HISTORY_WRITE_CHARS): Generator<number> {
    type Step = { kind: 'begin'; s: IndexedSession } | { kind: 'chunk'; s: IndexedSession; n: number; text: string } | { kind: 'end'; s: IndexedSession }
    const steps: Step[] = []
    for (const s of sessions) {
      steps.push({ kind: 'begin', s })
      // Every session has a first chunk: it carries the title, folder, branch and id even without a conversation.
      const chunks = historyChunks(clean(s.content))
      ;(chunks.length ? chunks : ['']).forEach((text, n) => steps.push({ kind: 'chunk', s, n, text }))
      steps.push({ kind: 'end', s })
    }
    const docs = new Map<IndexedSession, number>()
    let done = 0
    let i = 0
    while (i < steps.length) {
      if (!this.db.isOpen) return
      this.db.transaction(() => {
        let chars = 0
        while (i < steps.length && (chars === 0 || chars < maxChars)) {
          const step = steps[i++]!
          if (step.kind === 'begin') docs.set(step.s, this.begin(step.s.entry))
          else if (step.kind === 'chunk') {
            this.chunk(docs.get(step.s)!, step.s.entry, step.n, step.text)
            chars += step.text.length || 1
          } else {
            this.db.raw.prepare('UPDATE history_index SET stamp = ? WHERE doc_id = ?').run(historyStamp(step.s.entry) ?? '', docs.get(step.s)!)
            done++
          }
        }
      })
      yield done
    }
  }

  /** A session's row with an empty stamp and no text yet; its doc id. */
  private begin(e: HistoryEntry): number {
    const key = historyIndexKey(e)
    const prior = this.db.raw.prepare('SELECT doc_id FROM history_index WHERE session_id = ?').get(key) as { doc_id: number } | undefined
    const values = [e.agentId, e.accountId ?? '', e.agentSessionId, e.cwd ?? null, e.gitBranch ?? null, clean(e.title), e.firstPrompt ?? null, e.createdAt ?? null, Math.round(e.lastModified || 0), Math.round(e.lastModified || 0), e.sizeBytes ?? -1] as const
    if (prior) {
      const doc = Number(prior.doc_id)
      this.dropText(doc)
      this.db.raw
        .prepare("UPDATE history_index SET agent = ?, account_id = ?, agent_session_id = ?, cwd = ?, branch = ?, title = ?, first_prompt = ?, started_at = ?, updated_at = ?, source_mtime = ?, source_size = ?, stamp = '' WHERE doc_id = ?")
        .run(...values, doc)
      return doc
    }
    const r = this.db.raw
      .prepare("INSERT INTO history_index (session_id, agent, account_id, agent_session_id, cwd, branch, title, first_prompt, started_at, updated_at, source_mtime, source_size, stamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')")
      .run(key, ...values)
    return Number(r.lastInsertRowid)
  }

  /** One chunk of a session's text; the first also carries its folder, title, branch, id and first prompt. */
  private chunk(doc: number, e: HistoryEntry, n: number, text: string): void {
    const head = n === 0
    const prompt = head && e.firstPrompt && !text.includes(e.firstPrompt.slice(0, 200)) ? `${clean(e.firstPrompt)}\n` : ''
    this.db.raw
      .prepare('INSERT INTO history_fts (rowid, session_id, agent, cwd, title, branch, agent_session_id, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(doc * CHUNK_SLOTS + n, historyIndexKey(e), e.agentId, head ? (e.cwd ?? '') : '', head ? clean(e.title) : '', head ? (e.gitBranch ?? '') : '', head ? e.agentSessionId : '', prompt + text)
  }

  private dropText(doc: number): void {
    this.db.raw.prepare('DELETE FROM history_fts WHERE rowid BETWEEN ? AND ?').run(doc * CHUNK_SLOTS, doc * CHUNK_SLOTS + CHUNK_SLOTS - 1)
  }

  /** Drops sessions from the index (their transcripts are gone). */
  remove(keys: readonly string[]): void {
    if (!keys.length || !this.db.isOpen) return
    this.db.transaction(() => {
      const find = this.db.raw.prepare('SELECT doc_id FROM history_index WHERE session_id = ?')
      const drop = this.db.raw.prepare('DELETE FROM history_index WHERE doc_id = ?')
      for (const key of keys) {
        const row = find.get(key) as { doc_id: number } | undefined
        if (!row) continue
        this.dropText(Number(row.doc_id))
        drop.run(row.doc_id)
      }
    })
  }

  /**
   * The indexed sessions of one account, as the listing gave them when they were indexed (their
   * stamp then matches, so the indexer does not read them again). History lists the ones a listing
   * cut at its limit left out.
   */
  entries(agentId: string, accountId: string | null): HistoryEntry[] {
    if (!this.db.isOpen) return []
    const rows = this.db.raw
      .prepare('SELECT agent_session_id, cwd, branch, title, first_prompt, started_at, source_mtime, source_size FROM history_index WHERE agent = ? AND account_id = ?')
      .all(agentId, accountId ?? '') as { agent_session_id: string; cwd: string | null; branch: string | null; title: string | null; first_prompt: string | null; started_at: number | null; source_mtime: number; source_size: number }[]
    return rows.map((r) => {
      const e: HistoryEntry = { agentId, accountId, agentSessionId: r.agent_session_id, title: r.title || r.agent_session_id, lastModified: Number(r.source_mtime) }
      if (r.first_prompt) e.firstPrompt = r.first_prompt
      if (r.cwd) e.cwd = r.cwd
      if (r.branch) e.gitBranch = r.branch
      if (r.started_at !== null) e.createdAt = Number(r.started_at)
      if (Number(r.source_size) >= 0) e.sizeBytes = Number(r.source_size)
      return e
    })
  }

  /** Sessions in the index. */
  count(): number {
    const row = this.db.raw.prepare('SELECT COUNT(*) AS n FROM history_index').get() as { n: number }
    return Number(row.n)
  }

  /**
   * Every indexed session in scope matching every word of `query`, best match first (the best
   * chunk's bm25; a match in the title weighs more), as keys. No snippet is computed here. The
   * user's text is never passed as query syntax (`ftsQuery`); an empty query finds nothing.
   */
  match(query: string, scope: HistoryScope = {}): string[] {
    const fts = ftsQuery(query)
    if (!fts || !this.db.isOpen) return []
    if (scope.cwdPrefixes && scope.cwdPrefixes.length === 0) return []
    const where: string[] = []
    const args: (string | number)[] = [fts]
    if (scope.agent) {
      where.push('h.agent = ?')
      args.push(scope.agent)
    }
    if (scope.accountIds) {
      where.push('h.account_id IN (SELECT value FROM json_each(?))')
      args.push(JSON.stringify(scope.accountIds))
    }
    if (scope.keys) {
      where.push('h.session_id IN (SELECT value FROM json_each(?))')
      args.push(JSON.stringify(scope.keys))
    }
    if (scope.cwdPrefixes) {
      const folders = scope.cwdPrefixes.map(trimSeparators).filter(Boolean)
      if (!folders.length) return []
      where.push(`(${folders.map(() => '(h.cwd = ? OR substr(h.cwd, 1, ?) = ?)').join(' OR ')})`)
      for (const f of folders) args.push(f, f.length + 1, `${f}/`)
    }
    if (scope.since !== undefined) {
      where.push('h.updated_at >= ?')
      args.push(scope.since)
    }
    if (scope.until !== undefined) {
      where.push('h.updated_at <= ?')
      args.push(scope.until)
    }
    const rows = this.db.raw
      .prepare(
        `WITH chunks AS MATERIALIZED (SELECT rowid / ${CHUNK_SLOTS} AS doc, ${BM25} AS score FROM history_fts WHERE history_fts MATCH ?),
           m AS (SELECT doc, MIN(score) AS score FROM chunks GROUP BY doc)
         SELECT h.session_id AS key FROM m JOIN history_index h ON h.doc_id = m.doc
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY m.score, h.updated_at DESC`
      )
      .all(...args) as { key: string }[]
    return rows.map((r) => r.key)
  }

  /** The snippets of these sessions for `query`: each from its best chunk only. */
  snippets(query: string, keys: readonly string[]): Map<string, HistorySnippets> {
    const out = new Map<string, HistorySnippets>()
    const fts = ftsQuery(query)
    if (!fts || !keys.length || !this.db.isOpen) return out
    const doc = this.db.raw.prepare('SELECT doc_id FROM history_index WHERE session_id = ?')
    const best = this.db.raw.prepare(`SELECT rowid FROM history_fts WHERE history_fts MATCH ? AND rowid BETWEEN ? AND ? ORDER BY ${BM25} LIMIT 1`)
    // node:sqlite binds numbers as REAL, and FTS5 then ignores a `rowid = ?` next to MATCH: hence the CAST.
    const text = (col: number) =>
      this.db.raw.prepare(`SELECT snippet(history_fts, ${col}, '${OPEN}', '${CLOSE}', '…', ${HISTORY_SNIPPET_TOKENS}) AS s FROM history_fts WHERE history_fts MATCH ? AND rowid = CAST(? AS INTEGER)`)
    const content = text(CONTENT_COL)
    const title = text(TITLE_COL)
    for (const key of keys) {
      const d = doc.get(key) as { doc_id: number } | undefined
      if (!d) continue
      const first = Number(d.doc_id) * CHUNK_SLOTS
      const row = best.get(fts, first, first + CHUNK_SLOTS - 1) as { rowid: number } | undefined
      if (!row) continue
      const s = (content.get(fts, row.rowid) as { s: string | null } | undefined)?.s ?? ''
      const t = (title.get(fts, first) as { s: string | null } | undefined)?.s ?? ''
      out.set(key, { snippet: s.includes(OPEN) ? s : '', ...(t.includes(OPEN) ? { titleSnippet: t } : {}) })
    }
    return out
  }

  /** `match` a page at a time, with the page's sessions and snippets. */
  search(query: string, options: HistorySearchOptions = {}): HistorySearchPage {
    if (!this.db.isOpen) return { hits: [], total: 0 }
    const keys = this.match(query, options)
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? HISTORY_SEARCH_LIMIT.default)), HISTORY_SEARCH_LIMIT.max)
    const offset = Math.max(0, Number.parseInt(options.cursor ?? '0', 10) || 0)
    const page = keys.slice(offset, offset + limit)
    const snippets = this.snippets(query, page)
    const row = this.db.raw.prepare('SELECT agent, account_id, agent_session_id, cwd, title, updated_at FROM history_index WHERE session_id = ?')
    const hits = page.flatMap((key): HistoryHit[] => {
      const r = row.get(key) as { agent: string; account_id: string; agent_session_id: string; cwd: string | null; title: string | null; updated_at: number } | undefined
      if (!r) return []
      const hit: HistoryHit = { key, agentId: r.agent, accountId: r.account_id || null, agentSessionId: r.agent_session_id, title: r.title ?? '', updatedAt: Number(r.updated_at), snippet: '', ...snippets.get(key) }
      if (r.cwd) hit.cwd = r.cwd
      return [hit]
    })
    return { hits, total: keys.length, ...(offset + limit < keys.length ? { nextCursor: String(offset + limit) } : {}) }
  }
}

/**
 * A folder without its trailing separators. A loop rather than `/[\\/]+$/`, which rescans every run
 * of separators that is not at the end (quadratic on a crafted folder).
 */
function trimSeparators(path: string): string {
  let end = path.length
  while (end > 0 && (path[end - 1] === '/' || path[end - 1] === '\\')) end--
  return path.slice(0, end)
}
