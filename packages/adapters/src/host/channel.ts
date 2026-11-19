// NDJSON framing for the workhub host protocol over a pair of Node streams (a child's stdio, or
// in-memory streams in tests). Transport only: requests and responses live in client.ts/server.ts.
import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { HOST_MAX_LINE_BYTES, encodeHostMessage, parseHostLine, type HostLineRejection, type HostMessage } from '@workhub/core'

export type HostChannelNotice = { kind: 'malformed'; reason: HostLineRejection }

export interface HostChannelOptions {
  /** A line the peer sent that was not a valid message. Reported, never fatal. */
  onNotice?: (notice: HostChannelNotice) => void
}

const noop = () => {}

/**
 * One message per line in each direction. A line longer than HOST_MAX_LINE_BYTES is dropped as soon
 * as the buffered part passes the cap (reported as `too_large`), and the rest of it is skipped up to
 * the next newline, so a peer that never sends one cannot grow memory without bound.
 */
export class HostChannel {
  private readonly decoder = new StringDecoder('utf8')
  private pending: string[] = []
  private pendingBytes = 0
  private discarding = false
  private isClosed = false
  private readonly messageHandlers = new Set<(msg: HostMessage) => void>()
  private readonly closeHandlers = new Set<(err?: Error) => void>()
  private readonly onData = (chunk: Buffer | string) => this.consume(typeof chunk === 'string' ? chunk : this.decoder.write(chunk))
  private readonly onEnd = () => {
    this.consume(this.decoder.end())
    if (!this.discarding && this.pending.length > 0) this.flushLine()
    this.close()
  }
  private readonly onError = (err: Error) => this.close(err)
  private readonly onOutputClose = () => this.close()

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly options: HostChannelOptions = {}
  ) {
    input.on('data', this.onData)
    input.on('end', this.onEnd)
    input.on('error', this.onError)
    output.on('error', this.onError)
    // A stream that closes without 'end' (destroyed) still ends the channel.
    input.on('close', this.onEnd)
    output.on('close', this.onOutputClose)
  }

  get closed(): boolean {
    return this.isClosed
  }

  onMessage(handler: (msg: HostMessage) => void): () => void {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  /** Called once, with the stream error when one closed the channel. */
  onClose(handler: (err?: Error) => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  /**
   * Writes one message. Returns false when the channel is closed, and also when the output is above
   * its high-water mark: the line is queued by the stream, and callers that stream a lot (events) can
   * wait for `drained()` before sending more. Throws when the message exceeds the line cap.
   */
  send(msg: HostMessage): boolean {
    if (this.isClosed) return false
    return this.output.write(encodeHostMessage(msg))
  }

  /** Resolves once the output has room again (or the channel closed). */
  drained(): Promise<void> {
    if (this.isClosed || !this.output.writableNeedDrain) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        this.output.off('drain', done)
        offClose()
        resolve()
      }
      const offClose = this.onClose(done)
      this.output.on('drain', done)
    })
  }

  /** Stops reading, ends the output and notifies once. Later stream errors are swallowed. */
  close(err?: Error): void {
    if (this.isClosed) return
    this.isClosed = true
    this.input.off('data', this.onData)
    this.input.off('end', this.onEnd)
    this.input.off('close', this.onEnd)
    this.output.off('close', this.onOutputClose)
    this.input.off('error', this.onError)
    this.output.off('error', this.onError)
    this.input.on('error', noop)
    this.output.on('error', noop)
    // Keep draining so a peer that is still writing does not stall on a full pipe.
    this.input.resume()
    if (!this.output.writableEnded && !this.output.destroyed) this.output.end()
    this.pending = []
    for (const handler of [...this.closeHandlers]) handler(err)
    this.closeHandlers.clear()
    this.messageHandlers.clear()
  }

  private consume(text: string): void {
    let start = 0
    while (start <= text.length && !this.isClosed) {
      const newline = text.indexOf('\n', start)
      const segment = newline === -1 ? text.slice(start) : text.slice(start, newline)
      if (!this.discarding && segment.length > 0) {
        this.pendingBytes += Buffer.byteLength(segment, 'utf8')
        // +1 leaves room for the '\r' of a CRLF line; parseHostLine applies the exact cap.
        if (this.pendingBytes > HOST_MAX_LINE_BYTES + 1) {
          this.discarding = true
          this.pending = []
          this.pendingBytes = 0
          this.options.onNotice?.({ kind: 'malformed', reason: 'too_large' })
        } else this.pending.push(segment)
      }
      if (newline === -1) return
      if (this.discarding) this.discarding = false
      else this.flushLine()
      start = newline + 1
    }
  }

  private flushLine(): void {
    let line = this.pending.join('')
    this.pending = []
    this.pendingBytes = 0
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line.trim() === '') return
    const parsed = parseHostLine(line)
    if (!parsed.ok) {
      this.options.onNotice?.({ kind: 'malformed', reason: parsed.reason })
      return
    }
    for (const handler of [...this.messageHandlers]) handler(parsed.msg)
  }
}
