/**
 * Session history of Codex: the newest rollout files under `<codex home>/sessions`, each listed from
 * as far as its first prompt, and a session's conversation read back from its rollout when it is
 * resumed (ACP restores the agent's context but does not show the earlier messages).
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { HistoryEntry, HistoryListOptions, HistoryMessage, HistoryMessagesOptions, SessionHistorySource } from '@workhub/core'
import { arr, obj, oneLine, parseLine, str, toMillis, type Obj } from '../shared/reader-utils'
import { defaultCodexHome, findRollout, readRollout, readRolloutHead, rolloutFiles, rolloutId } from './files'
import { describeCodexTool, jsonArgs, outputFailed, readSessionMeta, userItemText, userMessageText } from './parser'

export interface CodexHistoryOptions {
  /** The Codex home of an account without one. */
  defaultHome?: string
  /** Most sessions listed (newest first). */
  limit?: number
}

/** A rollout's first line is its `session_meta`, which carries the instructions: allow for it. */
const HEAD_BYTES = 256 * 1024

export class CodexSessionHistory implements SessionHistorySource {
  constructor(private readonly options: CodexHistoryOptions = {}) {}

  async list(account: { agentId: string; accountId: string | null; configDir?: string }, options?: HistoryListOptions): Promise<HistoryEntry[]> {
    const sessionsDir = join(account.configDir || this.options.defaultHome || defaultCodexHome(), 'sessions')
    const limit = options?.limit ?? this.options.limit ?? 400
    const entries: HistoryEntry[] = []
    for await (const path of rolloutFiles(sessionsDir)) {
      const entry = await this.entry(path, account)
      if (entry) entries.push(entry)
      if (entries.length >= limit) break
    }
    return entries.sort((a, b) => b.lastModified - a.lastModified)
  }

  /** The conversation stored in the session's rollout; empty when it has none. */
  async messages(agentSessionId: string, _cwd: string, configDir?: string, options?: HistoryMessagesOptions): Promise<HistoryMessage[]> {
    const sessionsDir = join(configDir || this.options.defaultHome || defaultCodexHome(), 'sessions')
    const path = await findRollout(sessionsDir, agentSessionId)
    if (!path) return []
    const messages = rolloutMessages(await readRollout(path))
    const last = options?.last
    return last && messages.length > last ? messages.slice(-last) : messages
  }

  private async entry(path: string, account: { agentId: string; accountId: string | null }): Promise<HistoryEntry | null> {
    const head = await readRolloutHead(path, HEAD_BYTES)
    let meta = readSessionMeta(undefined)
    let prompt: string | undefined
    // Newer rollouts write the prompt as an `item_completed` UserMessage; the user `message`
    // response item is the last resort.
    let fallback: string | undefined
    for (const line of head.split('\n')) {
      const entry = parseLine(line)
      const payload = obj(entry?.['payload'])
      if (!entry || !payload) continue
      if (entry['type'] === 'session_meta') meta = readSessionMeta(payload)
      else if (entry['type'] === 'event_msg' && payload['type'] === 'user_message') prompt = str(payload['message'])
      else if (entry['type'] === 'event_msg' && payload['type'] === 'item_completed') prompt = userItemText(obj(payload['item']))
      else if (entry['type'] === 'response_item') fallback ??= userMessageText(payload)
      if (prompt) break
    }
    prompt ??= fallback
    // A subagent's rollout belongs to its parent session.
    if (meta.subagent) return null
    const id = meta.id ?? rolloutId(path.split(/[\\/]/).pop() ?? '')
    if (!id) return null
    const file = await stat(path).then((s) => s, () => null)
    if (file === null) return null
    const entry: HistoryEntry = { agentId: account.agentId, accountId: account.accountId, agentSessionId: id, title: prompt ? oneLine(prompt) : id, lastModified: file.mtimeMs, sizeBytes: file.size }
    if (prompt) entry.firstPrompt = prompt
    if (meta.cwd) entry.cwd = meta.cwd
    if (meta.branch) entry.gitBranch = meta.branch
    if (meta.createdAt !== undefined) entry.createdAt = meta.createdAt
    return entry
  }
}

/** The text parts of a message response item whose content parts have the given type. */
function contentText(item: Obj, type: string): string {
  return arr(item['content'])
    .map((c) => obj(c))
    .filter((c) => c?.['type'] === type)
    .map((c) => str(c?.['text']))
    .filter((t): t is string => !!t)
    .join('\n')
    .trim()
}

/**
 * A rollout's conversation, from its `response_item` lines: what the model was sent and answered,
 * which every Codex version writes. User messages Codex injects (environment context, AGENTS.md)
 * are skipped, and so is reasoning; tool calls become tool messages, failed when their output says so.
 */
export function rolloutMessages(text: string): HistoryMessage[] {
  const messages: HistoryMessage[] = []
  const tools = new Map<string, Extract<HistoryMessage, { kind: 'tool' }>>()
  for (const line of text.split('\n')) {
    const entry = parseLine(line)
    const item = obj(entry?.['payload'])
    if (!entry || !item || entry['type'] !== 'response_item') continue
    const at = toMillis(entry['timestamp'])
    const stamp = at !== undefined ? { at } : {}
    switch (item['type']) {
      case 'message': {
        if (item['role'] === 'user') {
          const prompt = userMessageText(item)
          const images = arr(item['content']).filter((c) => obj(c)?.['type'] === 'input_image').length
          if (prompt) messages.push({ kind: 'user', ...stamp, text: prompt, ...(images ? { images } : {}) })
        } else if (item['role'] === 'assistant') {
          const answer = contentText(item, 'output_text')
          if (answer) messages.push({ kind: 'agent', ...stamp, text: answer })
        }
        break
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        const id = str(item['call_id']) ?? str(item['id'])
        if (!id) break
        const isShell = item['type'] === 'local_shell_call'
        const name = isShell ? 'shell' : (str(item['name']) ?? 'tool')
        const input = typeof item['input'] === 'string' ? item['input'] : undefined
        const args = isShell ? { command: obj(item['action'])?.['command'] } : jsonArgs(item['arguments'])
        const { title, detail } = describeCodexTool(name, args, input)
        const tool: Extract<HistoryMessage, { kind: 'tool' }> = { kind: 'tool', ...stamp, id, title, ...(detail ? { detail } : {}) }
        tools.set(id, tool)
        messages.push(tool)
        break
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const tool = tools.get(str(item['call_id']) ?? '')
        if (tool && outputFailed(item['output'])) tool.failed = true
        break
      }
    }
  }
  return messages
}
