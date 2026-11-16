import { describe, expect, it } from 'vitest'
import { historyKey, promptHistory, PROMPT_HISTORY_LIMIT, type PromptHistoryState } from '../src/renderer/lib/promptHistory'

describe('promptHistory', () => {
  it('lists the user prompts newest first, without empty ones or a repeat in a row', () => {
    const items = [
      { kind: 'user', text: 'first' },
      { kind: 'agent', text: 'a reply' },
      { kind: 'user', text: '  ' },
      { kind: 'user', text: 'second' },
      { kind: 'user', text: 'second' },
      { kind: 'tool' },
      { kind: 'user', text: ' third ' }
    ]
    expect(promptHistory(items)).toEqual(['third', 'second', 'first'])
  })

  it(`keeps the newest ${PROMPT_HISTORY_LIMIT}`, () => {
    const items = Array.from({ length: 80 }, (_, i) => ({ kind: 'user', text: `p${i}` }))
    const list = promptHistory(items)
    expect(list).toHaveLength(PROMPT_HISTORY_LIMIT)
    expect(list[0]).toBe('p79')
    expect(list.at(-1)).toBe('p30')
  })
})

describe('historyKey', () => {
  const prompts = ['newest', 'older', 'oldest']

  /** Presses keys in turn with the caret at the end of the text, as after a recall. */
  function press(keys: ('up' | 'down' | 'escape')[], text = '') {
    let state: PromptHistoryState = null
    const shown: string[] = []
    for (const key of keys) {
      const r = historyKey(state, key, prompts, text, text.length)
      if (r) {
        state = r.state
        text = r.text
      }
      shown.push(text)
    }
    return { state, shown }
  }

  it('↑ goes back through the prompts and stops at the oldest', () => {
    expect(press(['up', 'up', 'up', 'up']).shown).toEqual(['newest', 'older', 'oldest', 'oldest'])
  })

  it('↓ comes forward and, past the newest, brings the draft back', () => {
    const { shown, state } = press(['up', 'up', 'down', 'down'], 'my draft')
    expect(shown).toEqual(['newest', 'older', 'newest', 'my draft'])
    expect(state).toBeNull()
  })

  it('Esc restores the draft from anywhere in the history', () => {
    const { shown, state } = press(['up', 'up', 'escape'], 'half typed')
    expect(shown.at(-1)).toBe('half typed')
    expect(state).toBeNull()
  })

  it('leaves ↓ and Esc to the composer while not browsing (Esc interrupts the agent there)', () => {
    expect(historyKey(null, 'down', prompts, '', 0)).toBeNull()
    expect(historyKey(null, 'escape', prompts, 'x', 1)).toBeNull()
  })

  it('↑ recalls only from the first line, ↓ only from the last', () => {
    expect(historyKey(null, 'up', prompts, 'line one\nline two', 12)).toBeNull()
    expect(historyKey(null, 'up', prompts, 'line one\nline two', 3)?.text).toBe('newest')
    const browsing: PromptHistoryState = { index: 1, draft: '' }
    expect(historyKey(browsing, 'down', ['a\nb', 'c'], 'a\nb', 0)).toBeNull()
    expect(historyKey(browsing, 'down', ['a\nb', 'c'], 'c', 1)?.text).toBe('a\nb')
  })

  it('does nothing without earlier prompts', () => {
    expect(historyKey(null, 'up', [], '', 0)).toBeNull()
  })
})
