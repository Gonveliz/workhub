import { describe, expect, it } from 'vitest'
import type { SessionView } from '@shared/api'
import { sameSidebarRows, sessionRows } from '../src/renderer/lib/sessionGroups'
import { getSessions, onChanged, onEvent, onRemoved, pushUser, selectKept, selectSession } from '../src/renderer/store'

const view = (id: string, startedAt: number, over: Partial<SessionView> = {}): SessionView =>
  ({ id, agentId: 'claude', profileId: 'p', cwd: `/repo/${id}`, mode: 'app', modes: ['app'], label: id, state: 'busy', startedAt, ...over }) as SessionView

const rows = (prev: ReturnType<typeof sessionRows> | undefined) => selectKept(prev, getSessions(), sessionRows, sameSidebarRows)

describe('session selectors', () => {
  it('a streamed chunk in one session keeps the other session and the rows', () => {
    onChanged(view('sel-a', 1))
    onChanged(view('sel-b', 2))
    pushUser('sel-a', 'fix the build')
    const b = selectSession(getSessions(), 'sel-b')
    const before = rows(undefined)
    expect(before.map((s) => s.view.id).filter((id) => id.startsWith('sel-'))).toEqual(['sel-b', 'sel-a'])

    onEvent({ sessionId: 'sel-a', type: 'message', role: 'agent', text: 'Working' })
    onEvent({ sessionId: 'sel-a', type: 'message', role: 'agent', text: ' on it' })
    expect(selectSession(getSessions(), 'sel-a')!.items.at(-1)).toMatchObject({ kind: 'agent', text: 'Working on it' })
    expect(selectSession(getSessions(), 'sel-b')).toBe(b)
    expect(rows(before)).toBe(before)
  })

  it('a row change, a monitor patch or a new session gives new rows', () => {
    const before = rows(undefined)
    onChanged(view('sel-a', 1, { state: 'ready' }))
    const afterView = rows(before)
    expect(afterView).not.toBe(before)

    onEvent({ sessionId: 'sel-b', type: 'monitor', snapshot: { subagents: [{ id: 'x', description: 'look around', status: 'running' }] } } as Parameters<typeof onEvent>[0])
    const afterMonitor = rows(afterView)
    expect(afterMonitor).not.toBe(afterView)

    onChanged(view('sel-c', 3))
    expect(rows(afterMonitor)[0]!.view.id).toBe('sel-c')
    for (const id of ['sel-a', 'sel-b', 'sel-c']) onRemoved(id)
  })

  it('selects nothing without an id or for a session that is not open', () => {
    expect(selectSession(getSessions(), null)).toBeUndefined()
    expect(selectSession(getSessions(), 'sel-gone')).toBeUndefined()
  })
})
