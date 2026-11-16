import { describe, expect, it } from 'vitest'
import { createGroup, EMPTY_SESSION_GROUPS, moveToGroup, needsYou, nextNeedingYou, setGroupCollapsed, sidebarOrder, sidebarRows, stepSession, type AttentionInput, type GroupMember } from '../src'

const member = (key: string): GroupMember => ({ key, title: key, agentKey: 'claude', cwd: '/work/acme' })

describe('sidebarOrder', () => {
  it('lists open sessions top to bottom: a group sub-groups first, folded groups included, closed members skipped', () => {
    let s = createGroup(EMPTY_SESSION_GROUPS, 'work', 'Work')
    s = createGroup(s, 'backend', 'Backend', undefined, undefined, 'work')
    s = moveToGroup(s, member('a'), 'work')
    s = moveToGroup(s, member('b'), 'backend')
    s = moveToGroup(s, member('closed'), 'work')
    s = setGroupCollapsed(s, 'work', true)
    const rows = sidebarRows(s, [{ key: 'a' }, { key: 'b' }, { key: 'loose' }])
    const order = sidebarOrder(rows).map((x) => x.key)
    expect(order.filter((k) => k !== 'loose')).toEqual(['b', 'a'])
    expect(order).toContain('loose')
    expect(order).not.toContain('closed')
    expect(order).toHaveLength(3)
  })
})

describe('stepSession', () => {
  const order = ['a', 'b', 'c']

  it('moves one step and wraps around at either end', () => {
    expect(stepSession(order, 'a', 1)).toBe('b')
    expect(stepSession(order, 'c', 1)).toBe('a')
    expect(stepSession(order, 'a', -1)).toBe('c')
    expect(stepSession(order, 'b', -1)).toBe('a')
  })

  it('starts at the first (forward) or last (back) without a current session', () => {
    expect(stepSession(order, null, 1)).toBe('a')
    expect(stepSession(order, 'gone', -1)).toBe('c')
    expect(stepSession([], 'a', 1)).toBeNull()
  })
})

describe('nextNeedingYou', () => {
  const ready: AttentionInput = { state: 'ready' }
  const working: AttentionInput = { state: 'busy' }
  const asking: AttentionInput = { state: 'ready', awaitingAnswer: true }
  const replied: AttentionInput = { state: 'ready', unseen: 'replied' }
  const failed: AttentionInput = { state: 'error' }

  it('counts questions, unread replies and failures, not working or idle sessions', () => {
    expect([asking, replied, failed].map(needsYou)).toEqual([true, true, true])
    expect([ready, working].map(needsYou)).toEqual([false, false])
  })

  it('cycles through the sessions that need you in sidebar order', () => {
    const order = [
      { id: 'a', attention: asking },
      { id: 'b', attention: working },
      { id: 'c', attention: replied },
      { id: 'd', attention: ready },
      { id: 'e', attention: failed }
    ]
    expect(nextNeedingYou(order, null)).toBe('a')
    expect(nextNeedingYou(order, 'a')).toBe('c')
    expect(nextNeedingYou(order, 'c')).toBe('e')
    expect(nextNeedingYou(order, 'e')).toBe('a')
    // From a session that needs nothing: the next one after it.
    expect(nextNeedingYou(order, 'd')).toBe('e')
  })

  it('is null when no other session needs you', () => {
    expect(nextNeedingYou([{ id: 'a', attention: asking }, { id: 'b', attention: ready }], 'a')).toBeNull()
    expect(nextNeedingYou([{ id: 'a', attention: ready }], null)).toBeNull()
    expect(nextNeedingYou([], null)).toBeNull()
  })
})
