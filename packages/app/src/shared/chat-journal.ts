// What main keeps of a session's chat, so any window can rebuild it (see main/chat-journal.ts).
import type { AgentEvent, HistoryMessage, SessionMonitorSnapshot } from '@workhub/core'

/** One step of a session's chat, as the windows receive it live. */
export type ChatEntry =
  /** An agent event that shows in the chat (messages, tool calls, permission requests, notices, compactions, the exit). */
  | { kind: 'event'; event: AgentEvent }
  /** A prompt that went out to the agent, from any window, device, automation or review. */
  | { kind: 'prompt'; text: string }
  /** A prompt's turn ended. */
  | { kind: 'turnEnd'; stopReason: string }
  /** A resumed session's earlier conversation; it replaces everything before it. */
  | { kind: 'replay'; messages: HistoryMessage[] }

/** `seq`: the session's journal sequence number of the entry's last change; `at`: epoch ms main recorded it. */
export type JournalEntry = ChatEntry & { seq: number; at: number }

/** A session's chat as main holds it: enough to rebuild the chat a window shows. */
export interface ChatJournal {
  /** The sequence number of the last message recorded: live messages at or below it are already in `entries`. */
  seq: number
  /** Older entries were dropped to stay within the bounds: the rebuilt chat says so on top. */
  truncated: boolean
  entries: JournalEntry[]
  /** The session's monitor, every update merged. */
  monitor: SessionMonitorSnapshot
}
