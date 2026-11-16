import { describe, expect, it } from 'vitest'
import { findMatches, itemSearchText, stepMatch } from '../src/renderer/lib/chatFind'
import { chatItemElement, onFindRequest, requestFind, revealItem, setRevealItem } from '../src/renderer/lib/chatReveal'
import type { ChatItem } from '../src/renderer/store'

const items: ChatItem[] = [
  { id: 1, kind: 'user', text: 'Fix the Login bug' },
  { id: 2, kind: 'thought', text: 'login is hidden thinking' },
  { id: 3, kind: 'agent', text: 'The login form calls LOGIN twice; login again.' },
  { id: 4, kind: 'tool', toolCallId: 't', title: 'Edit login.ts', status: 'completed', detail: 'login in the output' },
  { id: 5, kind: 'turnEnd', stopReason: 'end_turn' }
]

describe('find in conversation', () => {
  it('matches case-insensitively and counts every occurrence, in chat order', () => {
    const found = findMatches(items, 'LOGIN')
    expect(found).toEqual([
      { itemId: 1, occurrence: 0 },
      { itemId: 3, occurrence: 0 },
      { itemId: 3, occurrence: 1 },
      { itemId: 3, occurrence: 2 },
      { itemId: 4, occurrence: 0 }
    ])
  })

  it('searches what the chat shows, not collapsed thinking, tool output or turn markers', () => {
    expect(itemSearchText(items[1]!)).toBe('')
    expect(findMatches(items, 'hidden')).toEqual([])
    expect(findMatches(items, 'output')).toEqual([])
    expect(findMatches(items, 'end_turn')).toEqual([])
  })

  it('finds nothing for an empty query or a missing word and does not overlap occurrences', () => {
    expect(findMatches(items, '')).toEqual([])
    expect(findMatches(items, 'zebra')).toEqual([])
    expect(findMatches([{ id: 1, kind: 'agent', text: 'aaaa' }], 'aa')).toHaveLength(2)
  })

  it('steps through the matches and wraps around at both ends', () => {
    expect(stepMatch(0, 3, 1)).toBe(1)
    expect(stepMatch(2, 3, 1)).toBe(0)
    expect(stepMatch(0, 3, -1)).toBe(2)
    expect(stepMatch(1, 3, -1)).toBe(0)
    expect(stepMatch(0, 1, 1)).toBe(0)
  })

  it('has no position without matches, and starts from an end when there is none yet', () => {
    expect(stepMatch(0, 0, 1)).toBe(-1)
    expect(stepMatch(-1, 4, 1)).toBe(0)
    expect(stepMatch(-1, 4, -1)).toBe(3)
  })
})

describe('reveal item hook', () => {
  it('calls the replacement and goes back to the default when it is removed', () => {
    const seen: [string, number][] = []
    const off = setRevealItem((s, i) => void seen.push([s, i]))
    revealItem('s1', 7)
    expect(seen).toEqual([['s1', 7]])
    off()
    // Without a DOM the default does nothing and does not throw in the node test environment.
    expect(() => chatItemElement({ querySelector: () => null } as unknown as ParentNode, 7)).not.toThrow()
    expect(chatItemElement({ querySelector: (q: string) => ({ q }) } as unknown as ParentNode, 7)).toEqual({ q: '[data-chat-item="7"]' })
  })

  it('tells the listening chat which session asked for find', () => {
    const asked: string[] = []
    const off = onFindRequest((id) => asked.push(id))
    requestFind('s1')
    off()
    requestFind('s2')
    expect(asked).toEqual(['s1'])
  })
})
