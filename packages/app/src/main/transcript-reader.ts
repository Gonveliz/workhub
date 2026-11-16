/**
 * Reads Claude transcripts' replayed conversations in a separate process (`transcript-worker.ts`),
 * one request at a time: a resume's replay, a phone's page of a conversation and History's indexing
 * never parse a transcript on the main process. A transcript is read in requests of at most
 * `chunkBytes` new bytes each, so a large first parse never holds the queue for long: a replay asked
 * for meanwhile is answered between two chunks.
 *
 * The process starts with the first request and keeps its per-file parses between requests. One
 * that outlives the budget gets the process killed (its parses with it) and is rejected; the next
 * request starts a new process. `close` stops it on quit.
 *
 * Without `spawn` (tests) the same parse runs in this process, `inProcessTranscriptReader`.
 */
import { inProcessTranscriptReader, type ClaudeTranscriptReader, type TranscriptRead } from '@workhub/adapters/agent-claude-native/history'
import type { HistoryMessage } from '@workhub/core'
import type { TranscriptWorkerRead, TranscriptWorkerReply } from './transcript-worker'

/** A running worker process, whatever started it (Electron's utilityProcess, a fake in tests). */
export interface TranscriptWorker {
  post(msg: TranscriptWorkerRead): void
  onMessage(fn: (msg: TranscriptWorkerReply) => void): void
  onExit(fn: (code: number | null) => void): void
  kill(): void
}

/** New bytes of a transcript parsed per request: about a second of parsing at most. */
export const TRANSCRIPT_REQUEST_BYTES = 8 * 1024 * 1024
/** A request that takes longer has a stuck process: it is killed. */
export const TRANSCRIPT_BUDGET_MS = 30_000

export interface TranscriptReaderOptions {
  spawn?: () => TranscriptWorker
  budgetMs?: number
  chunkBytes?: number
  log?: (message: string) => void
}

/** The error a request gets when it outlives the budget (its process is killed). */
export class TranscriptReadTimedOut extends Error {
  constructor(budgetMs: number) {
    super(`reading the transcript took longer than ${Math.round(budgetMs / 1000)} s and was stopped`)
  }
}

interface Live {
  worker: TranscriptWorker
  pending: Map<number, (reply: TranscriptWorkerReply | { type: 'exit'; code: number | null }) => void>
}

export class TranscriptReader {
  private live: Live | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private nextId = 1
  private closed = false
  private readonly local: ClaudeTranscriptReader | null

  constructor(private readonly options: TranscriptReaderOptions = {}) {
    this.local = options.spawn ? null : inProcessTranscriptReader()
  }

  /** The conversation of the transcript at `path` (its `last` messages when given); null when it has none. */
  async messages(path: string, options: { last?: number } = {}): Promise<HistoryMessage[] | null> {
    if (this.local) return this.local(path, options)
    for (;;) {
      const step = await this.queue(() => this.one(path, options.last))
      if (step.done) return step.messages ?? null
    }
  }

  /** As `ClaudeSessionHistory` takes it. */
  readonly read: ClaudeTranscriptReader = (path, options) => this.messages(path, options)

  private queue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task)
    this.tail = result.catch(() => undefined)
    return result
  }

  private start(): Live {
    if (this.closed) throw new Error('the transcript reader is closed')
    if (this.live) return this.live
    const worker = this.options.spawn!()
    const live: Live = { worker, pending: new Map() }
    worker.onMessage((msg) => {
      const done = live.pending.get(msg.id)
      live.pending.delete(msg.id)
      done?.(msg)
    })
    worker.onExit((code) => {
      if (this.live === live) this.live = null
      for (const done of live.pending.values()) done({ type: 'exit', code })
      live.pending.clear()
    })
    this.live = live
    return live
  }

  private async one(path: string, last: number | undefined): Promise<TranscriptRead> {
    const budget = this.options.budgetMs ?? TRANSCRIPT_BUDGET_MS
    const live = this.start()
    const id = this.nextId++
    return new Promise<TranscriptRead>((resolve, reject) => {
      const timer = setTimeout(() => {
        live.pending.delete(id)
        this.stop(live)
        this.options.log?.(`transcript worker: a read stopped after ${budget} ms (process killed)`)
        reject(new TranscriptReadTimedOut(budget))
      }, budget)
      live.pending.set(id, (reply) => {
        clearTimeout(timer)
        if (reply.type === 'read') resolve(reply.value)
        else if (reply.type === 'error') reject(new Error(reply.message))
        else reject(new Error(`the transcript process stopped (exit code ${String(reply.code)})`))
      })
      live.worker.post({ type: 'read', id, path, chunkBytes: this.options.chunkBytes ?? TRANSCRIPT_REQUEST_BYTES, ...(last ? { last } : {}) })
    })
  }

  private stop(live: Live): void {
    if (this.live === live) this.live = null
    try {
      live.worker.kill()
    } catch {
      // Already gone.
    }
  }

  /** Stops the worker (on quit); reads after it are rejected. */
  close(): void {
    this.closed = true
    if (this.live) this.stop(this.live)
  }
}
