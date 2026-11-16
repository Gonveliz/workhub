import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@workhub/core'
import { OutputCoalescer, OUTPUT_FLUSH_MS } from '../src/main/output-coalescer'

const out = (sessionId: string, data: string): AgentEvent => ({ sessionId, type: 'output', data })

describe('OutputCoalescer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('joins the chunks of a channel into one event per interval, in order', () => {
    const got: AgentEvent[] = []
    const c = new OutputCoalescer((e) => got.push(e))
    c.push(out('s1:console', 'a'))
    c.push(out('s1:console', 'b'))
    c.push(out('s1:console', 'c'))
    expect(got).toEqual([])
    vi.advanceTimersByTime(OUTPUT_FLUSH_MS)
    expect(got).toEqual([out('s1:console', 'abc')])
    c.push(out('s1:console', 'd'))
    vi.advanceTimersByTime(OUTPUT_FLUSH_MS)
    expect(got.map((e) => e.type === 'output' && e.data)).toEqual(['abc', 'd'])
  })

  it('keeps channels apart', () => {
    const got: AgentEvent[] = []
    const c = new OutputCoalescer((e) => got.push(e))
    c.push(out('s1:console', 'a'))
    c.push(out('s1:shell', 'x'))
    c.push(out('s1:console', 'b'))
    vi.advanceTimersByTime(OUTPUT_FLUSH_MS)
    expect(got).toEqual([out('s1:console', 'ab'), out('s1:shell', 'x')])
  })

  it('flushes at once when the pending size reaches the threshold', () => {
    const got: AgentEvent[] = []
    const c = new OutputCoalescer((e) => got.push(e), { flushChars: 10 })
    c.push(out('s1:console', '12345'))
    expect(got).toEqual([])
    c.push(out('s1:console', '67890'))
    expect(got).toEqual([out('s1:console', '1234567890')])
    vi.advanceTimersByTime(OUTPUT_FLUSH_MS * 2)
    expect(got).toHaveLength(1)
  })

  it('sends pending output before the exit of its channel, and passes other events straight through', () => {
    const got: AgentEvent[] = []
    const c = new OutputCoalescer((e) => got.push(e))
    c.push(out('s1:console', 'tail'))
    c.push(out('s1:shell', 'other'))
    c.push({ sessionId: 's1:console', type: 'exit', code: 0 })
    expect(got).toEqual([out('s1:console', 'tail'), { sessionId: 's1:console', type: 'exit', code: 0 }])
    c.push({ sessionId: 's2', type: 'exit', code: 1 })
    expect(got).toHaveLength(3)
    vi.advanceTimersByTime(OUTPUT_FLUSH_MS)
    expect(got[3]).toEqual(out('s1:shell', 'other'))
  })

  it('does not batch the events of a chat session', () => {
    const got: AgentEvent[] = []
    new OutputCoalescer((e) => got.push(e)).push(out('s1', 'text'))
    expect(got).toEqual([out('s1', 'text')])
  })
})
