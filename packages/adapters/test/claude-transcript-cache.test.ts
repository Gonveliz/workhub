import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chainMessages, ClaudeSessionHistory, inProcessTranscriptReader, readTranscriptStep } from '../src/agent-claude-native/history'
import { ClaudeTranscriptCache, parseTranscriptText } from '../src/agent-claude-native/transcript'

const at = (n: number) => new Date(Date.UTC(2026, 9, 28, 10, 0, 0) + n * 1000).toISOString()

/** A synthetic conversation: user and assistant turns with tool calls, a sub-agent line, a compaction. */
function lines(from: number, to: number, first: string | null = from === 0 ? null : `a${from - 1}`): string[] {
  const out: string[] = []
  let parent = first
  for (let i = from; i < to; i++) {
    out.push(JSON.stringify({ type: 'user', uuid: `u${i}`, parentUuid: parent, timestamp: at(i * 4), message: { role: 'user', content: `question ${i} for acme` } }))
    out.push(JSON.stringify({ type: 'assistant', uuid: `t${i}`, parentUuid: `u${i}`, timestamp: at(i * 4 + 1), message: { content: [{ type: 'tool_use', id: `tool${i}`, name: 'Read', input: { file_path: `/tmp/acme/f${i}.ts` } }] } }))
    out.push(JSON.stringify({ type: 'assistant', uuid: `s${i}`, parentUuid: `t${i}`, isSidechain: true, timestamp: at(i * 4 + 1), message: { content: [{ type: 'text', text: 'side work' }] } }))
    out.push(JSON.stringify({ type: 'user', uuid: `r${i}`, parentUuid: `t${i}`, timestamp: at(i * 4 + 2), message: { content: [{ type: 'tool_result', tool_use_id: `tool${i}`, content: 'ok' }] } }))
    out.push(JSON.stringify({ type: 'assistant', uuid: `a${i}`, parentUuid: `r${i}`, timestamp: at(i * 4 + 3), message: { content: [{ type: 'text', text: `answer ${i}` }] } }))
    parent = `a${i}`
  }
  return out
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wh-transcript-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Reads a file to its end through `cache`, `chunkBytes` at a time; the number of steps it took. */
function readAll(cache: ClaudeTranscriptCache, path: string, chunkBytes: number, last?: number) {
  let steps = 0
  for (;;) {
    steps++
    const r = readTranscriptStep(cache, path, { chunkBytes, ...(last ? { last } : {}) })
    if (r.done) return { messages: r.messages, steps }
  }
}

describe('ClaudeTranscriptCache', () => {
  it('parses a growing file from its last offset, in small chunks, to the same messages as a full parse', () => {
    const path = join(dir, 'sess.jsonl')
    writeFileSync(path, lines(0, 20).join('\n') + '\n')
    const firstSize = statSync(path).size
    const cache = new ClaudeTranscriptCache()
    const first = readAll(cache, path, 512)
    expect(first.steps).toBeGreaterThan(5)
    expect(first.messages).toEqual(chainMessages(parseTranscriptText(lines(0, 20).join('\n'))))

    // The agent appends, the last line still being written: it is read once it is whole.
    const more = lines(20, 30)
    const partial = more.at(-1)!.slice(0, 40)
    appendFileSync(path, more.slice(0, -1).join('\n') + '\n' + partial)
    const before = statSync(path).size
    const grown = cache.advance(path, 1 << 20)
    // Only what was added is parsed, up to the unfinished line.
    expect(grown).toMatchObject({ done: true, offset: before - partial.length, parsed: before - partial.length - firstSize })
    appendFileSync(path, more.at(-1)!.slice(40) + '\n')
    const all = readAll(cache, path, 1 << 20)
    const full = chainMessages(parseTranscriptText(lines(0, 30).join('\n')))
    expect(all.messages).toEqual(full)
    expect(full!.at(-1)).toMatchObject({ kind: 'agent', text: 'answer 29' })
    expect(full!.filter((m) => m.kind === 'tool')).toHaveLength(30)
    // Unchanged since: nothing is read.
    expect(cache.advance(path).parsed).toBe(0)
  })

  it('keeps a last line without its newline once it is whole JSON', () => {
    const path = join(dir, 'sess.jsonl')
    writeFileSync(path, lines(0, 3).join('\n'))
    const cache = new ClaudeTranscriptCache()
    expect(readAll(cache, path, 1 << 20).messages).toEqual(chainMessages(parseTranscriptText(lines(0, 3).join('\n'))))
    appendFileSync(path, '\n' + lines(3, 4).join('\n') + '\n')
    expect(readAll(cache, path, 1 << 20).messages!.at(-1)).toMatchObject({ text: 'answer 3' })
  })

  it('answers only the last messages when asked', () => {
    const path = join(dir, 'sess.jsonl')
    writeFileSync(path, lines(0, 10).join('\n') + '\n')
    const all = readAll(new ClaudeTranscriptCache(), path, 1 << 20).messages!
    expect(readAll(new ClaudeTranscriptCache(), path, 1 << 20, 4).messages).toEqual(all.slice(-4))
  })

  it('parses a rewritten file again from the start: its head changed, or it shrank', () => {
    const path = join(dir, 'sess.jsonl')
    writeFileSync(path, lines(0, 10).join('\n') + '\n')
    const cache = new ClaudeTranscriptCache()
    readAll(cache, path, 1 << 20)

    // Same length or longer, another start (the head differs): the old lines must not survive.
    const other = lines(0, 12).map((l) => l.replace(/acme/g, 'other'))
    writeFileSync(path, other.join('\n') + '\n')
    const rewritten = readAll(cache, path, 1 << 20).messages!
    expect(rewritten).toEqual(chainMessages(parseTranscriptText(other.join('\n'))))
    expect(rewritten.some((m) => m.kind === 'user' && m.text.includes('acme'))).toBe(false)

    // Shorter than what was parsed: read again.
    writeFileSync(path, lines(0, 2).join('\n') + '\n')
    const shrunk = readAll(cache, path, 1 << 20).messages!
    expect(shrunk).toEqual(chainMessages(parseTranscriptText(lines(0, 2).join('\n'))))
    expect(shrunk.at(-1)).toMatchObject({ text: 'answer 1' })
  })

  it('drops the least recently read files past its size and forgets one that cannot be read', () => {
    const cache = new ClaudeTranscriptCache(1)
    for (const name of ['a', 'b']) {
      writeFileSync(join(dir, `${name}.jsonl`), lines(0, 2).join('\n') + '\n')
      readAll(cache, join(dir, `${name}.jsonl`), 1 << 20)
    }
    expect(cache.paths()).toEqual([join(dir, 'b.jsonl')])
    rmSync(join(dir, 'b.jsonl'))
    expect(() => readTranscriptStep(cache, join(dir, 'b.jsonl'))).toThrow()
    expect(cache.paths()).toEqual([])
  })
})

describe('ClaudeSessionHistory with a transcript reader', () => {
  it('reads the transcript through the reader it was given, passing the last messages wanted', async () => {
    mkdirSync(join(dir, 'projects', '-tmp-acme'), { recursive: true })
    const path = join(dir, 'projects', '-tmp-acme', 'sess-1.jsonl')
    writeFileSync(path, lines(0, 5).join('\n') + '\n')
    const asked: [string, number | undefined][] = []
    const inner = inProcessTranscriptReader()
    const history = new ClaudeSessionHistory({ bridgeDir: '/nonexistent', transcripts: (p, o) => (asked.push([p, o.last]), inner(p, o)) })
    const all = await history.messages('sess-1', '/tmp/acme', dir)
    expect(all.at(-1)).toMatchObject({ text: 'answer 4' })
    expect(await history.messages('sess-1', '/tmp/acme', dir, { last: 3 })).toEqual(all.slice(-3))
    expect(asked).toEqual([
      [path, undefined],
      [path, 3]
    ])
  })
})
