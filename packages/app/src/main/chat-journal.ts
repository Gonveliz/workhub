import { mergeMonitor, type AgentEvent, type HistoryMessage, type SessionMonitorSnapshot } from '@workhub/core'
import type { ChatEntry, ChatJournal, JournalEntry } from '../shared/chat-journal'

/** Most entries kept per session (a streamed reply is one entry: its deltas are merged). */
export const JOURNAL_MAX_ENTRIES = 2000
/** Most characters of JSON kept per session, roughly its size in memory. */
export const JOURNAL_MAX_BYTES = 4 * 1024 * 1024

/** The agent events that change what the chat shows (the renderer store's `applyEvent`), and the monitor. */
const CHAT_EVENTS = new Set<AgentEvent['type']>(['message', 'tool', 'permission', 'permissionCancelled', 'notice', 'compaction', 'exit', 'monitor'])

interface Journal {
  seq: number
  truncated: boolean
  entries: JournalEntry[]
  /** Each entry's size, in step with `entries`. */
  sizes: number[]
  bytes: number
  monitor: SessionMonitorSnapshot
}

const sizeOf = (value: unknown): number => JSON.stringify(value)?.length ?? 0

/**
 * The chat of every live session, kept in main so a window that loads later (a reload after a
 * crash, a session window, the main window when a session is docked back) rebuilds it. Main sends
 * every chat message through `tap`, which records it and appends its sequence number: a window
 * rebuilding from `get` applies only the live messages numbered after the journal's `seq`.
 *
 * It keeps the events, not the chat items: the renderer's reducer stays the only code that turns
 * events into items, so a rebuilt chat is the live one by construction.
 */
export class ChatJournals {
  private readonly journals = new Map<string, Journal>()

  constructor(
    private readonly limits: { entries: number; bytes: number } = { entries: JOURNAL_MAX_ENTRIES, bytes: JOURNAL_MAX_BYTES },
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Records a message main sends to the windows when it belongs to a session's chat, and returns
   * its arguments with the sequence number appended; any other message goes out unchanged.
   */
  tap(channel: string, args: unknown[]): unknown[] {
    const [first, second] = args
    switch (channel) {
      case 'session:event': {
        const e = first as AgentEvent | undefined
        // Terminal channels (`<session>:console`) carry raw output, which the chat does not show.
        if (!e || typeof e !== 'object' || typeof e.sessionId !== 'string' || e.sessionId.includes(':') || !CHAT_EVENTS.has(e.type)) return args
        return [e, this.event(e)]
      }
      case 'session:replay':
        if (typeof first !== 'string' || !Array.isArray(second)) return args
        return [first, second, this.replay(first, second as HistoryMessage[])]
      case 'automations:prompted':
        if (typeof first !== 'string' || typeof second !== 'string') return args
        return [first, second, this.append(first, { kind: 'prompt', text: second })]
      case 'automations:turnEnded':
        if (typeof first !== 'string' || typeof second !== 'string') return args
        return [first, second, this.append(first, { kind: 'turnEnd', stopReason: second })]
      case 'session:removed':
        if (typeof first === 'string') this.journals.delete(first)
        return args
      default:
        return args
    }
  }

  /** The number the next message of a session will get (a prompt's sender learns it before the others). */
  nextSeq(sessionId: string): number {
    return (this.journals.get(sessionId)?.seq ?? 0) + 1
  }

  /** A copy of a session's journal; an unknown session has an empty one. */
  get(sessionId: string): ChatJournal {
    const j = this.journals.get(sessionId)
    if (!j) return { seq: 0, truncated: false, entries: [], monitor: {} }
    return { seq: j.seq, truncated: j.truncated, entries: [...j.entries], monitor: j.monitor }
  }

  private journal(sessionId: string): Journal {
    let j = this.journals.get(sessionId)
    if (!j) {
      j = { seq: 0, truncated: false, entries: [], sizes: [], bytes: 0, monitor: {} }
      this.journals.set(sessionId, j)
    }
    return j
  }

  private event(e: AgentEvent): number {
    const j = this.journal(e.sessionId)
    if (e.type === 'monitor') {
      j.monitor = mergeMonitor(j.monitor, e.snapshot)
      return ++j.seq
    }
    const last = j.entries[j.entries.length - 1]
    // A streamed reply is many small deltas: one entry, as the chat shows one message.
    if (e.type === 'message' && last?.kind === 'event' && last.event.type === 'message' && last.event.role === e.role) {
      const seq = ++j.seq
      j.entries[j.entries.length - 1] = { ...last, seq, event: { ...last.event, text: last.event.text + e.text } }
      j.sizes[j.sizes.length - 1]! += e.text.length
      j.bytes += e.text.length
      this.trim(j)
      return seq
    }
    return this.append(e.sessionId, { kind: 'event', event: e })
  }

  /**
   * A resumed session's earlier conversation replaces its chat (the transcript holds what came
   * before), so the journal starts over from it and never holds the same messages twice.
   */
  private replay(sessionId: string, messages: HistoryMessage[]): number {
    const j = this.journal(sessionId)
    const sizes = messages.map(sizeOf)
    let start = 0
    let bytes = sizes.reduce((a, b) => a + b, 0)
    while (start < messages.length - 1 && (messages.length - start > this.limits.entries || bytes > this.limits.bytes)) bytes -= sizes[start++]!
    const seq = ++j.seq
    j.entries = [{ kind: 'replay', messages: start ? messages.slice(start) : messages, seq, at: this.now() }]
    j.sizes = [bytes]
    j.bytes = bytes
    j.truncated = start > 0
    return seq
  }

  private append(sessionId: string, entry: ChatEntry): number {
    const j = this.journal(sessionId)
    const seq = ++j.seq
    const full = { ...entry, seq, at: this.now() } as JournalEntry
    const size = sizeOf(full)
    j.entries.push(full)
    j.sizes.push(size)
    j.bytes += size
    this.trim(j)
    return seq
  }

  /** Oldest entries go first; the newest stays even when it alone is past the size limit. */
  private trim(j: Journal): void {
    while (j.entries.length > 1 && (j.entries.length > this.limits.entries || j.bytes > this.limits.bytes)) {
      j.entries.shift()
      j.bytes -= j.sizes.shift()!
      j.truncated = true
    }
  }
}
