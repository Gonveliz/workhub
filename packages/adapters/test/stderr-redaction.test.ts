import { describe, expect, it } from 'vitest'
import { StderrTail, withStderr } from '../src/shared/stderr-tail'

describe('StderrTail redaction', () => {
  it('masks token-like strings before they reach the log or the session error', () => {
    const tail = new StderrTail()
    tail.push('request failed with key sk-ant-api03-abcdefghijklmnop\nretry with token=abc123def456\nplain line\n')
    const text = withStderr('the bridge exited', tail)
    expect(text).not.toContain('sk-ant')
    expect(text).not.toContain('abc123def456')
    expect(text).toContain('plain line')
  })
})
