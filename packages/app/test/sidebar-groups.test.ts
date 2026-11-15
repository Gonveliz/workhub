import { describe, expect, it, vi } from 'vitest'
import { automaticProfileColor, PROFILE_COLORS, profileColor, sidebarRows, type SessionGroups } from '@workhub/core'
import { deletePlan, groupSummary, historyLookupKeys, listSessions, memberOf, pastTitles, rowName, runDeletePlan } from '../src/renderer/lib/sessionGroups'
import type { SessionData } from '../src/renderer/store'

function session(id: string, fields: Partial<SessionData['view']> = {}, extra: Partial<SessionData> = {}): SessionData {
  return {
    view: { id, identity: id, agentId: 'claude', accountId: null, profileId: 'acme', cwd: '/work/api', state: 'ready', startedAt: 1, agentName: 'Claude Code', adapter: 'native', ...fields },
    items: [],
    ...extra
  } as unknown as SessionData
}

const member = (key: string) => ({ key, title: key, agentKey: 'claude', cwd: '/work/api' })

describe('a group header shows when a chat inside it needs you', () => {
  const groups = (collapsed: boolean): SessionGroups => ({
    groups: [{ id: 'g', name: 'Backend', collapsed, members: [member('a'), member('b'), member('c'), member('gone')] }],
    top: [{ kind: 'group', id: 'g' }]
  })

  for (const collapsed of [false, true]) {
    it(`counts replies, questions and errors of its open sessions (${collapsed ? 'collapsed' : 'expanded'})`, () => {
      const listed = listSessions([
        session('a', {}, { unseen: 'replied' }),
        // A permission request already looked at but not answered still needs you.
        session('b', {}, { items: [{ id: 1, kind: 'permission', requestId: 'r', title: 'Run npm test', options: [] }] as unknown as SessionData['items'] }),
        session('c', { state: 'busy' })
      ])
      const [row] = sidebarRows(groups(collapsed), listed)
      expect(row?.type).toBe('group')
      if (row?.type !== 'group') return
      expect(groupSummary(row.members)).toEqual({ count: 2, level: 'needsAnswer' })
    })
  }

  it('shows nothing to do for a group whose sessions are idle or working', () => {
    const [row] = sidebarRows(groups(true), listSessions([session('a'), session('c', { state: 'busy' })]))
    if (row?.type !== 'group') throw new Error('expected a group row')
    expect(groupSummary(row.members)).toEqual({ count: 0, level: 'working' })
  })
})

describe('deleting a closed or stopped session from the sidebar', () => {
  const grouped: SessionGroups = { groups: [{ id: 'g', name: 'Backend', collapsed: false, members: [member('a')] }], top: [{ kind: 'group', id: 'g' }] }
  const loose: SessionGroups = { groups: [], top: [{ kind: 'session', key: 'a' }] }
  const entryOf = (fields: Partial<SessionData['view']>) => listSessions([session('v1', { identity: 'a', ...fields })])[0]

  it('only leaves its group when the session is closed: nothing is open to drop', () => {
    expect(deletePlan('a', undefined, grouped)).toEqual({ key: 'a', forget: true })
  })

  it('drops a stopped session by its id, and leaves its group', () => {
    expect(deletePlan('a', entryOf({ state: 'stopped' }), grouped)).toEqual({ key: 'a', closeId: 'v1', forget: true })
  })

  it('only drops a stopped session that sits outside any group', () => {
    expect(deletePlan('a', entryOf({ state: 'stopped' }), loose)).toEqual({ key: 'a', closeId: 'v1', forget: false })
  })

  it('is not offered for a session that is running, starting or in error: closing it is another action', () => {
    for (const state of ['ready', 'busy', 'starting', 'error'] as const) expect(deletePlan('a', entryOf({ state }), grouped), state).toBeNull()
  })

  it('has nothing to do for a closed session no group holds', () => {
    expect(deletePlan('a', undefined, loose)).toBeNull()
  })

  it('drops the stopped session first and then leaves the group', async () => {
    const calls: string[] = []
    await runDeletePlan(
      { key: 'a', closeId: 'v1', forget: true },
      { close: async (id) => void calls.push(`close ${id}`), forget: async (key) => void calls.push(`forget ${key}`) }
    )
    expect(calls).toEqual(['close v1', 'forget a'])
  })

  it('does not touch the group when the session could not be closed, and says why', async () => {
    const forget = vi.fn(async () => undefined)
    const close = async () => {
      throw new Error('busy')
    }
    await expect(runDeletePlan({ key: 'a', closeId: 'v1', forget: true }, { close, forget })).rejects.toThrow('busy')
    expect(forget).not.toHaveBeenCalled()
  })

  it('asks for nothing it does not need', async () => {
    const close = vi.fn(async () => undefined)
    const forget = vi.fn(async () => undefined)
    await runDeletePlan({ key: 'a', forget: true }, { close, forget })
    await runDeletePlan({ key: 'a', closeId: 'v1', forget: false }, { close, forget })
    expect(close).toHaveBeenCalledTimes(1)
    expect(forget).toHaveBeenCalledTimes(1)
  })
})

describe('profile colour of a session row', () => {
  const profiles = [{ id: 'acme' }, { id: 'side', color: '#123456' }, { id: 'third' }]

  it('is the profile’s own colour, else the palette colour of its place', () => {
    expect(profileColor(profiles, 'side')).toBe('#123456')
    expect(profileColor(profiles, 'acme')).toBe(PROFILE_COLORS[0])
    expect(profileColor(profiles, 'third')).toBe(PROFILE_COLORS[2])
    expect(automaticProfileColor(PROFILE_COLORS.length + 1)).toBe(PROFILE_COLORS[1])
  })

  it('is none for a session without a known profile', () => {
    expect(profileColor(profiles, null)).toBeUndefined()
    expect(profileColor(profiles, 'deleted')).toBeUndefined()
  })

  it('is remembered by a group member, so a closed session keeps its bar', () => {
    const [listed] = listSessions([session('a', { profileId: 'side' })])
    expect(memberOf(listed!).profileId).toBe('side')
    const [none] = listSessions([session('b', { profileId: null })])
    expect('profileId' in memberOf(none!)).toBe(false)
  })
})

describe('the name and account of a sidebar row', () => {
  const asked = (text: string) => ({ items: [{ id: 1, kind: 'user', text }] as unknown as SessionData['items'] })

  it('remembers the name, agent and account of an open session for when it is closed', () => {
    const [listed] = listSessions([session('a', { cwd: '/work/sistema-indumentaria', accountId: 'work', accountName: 'Laboral' }, asked('Stock by size'))])
    expect(memberOf(listed!)).toMatchObject({ title: 'Stock by size', titled: true, agentId: 'claude', agentName: 'Claude Code', accountId: 'work', accountName: 'Laboral' })
    const [unnamed] = listSessions([session('b', { cwd: '/work/sistema-indumentaria' })])
    expect(memberOf(unnamed!)).toMatchObject({ title: 'sistema-indumentaria' })
    expect(memberOf(unnamed!).titled).toBeUndefined()
  })

  it('is the rename, then the first prompt, then what the member remembers, then the history, then the folder', () => {
    const closed = { key: 'a', title: 'Remembered', titled: true, agentKey: 'claude', cwd: '/work/api' }
    const [renamed] = listSessions([session('a', { name: 'Mine' }, asked('first'))])
    const [prompted] = listSessions([session('a', {}, asked('first'))])
    const [bare] = listSessions([session('a')])
    expect(rowName(renamed, closed)).toBe('Mine')
    expect(rowName(prompted, closed)).toBe('first')
    expect(rowName(bare, closed, 'From history')).toBe('Remembered')
    expect(rowName(undefined, closed)).toBe('Remembered')
    const folderOnly = { ...closed, title: 'api', titled: undefined }
    expect(rowName(bare, folderOnly, 'From history')).toBe('From history')
    expect(rowName(bare, folderOnly)).toBe('api')
  })

  it('looks up in the history members without a name or account, and reopened sessions known by their folder, once', () => {
    const groups: SessionGroups = {
      groups: [{ id: 'g', name: 'W', collapsed: false, members: [member('old'), member('fresh'), { ...member('done'), titled: true, agentId: 'claude' }, { ...member('gone'), lookedUp: true }] }],
      top: [{ kind: 'group', id: 'g' }]
    }
    const listed = listSessions([
      session('fresh', { agentSessionId: 'fresh' }),
      session('resumed', { agentSessionId: 'resumed', resumed: true }),
      session('named', { agentSessionId: 'named', resumed: true }, asked('hi'))
    ])
    expect(historyLookupKeys(groups, listed, new Set())).toEqual(['old', 'resumed'])
    expect(historyLookupKeys(groups, listed, new Set(['old', 'resumed']))).toEqual([])
  })

  it('takes the newest history title of each session', () => {
    const titles = pastTitles([
      { agentId: 'claude', accountId: null, agentSessionId: 'a', title: 'Old', lastModified: 1 },
      { agentId: 'claude', accountId: 'w', agentSessionId: 'a', title: 'New', lastModified: 2 },
      { agentId: 'claude', accountId: null, agentSessionId: 'b', title: ' ', lastModified: 2 }
    ])
    expect([...titles]).toEqual([['a', 'New']])
  })
})
