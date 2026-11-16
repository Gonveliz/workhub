import { describe, expect, it } from 'vitest'
import { onAnswerFocus, optionForKey, requestAnswerFocus } from '../src/renderer/lib/pendingFocus'

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods })

describe('answering a pending request from the keyboard', () => {
  it('1-9 pick the card buttons in order', () => {
    expect(optionForKey(key('1'), 3)).toBe(0)
    expect(optionForKey(key('3'), 3)).toBe(2)
  })

  it('ignores a digit past the last button, other keys and modified digits', () => {
    expect(optionForKey(key('4'), 3)).toBeNull()
    expect(optionForKey(key('0'), 3)).toBeNull()
    expect(optionForKey(key('a'), 3)).toBeNull()
    expect(optionForKey(key('1', { metaKey: true }), 3)).toBeNull()
    expect(optionForKey(key('1', { altKey: true }), 3)).toBeNull()
  })

  it('tells the chats which session should focus its request', () => {
    const asked: string[] = []
    const off = onAnswerFocus((id) => asked.push(id))
    requestAnswerFocus('s1')
    off()
    requestAnswerFocus('s2')
    expect(asked).toEqual(['s1'])
  })
})
