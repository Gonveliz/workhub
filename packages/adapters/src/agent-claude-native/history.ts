/**
 * Session history of Claude accounts through Workhub 1's `sessions.mjs` (the Agent SDK's
 * `listSessions` and `getSessionMessages`). One Node process per call, with the account's
 * `CLAUDE_CONFIG_DIR`, the same way `claude` itself picks the account.
 */
import { execFile } from 'node:child_process'
import { existsSync, type Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promptTitle, stripPromptWrappers, type HistoryEntry, type HistoryListOptions, type HistoryMessage, type HistoryMessagesOptions, type ImageInput, type SessionHistorySource } from '@workhub/core'
import { claudeToolResult, claudeToolView } from '../shared/claude-tool-view'
import { describeTool } from '../shared/claude-tools'
import { ClaudeTranscriptCache, parseTranscriptText, transcriptChain, type TranscriptState } from './transcript'

export { ClaudeTranscriptCache } from './transcript'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/** A history title keeps more than a sidebar row does: the resume list has the room. */
const HISTORY_TITLE_MAX = 200

export interface ClaudeHistoryOptions {
  bridgeDir: string
  nodeCommand?: string
  /** Most sessions listed per account when the caller does not say (Workhub 1: 400). */
  limit?: number
  /** Reads a transcript's conversation (the app: in its transcript worker); in this process by default. */
  transcripts?: ClaudeTranscriptReader
}

/** `SDKSessionInfo` list -> history entries of one account. */
export function toHistoryEntries(raw: unknown, agentId: string, accountId: string | null): HistoryEntry[] {
  return arr(raw).flatMap((x) => {
    const s = obj(x)
    const id = str(s?.['sessionId'])
    if (!s || !id) return []
    const entry: HistoryEntry = {
      agentId,
      accountId,
      agentSessionId: id,
      title: promptTitle(str(s['customTitle'])) ?? promptTitle(str(s['summary'])) ?? promptTitle(str(s['firstPrompt'])) ?? id,
      lastModified: typeof s['lastModified'] === 'number' ? s['lastModified'] : 0
    }
    const firstPrompt = stripPromptWrappers(str(s['firstPrompt']) ?? '')
    if (firstPrompt) entry.firstPrompt = firstPrompt
    const cwd = str(s['cwd'])
    if (cwd) entry.cwd = cwd
    const branch = str(s['gitBranch'])
    if (branch) entry.gitBranch = branch
    if (typeof s['createdAt'] === 'number') entry.createdAt = s['createdAt']
    if (typeof s['fileSize'] === 'number') entry.sizeBytes = s['fileSize']
    return [entry]
  })
}

/** Text a user typed, without the wrappers Claude Code adds for local commands and reminders. */
function typedText(text: string): string | undefined {
  if (text.includes('<command-name>') || text.includes('<local-command') || HARNESS_WRAPPER.test(text)) return undefined
  return stripPromptWrappers(text) || undefined
}

/** Text the harness injects as a user turn (reminders, background-task results, command echoes), never typed by the user. */
const HARNESS_WRAPPER = /^\s*<(system-reminder|task-notification|command-message|command-name|command-args|bash-input|bash-stdout|bash-stderr)[\s>]/

/** What Claude Code writes as a user turn when the user stops the agent mid-turn. */
const INTERRUPTED = /^\s*\[Request interrupted by user[^\]]*\]\s*$/

/** The summary Claude Code writes as a user turn after a compaction. */
const COMPACT_SUMMARY = 'This session is being continued from a previous conversation'

/** Image types a replayed message shows again (the ones a prompt can carry). */
const REPLAY_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** A stored image block (`{ type: 'image', source: { type: 'base64', media_type, data } }`) that can be shown again; null otherwise. */
function storedImage(block: Obj): ImageInput | null {
  const source = obj(block['source'])
  const mediaType = str(source?.['media_type'])?.toLowerCase()
  const data = str(source?.['data'])
  if (source?.['type'] !== 'base64' || !mediaType || !REPLAY_IMAGE_TYPES.has(mediaType) || !data) return null
  return { mediaType, data }
}

/** A transcript line's ISO `timestamp` as epoch ms; undefined when missing or unreadable. */
function stamp(m: Obj): number | undefined {
  const t = str(m['timestamp'])
  const ms = t ? Date.parse(t) : NaN
  return Number.isNaN(ms) ? undefined : ms
}

/** `SessionMessage` list -> the conversation to replay when a past session opens in the app. */
export function toHistoryMessages(raw: unknown): HistoryMessage[] {
  const out: HistoryMessage[] = []
  const tools = new Map<string, Extract<HistoryMessage, { kind: 'tool' }>>()
  const names = new Map<string, string>()
  for (const x of arr(raw)) {
    const m = obj(x)
    // Subagent turns belong to their Agent call.
    if (!m || str(m['parent_tool_use_id'])) continue
    const message = obj(m['message'])
    const at = stamp(m)
    const when = at === undefined ? {} : { at }
    const content = message?.['content']
    if (m['type'] === 'user') {
      const raw = typeof content === 'string' ? content : arr(content).map((b) => str(obj(b)?.['text']) ?? '').join('\n')
      if (m['isCompactSummary'] === true || raw.trimStart().startsWith(COMPACT_SUMMARY)) {
        out.push({ kind: 'compaction', ...when, ...(raw.trim() ? { summary: raw.trim() } : {}) })
        continue
      }
      if (INTERRUPTED.test(raw)) {
        out.push({ kind: 'interrupted', ...when })
        continue
      }
      if (typeof content === 'string') {
        const text = typedText(content)
        if (text) out.push({ kind: 'user', ...when, text })
        continue
      }
      const blocks = arr(content).map(obj).filter((b): b is Obj => !!b)
      const text = typedText(blocks.filter((b) => b['type'] === 'text').map((b) => str(b['text']) ?? '').join('\n'))
      const imageBlocks = blocks.filter((b) => b['type'] === 'image')
      const images = imageBlocks.length
      if (text || images) {
        const imageData = imageBlocks.map(storedImage).filter((i): i is ImageInput => i !== null)
        out.push(images ? { kind: 'user', ...when, text: text ?? '', images, ...(imageData.length ? { imageData } : {}) } : { kind: 'user', ...when, text: text! })
      }
      const results = blocks.filter((b) => b['type'] === 'tool_result')
      for (const b of results) {
        const id = str(b['tool_use_id']) ?? ''
        const tool = tools.get(id)
        if (!tool) continue
        if (b['is_error'] === true) tool.failed = true
        const extra = results.length === 1 ? (m['toolUseResult'] ?? m['tool_use_result']) : undefined
        tool.result = claudeToolResult(names.get(id) ?? '', b['content'], b['is_error'] === true, extra)
      }
    } else if (m['type'] === 'assistant') {
      for (const raw of arr(content)) {
        const b = obj(raw)
        if (b?.['type'] === 'text' && str(b['text'])) {
          const last = out[out.length - 1]
          if (last?.kind === 'agent') last.text += `\n\n${b['text'] as string}`
          else out.push({ kind: 'agent', ...when, text: b['text'] as string })
        } else if (b?.['type'] === 'tool_use' && str(b['id']) && str(b['name'])) {
          const input = obj(b['input']) ?? {}
          const { title, detail } = describeTool(b['name'] as string, input)
          const tool: Extract<HistoryMessage, { kind: 'tool' }> = { kind: 'tool', ...when, id: b['id'] as string, title, view: claudeToolView(b['name'] as string, input) }
          names.set(tool.id, b['name'] as string)
          if (detail) tool.detail = detail
          tools.set(tool.id, tool)
          out.push(tool)
        }
      }
    }
  }
  return out
}

/** The transcript file of a session under `<config dir>/projects/<project>/`; null when there is none. */
export async function transcriptPath(agentSessionId: string, configDir?: string): Promise<string | null> {
  const projects = join(configDir || process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude'), 'projects')
  const dir = (await readdir(projects).catch(() => [] as string[])).find((d) => existsSync(join(projects, d, `${agentSessionId}.jsonl`)))
  return dir ? join(projects, dir, `${agentSessionId}.jsonl`) : null
}

/** The replayed conversation of a parsed transcript, at most its `last` messages; null when it has no main-thread message. */
export function chainMessages(state: TranscriptState, last?: number): HistoryMessage[] | null {
  const chain = transcriptChain(state)
  if (!chain) return null
  const messages = toHistoryMessages(chain)
  return last !== undefined && last > 0 && messages.length > last ? messages.slice(-last) : messages
}

/** One step of reading a transcript: `messages` once the parse reached the end of the file (null: nothing to replay). */
export interface TranscriptRead {
  done: boolean
  offset: number
  size: number
  messages?: HistoryMessage[] | null
}

/** Parses about `chunkBytes` more of a transcript through `cache`; the messages come with the step that reaches its end. */
export function readTranscriptStep(cache: ClaudeTranscriptCache, path: string, options: { chunkBytes?: number; last?: number } = {}): TranscriptRead {
  try {
    const step = cache.advance(path, options.chunkBytes)
    return step.done ? { done: true, offset: step.offset, size: step.size, messages: chainMessages(step.state, options.last) } : { done: false, offset: step.offset, size: step.size }
  } catch (err) {
    cache.drop(path)
    throw err
  }
}

/** Reads a transcript's replayed conversation (null: nothing to replay); the app answers in its transcript worker. */
export type ClaudeTranscriptReader = (path: string, options: { last?: number }) => Promise<HistoryMessage[] | null>

/** The reader without a worker (tests): the same parse, chunk after chunk, in this process. */
export function inProcessTranscriptReader(cache = new ClaudeTranscriptCache()): ClaudeTranscriptReader {
  return async (path, options) => {
    for (;;) {
      const step = readTranscriptStep(cache, path, options)
      if (step.done) return step.messages ?? null
    }
  }
}

/**
 * The conversation of a session read from its transcript (see `transcriptChain`), the whole file at
 * once; null when it is not under `<config dir>/projects` or cannot be read.
 */
export async function transcriptMessages(agentSessionId: string, configDir?: string): Promise<HistoryMessage[] | null> {
  try {
    const path = await transcriptPath(agentSessionId, configDir)
    if (!path) return null
    return chainMessages(parseTranscriptText(await readFile(path, 'utf8')))
  } catch {
    return null
  }
}

export class ClaudeSessionHistory implements SessionHistorySource {
  private readonly transcripts: ClaudeTranscriptReader

  constructor(private readonly options: ClaudeHistoryOptions) {
    this.transcripts = options.transcripts ?? inProcessTranscriptReader()
  }

  async list(account: { agentId: string; accountId: string | null; configDir?: string }, options?: HistoryListOptions): Promise<HistoryEntry[]> {
    const raw = await this.run(['all', String(options?.limit ?? this.options.limit ?? 400)], account.configDir)
    return toHistoryEntries(raw, account.agentId, account.accountId)
  }

  /** The transcripts under `<config dir>/projects/<project>/<id>.jsonl`, by name only; none when the folder does not exist. */
  async sessionIds(account: { configDir?: string }): Promise<ReadonlySet<string>> {
    const projects = join(account.configDir || process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude'), 'projects')
    const ids = new Set<string>()
    let dirs: Dirent[]
    try {
      dirs = await readdir(projects, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ids
      throw err
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      for (const name of await readdir(join(projects, d.name))) if (name.endsWith('.jsonl')) ids.add(name.slice(0, -'.jsonl'.length))
    }
    return ids
  }

  /**
   * The conversation as stored. Looked up under the session's folder first; a session whose
   * transcript sits under another project folder (the folder was renamed or reached through a
   * symlink) is looked up in every project.
   */
  async messages(agentSessionId: string, cwd: string, configDir?: string, options: HistoryMessagesOptions = {}): Promise<HistoryMessage[]> {
    const path = await transcriptPath(agentSessionId, configDir)
    // A transcript that cannot be read (or a worker that failed) falls back to the SDK's reading.
    const stored = path ? await this.transcripts(path, { ...(options.last ? { last: options.last } : {}) }).catch(() => null) : null
    if (stored?.length) return stored
    const raw = await this.run(['messages', agentSessionId, cwd], configDir)
    const messages = Array.isArray(raw) && raw.length > 0 ? toHistoryMessages(raw) : toHistoryMessages(await this.run(['messages', agentSessionId], configDir))
    return options.last && messages.length > options.last ? messages.slice(-options.last) : messages
  }

  /** Sets the session's title the way `/rename` does (a custom-title entry in its transcript), so `claude --resume` shows it too. */
  async rename(agentSessionId: string, cwd: string, title: string, configDir?: string): Promise<void> {
    await this.run(['rename', agentSessionId, cwd, title], configDir)
  }

  private run(args: string[], configDir: string | undefined): Promise<unknown> {
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    if (configDir) env['CLAUDE_CONFIG_DIR'] = configDir
    return new Promise((resolve, reject) => {
      execFile(
        this.options.nodeCommand ?? process.execPath,
        [join(this.options.bridgeDir, 'sessions.mjs'), ...args],
        { env, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
        (err, stdout) => {
          let parsed: unknown
          try {
            parsed = JSON.parse(stdout)
          } catch {
            reject(err ?? new Error('the session list could not be read'))
            return
          }
          const error = str(obj(parsed)?.['error'])
          if (error) reject(new Error(error))
          else resolve(parsed)
        }
      )
    })
  }
}
