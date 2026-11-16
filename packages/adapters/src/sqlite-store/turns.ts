/**
 * Reads every assistant turn with usage out of the agents' transcripts into `turns`, and the
 * sessions they belong to into `sessions`. The same parsers as the spend buckets (Home's token
 * spend) read the files, with their own offsets in `turn_files`: a scan reads only what was
 * appended to each file since the last one, and the first one reads every transcript there is.
 * Rows are keyed by (session, message key), and a Claude message id is stored once whatever
 * session repeats it (a forked or rewound session copies earlier messages), so reading a file
 * again never counts a turn twice. Transcripts are read where they are; nothing is sent anywhere.
 */
import { createHash } from 'node:crypto'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { aliasPath, type SpendBuckets } from '@workhub/core'
import { claudeFiles, codexFiles, readLinesFrom, type SpendSources } from '../token-spend/scanner'
import { claudeSpendLine, codexSpendLine, kiroSpendFile, type ClaudeSpendState, type CodexSpendState, type SpendTurn } from '../token-spend/parsers'
import { repoRootOf, worktreeAliases, type WorktreeLink } from '../token-spend/git-worktree'
import { isCompressed, readRollout } from '../transcript-codex/files'
import type { WorkhubDb } from './db'
import { retentionState } from './retention'

export type TurnAgent = 'claude' | 'codex' | 'kiro'
type Kind = 'claude' | 'codex' | 'codex-zst' | 'kiro'

/** `sessions.account_id` when the config folder a transcript came from matches no account Workhub knows. */
export const UNKNOWN_ACCOUNT = 'unknown'
/** Bytes at the start of a file whose hash tells a rewritten file from one that only grew. */
export const HEAD_BYTES = 4096
/** The `kv_state` key that marks the first (backfill) scan as done. */
export const TURN_SCAN_KEY = 'turn-scan'
const YIELD_LINES = 2_000

/** Maps folders to their project (see `repoProjects`); called with the folders of one transcript at a time. */
export type ProjectResolver = (paths: readonly string[]) => Promise<Record<string, string>>

export interface TurnIngestOptions {
  /** The account whose config folder (Claude's config dir, a Codex home) holds the transcript: null for the default account, `UNKNOWN_ACCOUNT` when none matches. */
  accountOf?: (agent: TurnAgent, dir: string) => string | null
  /** The profile that owns a folder, for a session found only in a transcript. */
  profileOf?: (cwd: string) => string | null
  /** The project of each folder; `repoProjects` (the repository root, else the folder) by default. */
  projects?: ProjectResolver
  log?: (message: string) => void
  now?: () => number
  /** Expands `~` in the commands that move a Claude session's work (the user's home by default). */
  home?: string
  /** Files between two progress lines of a first (backfill) scan. */
  progressEvery?: number
}

export interface TurnScanResult {
  /** Transcripts found. */
  files: number
  /** Transcripts read (new or changed since the last scan). */
  read: number
  /** Turns written (new or updated). */
  turns: number
  /** Whether this was the first scan, which reads everything. */
  backfill: boolean
}

interface FileRow {
  path: string
  size: number
  mtime_ms: number
  offset: number
  head_len: number
  head_hash: string | null
  state: string | null
}

interface Found {
  kind: Kind
  /** The config folder, Codex home or Kiro folder it was found under. */
  root: string
  size: number
  mtimeMs: number
}

const tick = () => new Promise<void>((r) => setImmediate(r))

/** The session a transcript belongs to: a Claude subagent's counts for its parent session. */
export function transcriptSessionId(kind: Kind, path: string): string {
  const name = basename(path)
  if (kind === 'claude') {
    const parent = dirname(path)
    if (basename(parent) === 'subagents') return basename(dirname(parent))
    return name.replace(/\.jsonl$/, '')
  }
  if (kind === 'kiro') return name.replace(/\.json$/, '')
  const uuid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/i.exec(name)
  return uuid?.[1] ?? name.replace(/\.jsonl(\.zst)?$/, '')
}

const isSubagentFile = (path: string) => basename(dirname(path)) === 'subagents'
const agentOf = (kind: Kind): TurnAgent => (kind === 'codex-zst' ? 'codex' : kind)

/**
 * The project of each folder without profile knowledge: a linked worktree moved to its main
 * repository, then the nearest folder holding `.git`, else the folder itself.
 */
export async function repoProjects(paths: readonly string[], cache: Map<string, WorktreeLink | null> = new Map()): Promise<Record<string, string>> {
  const aliases = await worktreeAliases(paths, cache)
  const out: Record<string, string> = {}
  for (const p of paths) {
    const moved = aliasPath(p, aliases)
    out[p] = (await repoRootOf(moved)) ?? p
  }
  return out
}

/** The hash of the first `length` bytes of a file; null when it cannot be read. */
async function headHash(path: string, length: number): Promise<string | null> {
  const handle = await open(path, 'r').catch(() => null)
  if (!handle) return null
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return createHash('sha1').update(buffer.subarray(0, bytesRead)).digest('hex')
  } finally {
    await handle.close()
  }
}

export class TurnIngest {
  private running: Promise<TurnScanResult> | null = null
  private readonly worktrees = new Map<string, WorktreeLink | null>()

  constructor(
    private readonly db: WorkhubDb,
    private readonly options: TurnIngestOptions = {}
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** Reads what is new in every transcript of `sources`; a scan already running is shared. Never throws for one bad file. */
  scan(sources: SpendSources): Promise<TurnScanResult> {
    this.running ??= this.run(sources).finally(() => {
      this.running = null
    })
    return this.running
  }

  private async list(sources: SpendSources): Promise<Map<string, Found>> {
    const files = new Map<string, Found>()
    // One Claude transcript per path relative to its config folder (failover copies share it): the newest copy.
    const claude = new Map<string, Found & { path: string }>()
    for (const dir of new Set(sources.claudeDirs)) {
      for (const f of await claudeFiles(dir)) {
        const info = await stat(f).catch(() => null)
        if (!info?.isFile()) continue
        const rel = relative(dir, f)
        const prev = claude.get(rel)
        if (!prev || info.mtimeMs > prev.mtimeMs) claude.set(rel, { path: f, kind: 'claude', root: dir, size: info.size, mtimeMs: info.mtimeMs })
      }
    }
    // Oldest first: a forked session repeats its parent's messages, which stay with the parent.
    for (const { path, ...found } of [...claude.values()].sort((a, b) => a.mtimeMs - b.mtimeMs)) files.set(path, found)
    const add = async (path: string, kind: Kind, root: string) => {
      const info = await stat(path).catch(() => null)
      if (info?.isFile()) files.set(path, { kind, root, size: info.size, mtimeMs: info.mtimeMs })
    }
    for (const home of new Set(sources.codexHomes)) for (const f of await codexFiles(join(home, 'sessions'), 0)) await add(f, isCompressed(f) ? 'codex-zst' : 'codex', home)
    for (const dir of new Set(sources.kiroDirs)) {
      const cli = join(dir, 'sessions', 'cli')
      for (const n of await readdir(cli).catch(() => [] as string[])) if (n.endsWith('.json')) await add(join(cli, n), 'kiro', dir)
    }
    return files
  }

  private async run(sources: SpendSources): Promise<TurnScanResult> {
    const log = this.options.log ?? (() => {})
    const files = await this.list(sources)
    const known = new Map<string, FileRow>()
    for (const r of this.db.raw.prepare('SELECT path, size, mtime_ms, offset, head_len, head_hash, state FROM turn_files').all() as unknown as FileRow[]) known.set(r.path, r)
    // Rows of files that are gone (a deleted transcript): their turns stay, their offsets go.
    const gone = [...known.keys()].filter((p) => !files.has(p))
    for (const p of gone) if (await stat(p).then(() => false, () => true)) this.db.raw.prepare('DELETE FROM turn_files WHERE path = ?').run(p)
    const backfill = !this.db.raw.prepare('SELECT 1 FROM kv_state WHERE key = ?').get(TURN_SCAN_KEY)
    const every = this.options.progressEvery ?? 200
    if (backfill && files.size) log(`turns: first scan, reading ${files.size} transcripts`)
    let read = 0
    let written = 0
    let done = 0
    for (const [path, found] of files) {
      done++
      if (!this.db.isOpen) break
      try {
        const prev = known.get(path)
        if (prev && prev.size === found.size && prev.mtime_ms === found.mtimeMs) continue
        const n = await this.readFile(path, found, prev)
        if (n !== null) {
          written += n
          read++
        }
      } catch (err) {
        log(`turns: ${basename(path)} not read: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (backfill && done % every === 0) log(`turns: ${done}/${files.size} transcripts, ${written} turns`)
    }
    if (backfill && this.db.isOpen) {
      this.db.raw.prepare('INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING').run(TURN_SCAN_KEY, JSON.stringify({ firstScanAt: this.now() }), this.now())
      if (files.size) log(`turns: first scan done, ${files.size} transcripts, ${written} turns`)
    }
    return { files: files.size, read, turns: written, backfill }
  }

  /**
   * Reads one file from where it stopped (from the start when its first bytes changed, or whole for
   * whole-file formats) and stores its turns; returns how many, or null when it cannot be opened
   * (nothing is recorded, so the next scan tries again).
   */
  private async readFile(path: string, found: Found, prev: FileRow | undefined): Promise<number | null> {
    const { kind, root, size, mtimeMs } = found
    const sessionId = transcriptSessionId(kind, path)
    const sidechainFile = kind === 'claude' && isSubagentFile(path)
    const turns = new Map<string, SpendTurn>()
    const sink = (t: SpendTurn) => turns.set(t.key, t)
    // The parsers also fill spend buckets; here they are thrown away (Home's buckets have their own scan).
    const scratch: SpendBuckets = {}
    let offset = 0
    let state: ClaudeSpendState | CodexSpendState = {}
    const headLen = Math.min(HEAD_BYTES, size)
    const head = await headHash(path, headLen)
    if (head === null) return null
    if (kind === 'kiro') {
      const handle = await open(path, 'r').catch(() => null)
      if (!handle) return null
      const text = await handle.readFile('utf8').finally(() => handle.close())
      await tick()
      kiroSpendFile(text, scratch, undefined, sink)
    } else if (kind === 'codex-zst') {
      const text = await readRollout(path).catch(() => null)
      if (text === null) return null
      const s: CodexSpendState = {}
      let n = 0
      for (const line of text.split('\n')) {
        if (line.trim()) codexSpendLine(line, s, scratch, undefined, undefined, sink)
        if (++n % YIELD_LINES === 0) await tick()
      }
      state = s
    } else {
      // An append-only file resumes; one that shrank or whose first bytes changed was rewritten and is read again.
      const sameHead = prev !== undefined && prev.head_hash !== null && prev.head_len <= size && (prev.head_len === headLen ? prev.head_hash === head : prev.head_hash === (await headHash(path, prev.head_len)))
      const resume = prev !== undefined && sameHead && prev.offset <= size && prev.size <= size
      if (resume && prev.state) {
        try {
          state = JSON.parse(prev.state) as ClaudeSpendState | CodexSpendState
        } catch {
          state = {}
        }
      }
      const home = this.options.home ?? homedir()
      const from = resume ? prev.offset : 0
      const end = await readLinesFrom(path, from, size, (line) =>
        kind === 'claude' ? claudeSpendLine(line, state as ClaudeSpendState, scratch, home, undefined, undefined, sink) : codexSpendLine(line, state as CodexSpendState, scratch, undefined, undefined, sink)
      )
      if (end === null) return null
      offset = end
    }
    const rows = [...turns.values()].map((t) => (sidechainFile ? { ...t, sidechain: true, ms: 0 } : t))
    const agent = agentOf(kind)
    const projects = rows.length ? await (this.options.projects ?? ((p) => repoProjects(p, this.worktrees)))([...new Set(rows.map((t) => t.cwd))]) : {}
    const st = state as { cwd?: string; firstCwd?: string; firstPromptAt?: number }
    const cwd = st.firstCwd ?? st.cwd ?? rows[0]?.cwd
    const accountId = kind === 'kiro' ? null : this.options.accountOf ? this.options.accountOf(agent, root) : UNKNOWN_ACCOUNT
    const now = this.now()
    if (!this.db.isOpen) return null
    let stored = 0
    this.db.transaction(() => {
      if (rows.length) {
        const elsewhere = this.db.raw.prepare("SELECT 1 FROM turns WHERE agent = 'claude' AND msg_key = ? AND session_id <> ? LIMIT 1")
        const upsert = this.db.raw.prepare(
          `INSERT INTO turns (session_id, agent, msg_key, at, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, usd, cwd, project, turn_ms, sidechain)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (session_id, msg_key) DO UPDATE SET at = excluded.at, model = excluded.model, input_tokens = excluded.input_tokens,
             output_tokens = excluded.output_tokens, cache_write_tokens = excluded.cache_write_tokens, cache_read_tokens = excluded.cache_read_tokens,
             usd = excluded.usd, cwd = excluded.cwd, project = excluded.project, turn_ms = excluded.turn_ms, sidechain = excluded.sidechain`
        )
        // Turns of days already summed (see retention.ts) are in turns_daily: a file read again must not add them twice.
        const summedUntil = retentionState(this.db).rolledUntil
        for (const t of rows) {
          if (t.at < summedUntil) continue
          // A Claude message already counted under another session (a fork, a rewind) is not counted again.
          if (agent === 'claude' && elsewhere.get(t.key, sessionId)) continue
          upsert.run(sessionId, agent, t.key, t.at, t.model ?? null, t.input, t.output, t.cacheWrite, t.cacheRead, t.usd ?? null, t.cwd, projects[t.cwd] ?? t.cwd, t.ms, t.sidechain ? 1 : 0)
          stored++
        }
        this.db.raw
          .prepare(
            `INSERT INTO sessions (id, agent, account_id, profile_id, cwd, started_at, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'transcript', ?)
             ON CONFLICT (id) DO UPDATE SET account_id = COALESCE(sessions.account_id, excluded.account_id), profile_id = COALESCE(sessions.profile_id, excluded.profile_id),
               cwd = COALESCE(sessions.cwd, excluded.cwd), started_at = COALESCE(MIN(sessions.started_at, excluded.started_at), sessions.started_at, excluded.started_at),
               updated_at = excluded.updated_at`
          )
          .run(sessionId, agent, accountId, cwd ? (this.options.profileOf?.(cwd) ?? null) : null, cwd ?? null, sidechainFile ? null : (st.firstPromptAt ?? null), now)
        refreshSessionTotals(this.db, sessionId)
      }
      this.db.raw
        .prepare(
          `INSERT INTO turn_files (path, agent, session_id, account_id, size, mtime_ms, offset, head_len, head_hash, state, scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, offset = excluded.offset, head_len = excluded.head_len,
             head_hash = excluded.head_hash, state = excluded.state, scanned_at = excluded.scanned_at, account_id = excluded.account_id`
        )
        .run(path, agent, sessionId, accountId, size, mtimeMs, offset, headLen, head, kind === 'claude' || kind === 'codex' ? JSON.stringify(state) : null, now)
    })
    return stored
  }
}

/**
 * A session's totals from its turns: agent time (sub-agents' turns left out, their time runs inside
 * the parent's; its daily summaries count too), first activity, the model, folder and project of its latest turn, its main project
 * (the one most of its turns worked in), and for a transcript-only session its last activity as
 * `ended_at` (a Workhub session's `ended_at` is when Workhub saw it stop).
 */
export function refreshSessionTotals(db: WorkhubDb, sessionId: string): void {
  db.raw
    .prepare(
      `UPDATE sessions SET
         active_ms = (SELECT COALESCE(SUM(turn_ms), 0) FROM turns WHERE session_id = ?1 AND sidechain = 0) + (SELECT COALESCE(SUM(turn_ms), 0) FROM turns_daily WHERE session_id = ?1),
         started_at = (SELECT MIN(v) FROM (SELECT sessions.started_at AS v UNION ALL SELECT MIN(at) FROM turns WHERE session_id = ?1)),
         ended_at = CASE WHEN source = 'workhub' THEN ended_at ELSE (SELECT MAX(v) FROM (SELECT sessions.ended_at AS v UNION ALL SELECT MAX(at) FROM turns WHERE session_id = ?1)) END,
         last_model = COALESCE((SELECT model FROM turns WHERE session_id = ?1 AND model IS NOT NULL ORDER BY sidechain, at DESC LIMIT 1), last_model),
         work_path = COALESCE((SELECT cwd FROM turns WHERE session_id = ?1 ORDER BY sidechain, at DESC LIMIT 1), work_path),
         project = COALESCE((SELECT project FROM turns WHERE session_id = ?1 AND project IS NOT NULL GROUP BY project ORDER BY COUNT(*) DESC, MAX(at) DESC LIMIT 1), project)
       WHERE id = ?1`
    )
    .run(sessionId)
}
