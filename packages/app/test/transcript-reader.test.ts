import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TranscriptReader, TranscriptReadTimedOut, type TranscriptWorker } from '../src/main/transcript-reader'
import type { TranscriptWorkerRead, TranscriptWorkerReply } from '../src/main/transcript-worker'

/** A worker whose answers the test gives; `spawned` counts the processes started. */
function fakeWorker(answer: (msg: TranscriptWorkerRead, reply: (r: TranscriptWorkerReply) => void) => void) {
  const state = { spawned: 0, killed: 0, posted: [] as TranscriptWorkerRead[] }
  const spawn = (): TranscriptWorker => {
    state.spawned++
    let onMessage: (m: TranscriptWorkerReply) => void = () => {}
    let onExit: (code: number | null) => void = () => {}
    return {
      post: (m) => {
        state.posted.push(m)
        answer(m, (r) => setTimeout(() => onMessage(r), 0))
      },
      onMessage: (fn) => (onMessage = fn),
      onExit: (fn) => (onExit = fn),
      kill: () => {
        state.killed++
        onExit(null)
      }
    }
  }
  return { state, spawn }
}

describe('TranscriptReader with a fake worker', () => {
  it('asks in bounded chunks until the end, then answers the messages', async () => {
    const w = fakeWorker((m, reply) => {
      const offset = (w.state.posted.length) * m.chunkBytes
      reply({ type: 'read', id: m.id, value: offset >= 30 ? { done: true, offset: 30, size: 30, messages: [{ kind: 'user', text: 'hi' }] } : { done: false, offset, size: 30 } })
    })
    const reader = new TranscriptReader({ spawn: w.spawn, chunkBytes: 10 })
    expect(await reader.messages('/tmp/acme/sess.jsonl', { last: 5 })).toEqual([{ kind: 'user', text: 'hi' }])
    expect(w.state.posted.map((p) => [p.path, p.chunkBytes, p.last])).toEqual(Array(3).fill(['/tmp/acme/sess.jsonl', 10, 5]))
    expect(w.state.spawned).toBe(1)
  })

  it('kills a worker that outlives the budget, rejects, and starts a new one for the next read', async () => {
    let hang = true
    const logs: string[] = []
    const w = fakeWorker((m, reply) => {
      if (!hang) reply({ type: 'read', id: m.id, value: { done: true, offset: 0, size: 0, messages: null } })
    })
    const reader = new TranscriptReader({ spawn: w.spawn, budgetMs: 30, log: (l) => logs.push(l) })
    await expect(reader.messages('/tmp/acme/big.jsonl')).rejects.toBeInstanceOf(TranscriptReadTimedOut)
    expect(w.state.killed).toBe(1)
    expect(logs[0]).toContain('process killed')
    hang = false
    expect(await reader.messages('/tmp/acme/big.jsonl')).toBeNull()
    expect(w.state.spawned).toBe(2)
  })

  it('rejects a read whose worker errs or dies, and closes it on quit', async () => {
    const w = fakeWorker((m, reply) => reply({ type: 'error', id: m.id, message: 'ENOENT: no such file' }))
    const reader = new TranscriptReader({ spawn: w.spawn })
    await expect(reader.messages('/tmp/acme/gone.jsonl')).rejects.toThrow('ENOENT')
    reader.close()
    expect(w.state.killed).toBe(1)

    const dying = fakeWorker(() => {})
    const other = new TranscriptReader({ spawn: dying.spawn })
    const read = other.messages('/tmp/acme/sess.jsonl')
    await new Promise((r) => setTimeout(r, 0))
    other.close()
    await expect(read).rejects.toThrow('stopped')
    await expect(other.messages('/tmp/acme/sess.jsonl')).rejects.toThrow('closed')
  })
})

describe('TranscriptReader in process', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('parses the file without a worker', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wh-transcript-'))
    const path = join(dir, 'sess.jsonl')
    writeFileSync(path, [
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-10-28T10:00:00.000Z', message: { content: 'hello acme' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-10-28T10:00:01.000Z', message: { content: [{ type: 'text', text: 'hi' }] } })
    ].join('\n') + '\n')
    expect(await new TranscriptReader().messages(path)).toEqual([
      { kind: 'user', at: Date.parse('2026-10-28T10:00:00.000Z'), text: 'hello acme' },
      { kind: 'agent', at: Date.parse('2026-10-28T10:00:01.000Z'), text: 'hi' }
    ])
  })
})
