/**
 * Per-line token spend of each agent's transcripts, kept as small resumable states so a scan can
 * read only what was appended since the last one. Each parser adds to `SpendBuckets` (see
 * `@workhub/core` folder-spend) and never throws on malformed data.
 */
import { homedir } from 'node:os'
import { addSpend, toolWorkPaths, type SpendBuckets } from '@workhub/core'
import { estimateCost } from '../shared/claude-tools'
import { openAiCost } from '../shared/openai-prices'
import { arr, num, obj, parseLine, str, toMillis, type Obj } from '../shared/reader-utils'

/**
 * What the spend cost at list prices, in the same keys as the token buckets: `usd` per bucket, and
 * `unpriced` tokens of models missing from the price tables. Only shown for API-key billing.
 */
export interface CostBuckets {
  usd: SpendBuckets
  unpriced: SpendBuckets
}

export const emptyCosts = (): CostBuckets => ({ usd: {}, unpriced: {} })

/** The longest a turn's agent time counts: a gap past it is idle time, not work. */
export const TURN_IDLE_CAP_MS = 30 * 60_000

/** One assistant message (Claude), token report (Codex) or turn (Kiro) with usage, as a row of `turns`. */
export interface SpendTurn {
  /** Unique within its session, so a file read again updates the row: Claude's message id, Codex's running totals, Kiro's turn index. */
  key: string
  /** Epoch ms. */
  at: number
  model?: string
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  /** At list prices; undefined when the model has no price. */
  usd?: number
  /** Where the session was working (the same path the spend buckets use). */
  cwd: string
  /** Agent time: from the user's prompt (or the previous reply) to this one, capped at `TURN_IDLE_CAP_MS`. */
  ms: number
  /** A sub-agent's message (Claude `isSidechain`): its tokens count, its time runs inside the parent's turn. */
  sidechain?: boolean
}

/** Receives the turns a parser reads; a streamed Claude message is reported once per copy (the last one wins). */
export type TurnSink = (turn: SpendTurn) => void

/** The agent time from `start` to `at`, capped; 0 without a start. */
const turnMs = (start: number | undefined, at: number): number => (start === undefined ? 0 : Math.min(Math.max(0, at - start), TURN_IDLE_CAP_MS))
const latest = (a: number | undefined, b: number | undefined): number | undefined => (a === undefined ? b : b === undefined ? a : Math.max(a, b))

const TIMESTAMP = '"timestamp":"'

/** The last top-level-looking `timestamp` of a raw line, without parsing it (a pasted prompt can be large). */
function rawTimestamp(line: string): number | undefined {
  const i = line.lastIndexOf(TIMESTAMP)
  if (i < 0) return undefined
  const end = line.indexOf('"', i + TIMESTAMP.length)
  return end < 0 ? undefined : toMillis(line.slice(i + TIMESTAMP.length, end))
}

/** Adds a priced amount, or the tokens as unpriced when there is no price. */
function addCost(costs: CostBuckets | undefined, at: number, agent: 'claude' | 'codex', path: string, usd: number | undefined, tokens: number): void {
  if (!costs) return
  if (usd === undefined) addSpend(costs.unpriced, at, agent, path, tokens)
  else addSpend(costs.usd, at, agent, path, usd)
}

const CWD = /"cwd":"((?:[^"\\]|\\.)*)"/

/** The `cwd` field of a raw line, without parsing the whole line. */
function rawCwd(line: string): string | undefined {
  const m = CWD.exec(line)
  if (!m?.[1]) return undefined
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return undefined
  }
}

/** Resumable state of one Claude transcript. */
export interface ClaudeSpendState {
  /** The last `cwd` seen; a new one moves the work there. */
  cwd?: string
  /** Where the session works now: its cwd, or what its last edit or `cd` touched. */
  work?: string
  /** The message being streamed: its usage is repeated per block and the last copy counts. */
  pending?: { id: string; at: number; work: string; tokens: number; usd?: number; all?: number; cacheRead?: number; start?: number }
  /** When the user last prompted (read only when turns are wanted): a turn's agent time starts there or at the previous reply. */
  anchor?: number
  /** The first line's cwd and the first prompt's time (read only when turns are wanted): where and when the session started. */
  firstCwd?: string
  firstPromptAt?: number
}

/**
 * One line of a Claude Code transcript. Tokens go to where the session was working when the
 * message was written: Workhub 1's rule, so a session started at a container folder counts for the
 * repository its edits and `cd`s touched. Reading files does not move the session.
 */
export function claudeSpendLine(line: string, state: ClaudeSpendState, buckets: SpendBuckets, home = homedir(), costs?: CostBuckets, reads?: SpendBuckets, turns?: TurnSink): void {
  const cwd = rawCwd(line)
  if (cwd && cwd !== state.cwd) {
    state.cwd = cwd
    state.work = cwd
  }
  if (turns && cwd && state.firstCwd === undefined) state.firstCwd = cwd
  const sidechain = turns !== undefined && line.includes('"isSidechain":true')
  // A prompt (a user line that is not a tool's result) starts the agent's time of the next reply.
  if (turns && line.includes('"type":"user"') && !line.includes('"type":"tool_result"') && !line.includes('"type":"assistant"')) {
    const at = rawTimestamp(line)
    // A sub-agent's prompt comes from its parent's turn, not from the user.
    if (at !== undefined && !sidechain) {
      state.anchor = at
      state.firstPromptAt ??= at
    }
    return
  }
  // Only assistant messages carry usage and tool calls; user lines (tool results) can be huge.
  if (!line.includes('"assistant"')) return
  const entry = parseLine(line)
  const message = obj(entry?.['message'])
  if (!entry || entry['type'] !== 'assistant' || !message) return
  for (const block of arr(message['content'])) {
    const b = obj(block)
    if (b?.['type'] !== 'tool_use') continue
    const moved = toolWorkPaths(str(b['name']), obj(b['input']) ?? {}, state.cwd, home).at(-1)
    if (moved) state.work = moved
  }
  const id = str(message['id'])
  const usage = obj(message['usage'])
  const at = toMillis(entry['timestamp'])
  if (!id || !usage || at === undefined || !state.work) return
  const input = num(usage['input_tokens']) ?? 0
  const cacheWrite = num(usage['cache_creation_input_tokens']) ?? 0
  const cacheRead = num(usage['cache_read_input_tokens']) ?? 0
  const output = num(usage['output_tokens']) ?? 0
  const tokens = input + cacheWrite + output
  const model = str(message['model'])
  const usd = estimateCost(model, { input, cacheWrite, cacheRead, output }, true)?.amount
  const prev = state.pending
  // The agent's time of a message runs from the prompt or the previous reply, whichever came last.
  const start = prev?.id === id ? prev.start : latest(state.anchor, prev?.at)
  if (prev && prev.id !== id) commitClaude(state, buckets, costs, reads)
  state.pending = { id, at, work: state.work, tokens, all: tokens + cacheRead, cacheRead, ...(usd !== undefined ? { usd } : {}), ...(turns && start !== undefined ? { start } : {}) }
  turns?.({ key: id, at, ...(model ? { model } : {}), input, output, cacheWrite, cacheRead, ...(usd !== undefined ? { usd } : {}), cwd: state.work, ms: sidechain ? 0 : turnMs(start, at), ...(sidechain ? { sidechain } : {}) })
}

/** Counts the message being streamed; called when the next one starts. */
export function commitClaude(state: ClaudeSpendState, buckets: SpendBuckets, costs?: CostBuckets, reads?: SpendBuckets): void {
  const p = state.pending
  if (p) {
    addSpend(buckets, p.at, 'claude', p.work, p.tokens)
    if (reads) addSpend(reads, p.at, 'claude', p.work, p.cacheRead ?? 0)
    addCost(costs, p.at, 'claude', p.work, p.usd, p.all ?? p.tokens)
  }
  state.pending = undefined
}

/** The pending message as buckets of its own (`reads`: its cache reads), so a scan can show it before it is committed. */
export function claudePending(state: ClaudeSpendState, costs?: CostBuckets, reads?: SpendBuckets): SpendBuckets {
  const out: SpendBuckets = {}
  const p = state.pending
  if (p) {
    addSpend(out, p.at, 'claude', p.work, p.tokens)
    if (reads) addSpend(reads, p.at, 'claude', p.work, p.cacheRead ?? 0)
    addCost(costs, p.at, 'claude', p.work, p.usd, p.all ?? p.tokens)
  }
  return out
}

/** Resumable state of one Codex rollout. */
export interface CodexSpendState {
  cwd?: string
  /** Fresh tokens (input without cached + output) of the session so far, as last reported. */
  fresh?: number
  /** Totals come from `token_usage_record` lines (newer Codex) once one was seen. */
  records?: boolean
  /** The model of the current turn (`turn_context`), for the price. */
  model?: string
  /** The last running total, per part, to price the growth. */
  parts?: { input: number; cached: number; output: number }
  /** A ChatGPT plan's rate limits were reported: the session is not billed by API key. */
  plan?: boolean
  /** The last prompt or token report (read only when turns are wanted): the next turn's agent time starts there. */
  anchor?: number
  /** The first cwd and the first prompt's time (read only when turns are wanted). */
  firstCwd?: string
  firstPromptAt?: number
}

/**
 * One line of a Codex rollout. `token_count` events (and, in newer rollouts, `token_usage_record`
 * lines, which then win) carry the session's running totals, so the spend is the growth of the
 * fresh total since the previous one: a repeated total adds nothing.
 */
export function codexSpendLine(line: string, state: CodexSpendState, buckets: SpendBuckets, costs?: CostBuckets, reads?: SpendBuckets, turns?: TurnSink): void {
  const prompt = turns !== undefined && line.includes('"user_message"')
  if (!prompt && !line.includes('session_meta') && !line.includes('turn_context') && !line.includes('token_count') && !line.includes('token_usage_record')) return
  const entry = parseLine(line)
  const payload = obj(entry?.['payload'])
  if (!entry || !payload) return
  if (prompt && entry['type'] === 'event_msg' && payload['type'] === 'user_message') {
    state.anchor = toMillis(entry['timestamp']) ?? state.anchor
    state.firstPromptAt ??= state.anchor
    return
  }
  if (entry['type'] === 'session_meta' || entry['type'] === 'turn_context') {
    state.cwd = str(payload['cwd']) ?? state.cwd
    if (turns && state.cwd) state.firstCwd ??= state.cwd
    if (entry['type'] === 'turn_context') state.model = str(payload['model']) ?? state.model
    return
  }
  if (entry['type'] === 'event_msg' && payload['type'] === 'token_count') {
    const limits = obj(payload['rate_limits'])
    if (limits && (obj(limits['primary']) || obj(limits['secondary']) || str(limits['plan_type']))) state.plan = true
  }
  let total: Obj | undefined
  // The last request's usage: over 272K input tokens it is billed at the long-context price.
  let request: Obj | undefined
  if (entry['type'] === 'token_usage_record') {
    total = obj(payload['thread_token_usage'])
    request = obj(payload['usage'])
    // The same running total as token_count's: the growth carries on from it.
    if (total) state.records = true
  } else if (entry['type'] === 'event_msg' && payload['type'] === 'token_count' && !state.records) {
    total = obj(obj(payload['info'])?.['total_token_usage'])
    request = obj(obj(payload['info'])?.['last_token_usage'])
  }
  if (!total) return
  const input = num(total['input_tokens']) ?? 0
  const cached = num(total['cached_input_tokens']) ?? 0
  const output = num(total['output_tokens']) ?? 0
  const fresh = Math.max(0, input - cached) + output
  const prev = state.fresh ?? 0
  // A total that went down started counting again (a new session in the same file).
  const restarted = fresh < prev
  const delta = restarted ? fresh : fresh - prev
  state.fresh = fresh
  const at = toMillis(entry['timestamp'])
  addSpend(buckets, at, 'codex', state.cwd, delta)
  const last = !restarted && state.parts ? state.parts : { input: 0, cached: 0, output: 0 }
  state.parts = { input, cached, output }
  // Cached input is not part of the fresh total, so it grows (or restarts) on its own.
  if (reads) addSpend(reads, at, 'codex', state.cwd, Math.max(0, cached - last.cached))
  if (at !== undefined && state.cwd && delta > 0) {
    const grown = { input: Math.max(0, input - cached - (last.input - last.cached)), cached: Math.max(0, cached - last.cached), output: Math.max(0, output - last.output) }
    const usd = openAiCost(state.model, grown, num(request?.['input_tokens']))
    addCost(costs, at, 'codex', state.cwd, usd, grown.input + grown.cached + grown.output)
    turns?.({ key: `${input}:${cached}:${output}`, at, ...(state.model ? { model: state.model } : {}), input: grown.input, output: grown.output, cacheWrite: 0, cacheRead: grown.cached, ...(usd !== undefined ? { usd } : {}), cwd: state.cwd, ms: turnMs(state.anchor, at) })
    if (turns) state.anchor = at
  }
}

/**
 * The tokens of a Kiro ACP session file (`sessions/cli/<id>.json`): each turn's input, cache write
 * and output, at the turn's end (the file's update time when a turn has none), in the session's
 * cwd. Kiro's chat sessions record credits but no tokens, so they add nothing here.
 */
export function kiroSpendFile(text: string, buckets: SpendBuckets, reads?: SpendBuckets, turns?: TurnSink): void {
  let raw: Obj | undefined
  try {
    raw = obj(JSON.parse(text))
  } catch {
    return
  }
  const cwd = str(raw?.['cwd'])
  const fallback = toMillis(raw?.['updated_at'])
  const sessionState = obj(raw?.['session_state'])
  const sessionModel = str(obj(obj(sessionState?.['rts_model_state'])?.['model_info'])?.['model_id'])
  const list = arr(obj(sessionState?.['conversation_metadata'])?.['user_turn_metadatas'])
  list.forEach((t, index) => {
    const turn = obj(t)
    if (!turn) return
    const input = num(turn['input_token_count']) ?? 0
    const cacheWrite = num(turn['cache_write_input_token_count']) ?? 0
    const output = num(turn['output_token_count']) ?? 0
    const cacheRead = num(turn['cache_read_input_token_count']) ?? 0
    const at = toMillis(turn['end_timestamp']) ?? fallback
    addSpend(buckets, at, 'kiro', cwd, input + cacheWrite + output)
    if (reads) addSpend(reads, at, 'kiro', cwd, cacheRead)
    if (!turns || at === undefined || !cwd) return
    const d = obj(turn['turn_duration'])
    const secs = num(d?.['secs'])
    const ms = secs === undefined ? 0 : Math.min(secs * 1000 + Math.round((num(d?.['nanos']) ?? 0) / 1e6), TURN_IDLE_CAP_MS)
    const model = str(turn['model']) ?? sessionModel
    // The end time keeps the key stable if Kiro ever drops an earlier turn; the index tells equal times apart.
    turns({ key: `${str(turn['end_timestamp']) ?? at}#${index}`, at, ...(model ? { model } : {}), input, output, cacheWrite, cacheRead, cwd, ms })
  })
}
