import { redactText } from '@workhub/core'

/**
 * The last lines an agent process wrote to stderr. When an agent exits on its own (a missing
 * login, a package that failed to install, a crash), the cause is usually there and nowhere else,
 * so it goes with the error the user sees and the main log: token-like strings are redacted first.
 */
export class StderrTail {
  private readonly lines: string[] = []
  private partial = ''

  constructor(
    private readonly keep = 20,
    private readonly width = 300
  ) {}

  /** Adds a chunk as read from the pipe; a line split across chunks is joined. */
  push(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r?\n/)
    this.partial = parts.pop() ?? ''
    for (const p of parts) this.add(p)
  }

  /** The last `n` non-empty lines, oldest first, each cut to the width (escape codes removed). */
  last(n = 5): string[] {
    const all = this.partial.trim() ? [...this.lines, clean(this.partial, this.width)] : this.lines
    return all.slice(-Math.min(n, this.keep))
  }

  private add(line: string): void {
    const c = clean(line, this.width)
    if (!c) return
    this.lines.push(c)
    if (this.lines.length > this.keep) this.lines.shift()
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

function clean(line: string, width: number): string {
  // Redacted before the cut, so a token split by the width does not survive as a readable prefix.
  const c = redactText(line.replace(ANSI, '').trim(), Infinity)
  return c.length > width ? `${c.slice(0, width - 1)}…` : c
}

/** `message`, followed by what the agent last wrote to stderr when it wrote anything. */
export function withStderr(message: string, tail: StderrTail): string {
  const lines = tail.last()
  return lines.length ? `${message}:\n${lines.join('\n')}` : message
}
