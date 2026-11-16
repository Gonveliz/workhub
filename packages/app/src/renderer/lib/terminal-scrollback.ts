/** Characters of raw output kept per terminal channel when no scrollback preference says otherwise (10,000 lines). */
export const TERMINAL_SCROLLBACK_CHARS = 2 * 1024 * 1024

/** Raw characters one scrollback line takes on average, escape sequences included: lines to characters. */
const CHARS_PER_LINE = 200

/** The replay cap that matches a scrollback of `lines` lines, so a remounted terminal gets back what it held. */
export function scrollbackChars(lines: number): number {
  return Math.max(1, Math.round(lines)) * CHARS_PER_LINE
}

/**
 * The raw output of each terminal channel (`<session>:console`, `<session>:shell`), kept whether a
 * terminal view shows it or not, so a view that mounts later (the session moved to its own window,
 * or back) starts from what the terminal already showed. The oldest chunks go first once a channel
 * holds more than `limit` characters; a chunk is never cut, so no escape sequence is split.
 */
export class TerminalScrollback {
  private readonly channels = new Map<string, { chunks: string[]; size: number }>()

  constructor(private readonly limitOf: number | (() => number) = TERMINAL_SCROLLBACK_CHARS) {}

  private get limit(): number {
    return typeof this.limitOf === 'function' ? this.limitOf() : this.limitOf
  }

  append(channel: string, data: string): void {
    if (!data) return
    let c = this.channels.get(channel)
    if (!c) this.channels.set(channel, (c = { chunks: [], size: 0 }))
    c.chunks.push(data)
    c.size += data.length
    while (c.size > this.limit && c.chunks.length > 1) c.size -= c.chunks.shift()!.length
  }

  /** Everything kept for the channel, oldest first. */
  text(channel: string): string {
    return this.channels.get(channel)?.chunks.join('') ?? ''
  }

  /** Replaces what the channel holds (a session window takes the main window's output). */
  replace(channel: string, data: string): void {
    this.channels.delete(channel)
    this.append(channel, data)
  }

  /** The channels of a session (`<session>:…`) with their output. */
  ofSession(sessionId: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const channel of this.channels.keys()) if (channel.startsWith(`${sessionId}:`)) out[channel] = this.text(channel)
    return out
  }

  dropSession(sessionId: string): void {
    for (const channel of [...this.channels.keys()]) if (channel.startsWith(`${sessionId}:`)) this.channels.delete(channel)
  }
}
