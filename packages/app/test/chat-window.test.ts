import { describe, expect, it } from 'vitest'
import { revealItem } from '../src/renderer/lib/chatReveal'
import { onRevealChatItem, revealChatItem, revealEarlier, revealItemStart, showJumpToLatest, turnStart, windowAfterScroll, windowStart } from '../src/renderer/lib/chatWindow'

/** A chat of `turns` turns, each a user message followed by `per - 1` agent items; ids are the indexes. */
function chat(turns: number, per: number): { id: number; kind: string }[] {
  return Array.from({ length: turns * per }, (_, id) => ({ id, kind: id % per === 0 ? 'user' : 'agent' }))
}

describe('chat window', () => {
  it('renders a short chat whole', () => {
    expect(windowStart(chat(3, 10), undefined, 200)).toBe(0)
  })

  it('renders the newest items of a long chat, starting where a turn begins', () => {
    const items = chat(100, 7) // 700 items; the raw cut (500) falls inside the turn that starts at 497
    const start = windowStart(items, undefined, 200)
    expect(start).toBe(497)
    expect(items[start]!.kind).toBe('user')
  })

  it('cuts a turn longer than the window instead of mounting it whole', () => {
    const items = chat(2, 1000)
    expect(windowStart(items, undefined, 200)).toBe(1800)
  })

  it('keeps a frozen window where it is as items arrive, and falls back when its first item is gone', () => {
    const items = chat(100, 7)
    expect(windowStart([...items, { id: 9999, kind: 'agent' }], 497, 200)).toBe(497)
    expect(windowStart(chat(10, 7), 497, 200)).toBe(0)
  })

  it('reveals the next chunk above, whole turns, until there is nothing left', () => {
    const items = chat(100, 7)
    const next = revealEarlier(items, 497, 200)
    expect(next).toBe(294) // 297 falls inside the turn that starts at 294
    expect(revealEarlier(items, 98, 200)).toBe(0)
    expect(revealEarlier(items, 0, 200)).toBeUndefined()
  })

  it('reveals an item above the window from the start of its turn, and leaves a rendered one alone', () => {
    const items = chat(100, 7)
    expect(revealItemStart(items, 497, 100, 200)).toBe(98)
    expect(revealItemStart(items, 497, 600, 200)).toBe(497)
    expect(revealItemStart(items, 497, 12345, 200)).toBeNull()
  })

  it('clamps where a window begins', () => {
    expect(turnStart(chat(2, 5), -10)).toBe(0)
    expect(turnStart([], 3)).toBe(0)
  })
})

describe('stick to the bottom', () => {
  it('freezes the window when the reader leaves the bottom and follows the chat again back there', () => {
    expect(windowAfterScroll(undefined, 497, false)).toBe(497)
    expect(windowAfterScroll(294, 294, false)).toBe(294)
    expect(windowAfterScroll(294, 294, true)).toBeUndefined()
  })

  it('offers "Jump to latest" only while a reply streams and the reader scrolled up', () => {
    expect(showJumpToLatest(false, 'busy')).toBe(true)
    expect(showJumpToLatest(true, 'busy')).toBe(false)
    expect(showJumpToLatest(false, 'ready')).toBe(false)
  })
})

describe('revealChatItem', () => {
  it('asks the mounted chats, and says whether one of them showed the item', () => {
    const asked: string[] = []
    const off = onRevealChatItem((sessionId, itemId) => {
      asked.push(`${sessionId}#${itemId}`)
      return sessionId === 's1'
    })
    expect(revealChatItem('s1', 4)).toBe(true)
    expect(revealChatItem('s2', 4)).toBe(false)
    off()
    expect(revealChatItem('s1', 4)).toBe(false)
    expect(asked).toEqual(['s1#4', 's2#4'])
  })

  it('is what find in the conversation reveals through', () => {
    const asked: string[] = []
    const off = onRevealChatItem((sessionId, itemId) => {
      asked.push(`${sessionId}#${itemId}`)
      return true
    })
    revealItem('s1', 9)
    off()
    expect(asked).toEqual(['s1#9'])
  })
})
