import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent, PullRequestItem } from '@workhub/core'
import { fitsFrame } from '@workhub/protocol'
import type { IpcRegistrar } from '../src/main/ipc-guard'
import { recordIpc, RemoteHub, type RemoteDevice } from '../src/main/remote'
import { REMOTE_INVOKES } from '../src/main/remote/allowlist'
import { PAGED_SOURCES, remoteAgentEvent, remoteSessionView } from '../src/main/remote/dispatcher'
import { ACTIVITY_IDS_MAX, readActivity, RemoteActivityLog } from '../src/main/remote/activity'
import type { SessionView } from '../src/shared/api'
import { pageOf, PAGE_BYTES, PAGE_DEFAULT, PAGE_MAX, readPageRequest } from '../src/main/remote/paging'
import type { CodeHostLists } from '../src/shared/codehost-api'
import type { RemoteCapability, RemotePage, RemotePullRequestsPage } from '../src/shared/remote-api'

function pr(n: number, list: 'mine' | 'toReview'): PullRequestItem {
  return {
    pr: {
      url: `https://code.example.com/acme/app/pull/${list}-${n}`,
      repo: 'acme/app',
      number: n,
      title: `Make the widget ${n} faster and keep the old behaviour behind a switch`,
      author: 'someone',
      isDraft: false,
      additions: 120,
      deletions: 30,
      headRefName: `feature/widget-${n}`,
      baseRefName: 'main',
      updatedAt: '2026-01-01T00:00:00Z',
      labels: ['area/widgets', 'needs-review'],
      reviewers: ['reviewer-a', 'reviewer-b']
    },
    status: 'approved'
  } as unknown as PullRequestItem
}

function setup(caps: RemoteCapability[] = ['sessions', 'pullRequests', 'automations'], data: { mine?: number; toReview?: number; unlinked?: number; sessions?: unknown[] } = {}) {
  const { ipc, handlers } = recordIpc({ handle: () => {}, on: () => {} } as IpcRegistrar)
  const lists = vi.fn(
    (_e: unknown, profileId: unknown): CodeHostLists => ({
      state: 'ready',
      provider: 'github',
      login: `me-${String(profileId)}`,
      updatedAt: 1,
      mine: [...Array.from({ length: data.mine ?? 3 }, (_, i) => pr(i, 'mine')), ...Array.from({ length: data.unlinked ?? 0 }, () => ({ pr: { title: 'no link' }, status: 'draft' }) as unknown as PullRequestItem)],
      toReview: Array.from({ length: data.toReview ?? 2 }, (_, i) => pr(i, 'toReview'))
    })
  )
  ipc.handle('codeHost:lists', lists)
  ipc.handle('remote:activity', () => ({ subagents: [], backgroundTasks: [] }))
  ipc.handle('sessions:list', () => data.sessions ?? [{ id: 's1', commands: [{ name: 'review', group: 'skill', description: 'x'.repeat(5000) }], models: [{ id: 'm', name: 'M', description: 'long' }] }])
  const hub = new RemoteHub({ handlers, profileFolders: async () => [], startMode: async () => null, log: { warn: vi.fn() } })
  const phone: RemoteDevice = { id: 'phone', capabilities: new Set(caps), emit: () => {} }
  hub.attach(phone)
  return { hub, lists }
}

/** Every page of a paged channel, following `nextCursor`. */
async function allPages<T>(call: (cursor: string | null) => Promise<RemotePage<T>>): Promise<RemotePage<T>[]> {
  const pages: RemotePage<T>[] = []
  let cursor: string | null = null
  do {
    const page = await call(cursor)
    pages.push(page)
    cursor = page.nextCursor
  } while (cursor && pages.length < 1000)
  return pages
}

describe('paging helpers', () => {
  it('reads a page request, with a default and a ceiling, and refuses what it did not make', () => {
    expect(readPageRequest(undefined)).toEqual({ limit: PAGE_DEFAULT, cursor: null })
    expect(readPageRequest({ limit: 10_000 }).limit).toBe(PAGE_MAX)
    expect(() => readPageRequest({ limit: 0 })).toThrow('limit')
    expect(() => readPageRequest({ limit: 1.5 })).toThrow('limit')
    expect(() => readPageRequest('page 2')).toThrow('not valid')
    expect(() => readPageRequest({ cursor: 'not a cursor!' })).toThrow('cursor')
    expect(() => readPageRequest({ cursor: Buffer.from('{"o":-1,"k":["x"]}').toString('base64url') })).toThrow('cursor')
    expect(() => readPageRequest({ cursor: 'a'.repeat(2000) })).toThrow('cursor')
  })

  /** Every item of `list` (after each page, `change` may edit it), page by page with `limit`. */
  function readAll(start: string[], limit: number, change: (list: string[], page: number) => string[] = (l) => l): { got: string[]; pages: number; last: string[] } {
    let list = start
    const got: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page: RemotePage<string> = pageOf(list, readPageRequest({ limit, ...(cursor ? { cursor } : {}) }), (x) => x)
      got.push(...page.items)
      cursor = page.nextCursor
      list = change(list, ++pages)
    } while (cursor && pages < 100)
    return { got, pages, last: list }
  }

  it('resumes after the last item sent, even when the list moved between pages', () => {
    const list = ['a', 'b', 'c', 'd', 'e']
    const first = pageOf(list, readPageRequest({ limit: 2 }), (x) => x)
    expect(first).toMatchObject({ items: ['a', 'b'], total: 5 })
    // Two items arrive at the top before the next page is asked for: it still continues after `b`.
    expect(pageOf(['y', 'z', ...list], readPageRequest({ limit: 2, cursor: first.nextCursor }), (x) => x).items).toEqual(['c', 'd'])
    // The last item sent is gone: the next page continues after the one before it, skipping nothing.
    const gone = pageOf(['a', 'c', 'd', 'e'], readPageRequest({ limit: 2, cursor: first.nextCursor }), (x) => x)
    expect(gone.items).toEqual(['c', 'd'])
  })

  it('delivers every item that survives several earlier removals', () => {
    const start = Array.from({ length: 30 }, (_, i) => `i${i}`)
    // After each page, the first three items still listed go away (all of them already sent).
    const { got, last } = readAll(start, 5, (l) => l.slice(3))
    expect(last.length).toBeGreaterThan(0)
    for (const x of last) expect(got).toContain(x)
    // And items removed right after the newest sent one (the cursor's key is gone) skip nothing either.
    const { got: got2, last: last2 } = readAll(start, 4, (l, page) => l.filter((x) => x !== `i${page * 4 - 1}` && x !== `i${page * 4 - 2}`))
    for (const x of last2) expect(got2).toContain(x)
    // Every key the cursor named is gone: it backs off a page instead of skipping.
    const first = pageOf(start, readPageRequest({ limit: 5 }), (x) => x)
    const emptied = start.slice(10)
    expect(pageOf(emptied, readPageRequest({ limit: 5, cursor: first.nextCursor }), (x) => x).items[0]).toBe('i10')
  })

  it('answers a cursor past the end with an empty last page, and one whose items all left from the start', () => {
    const first = pageOf(['a', 'b', 'c'], readPageRequest({ limit: 2 }), (x) => x)
    expect(pageOf(['a', 'b'], readPageRequest({ limit: 2, cursor: first.nextCursor }), (x) => x)).toEqual({ items: [], nextCursor: null, total: 2 })
    // Nothing it named is left and the list is shorter than where it stopped: nothing new is skipped.
    expect(pageOf(['x'], readPageRequest({ limit: 2, cursor: first.nextCursor }), (x) => x)).toEqual({ items: ['x'], nextCursor: null, total: 1 })
  })

  it('terminates on a list with repeated keys, sending every item once', () => {
    const list = ['a', 'a', 'a', 'b', 'a', 'a', 'c', 'a']
    const { got, pages } = readAll(list, 2)
    expect(got).toEqual(list)
    expect(pages).toBe(4)
  })

  it('refuses cursors whose shape it did not make', () => {
    const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
    for (const bad of [null, [1, 2], { o: 1, k: 'a' }, { o: 1, k: [1] }, { o: 1, k: [] }, { o: 'x', k: ['a'] }, 'text']) expect(() => readPageRequest({ cursor: encode(bad) })).toThrow('cursor')
  })

  it('stops a page by size before its limit, and always sends at least one item', () => {
    const big = Array.from({ length: 10 }, (_, i) => ({ id: String(i), text: 'x'.repeat(PAGE_BYTES / 4) }))
    const page = pageOf(big, readPageRequest({ limit: 10 }), (x) => x.id)
    expect(page.items.length).toBeLessThan(5)
    expect(page.nextCursor).not.toBeNull()
    const huge = [{ id: 'h', text: 'x'.repeat(PAGE_BYTES * 2) }, { id: 'small', text: '' }]
    expect(pageOf(huge, readPageRequest({}), (x) => x.id).items).toHaveLength(1)
    // With a stub, the large item is named and the page goes on.
    const stubbed = pageOf(huge, readPageRequest({}), (x) => x.id, { stub: (x) => ({ id: x.id, text: '(too large)' }) })
    expect(stubbed.items).toEqual([{ id: 'h', text: '(too large)' }, { id: 'small', text: '' }])
  })
})

describe('paged remote lists', () => {
  it('lists every paged channel in the allowlist under the capability of the list it pages', () => {
    for (const [channel, source] of Object.entries(PAGED_SOURCES)) expect(REMOTE_INVOKES[channel]).toBe(REMOTE_INVOKES[source])
    expect(Object.keys(REMOTE_INVOKES).some((c) => c.startsWith('storage:'))).toBe(false)
  })

  it('sends 2,000 pull requests a page at a time, each list on its own, every page under the relay frame', async () => {
    const { hub, lists } = setup(undefined, { mine: 1200, toReview: 800 })
    // The whole lists would not fit one frame: this is why they page.
    expect(fitsFrame({ t: 'result', id: 1, ok: true, value: await hub.invoke('phone', 'codeHost:lists', [null]) })).toBe(false)
    const first = (await hub.invoke('phone', 'remote:pullRequests', ['work', { limit: 200 }])) as RemotePullRequestsPage
    expect(fitsFrame({ t: 'result', id: 1, ok: true, value: first })).toBe(true)
    expect(first.counts).toEqual({ mine: 1200, toReview: 800 })
    expect(first.lists).toMatchObject({ state: 'ready', login: 'me-work' })
    expect(first.lists).not.toHaveProperty('mine')
    // Both lists start on the first answer: "To review" never waits behind "Mine".
    expect(first.mine!.items.length).toBeGreaterThan(0)
    expect(first.toReview!.items.length).toBeGreaterThan(0)
    for (const list of ['mine', 'toReview'] as const) {
      const pages = await allPages(async (cursor) => {
        const answer = cursor ? ((await hub.invoke('phone', 'remote:pullRequests', ['work', { list, limit: 200, cursor }])) as RemotePullRequestsPage) : first
        expect(fitsFrame({ t: 'result', id: 1, ok: true, value: answer })).toBe(true)
        if (cursor) expect(answer).not.toHaveProperty(list === 'mine' ? 'toReview' : 'mine')
        return answer[list]!
      })
      const urls = pages.flatMap((p) => p.items.map((i) => (i as PullRequestItem).pr.url))
      expect(urls).toHaveLength(list === 'mine' ? 1200 : 800)
      expect(new Set(urls).size).toBe(urls.length)
      expect(urls[0]).toContain(`${list}-0`)
    }
    expect(lists).toHaveBeenLastCalledWith(expect.anything(), 'work')
  })

  it('leaves out pull requests without a link, and refuses an unknown list', async () => {
    const { hub } = setup(undefined, { mine: 2, toReview: 0, unlinked: 3 })
    const { hub: other } = setup()
    const noLink = (await hub.invoke('phone', 'remote:pullRequests', [null])) as RemotePullRequestsPage
    expect(noLink.mine!.items).toHaveLength(2)
    expect(noLink.counts.mine).toBe(2)
    await expect(other.invoke('phone', 'remote:pullRequests', [null, { list: 'everything' }])).rejects.toThrow('list is not valid')
  })

  it('pages with the default limit when the device names none', async () => {
    const { hub } = setup(undefined, { mine: 120, toReview: 0 })
    const page = (await hub.invoke('phone', 'remote:pullRequests', [null])) as RemotePullRequestsPage
    expect(page.mine!.items).toHaveLength(PAGE_DEFAULT)
    expect(page.mine!.nextCursor).toEqual(expect.any(String))
    expect(page.toReview).toEqual({ items: [], nextCursor: null, total: 0 })
  })

  it('refuses a malformed page request or profile, and a list the device was not granted', async () => {
    const { hub } = setup(['sessions'])
    await expect(hub.invoke('phone', 'remote:pullRequests', [null])).rejects.toThrow('not available remotely')
    await expect(hub.invoke('phone', 'remote:automations', [])).rejects.toThrow('not available remotely')
    const granted = setup().hub
    await expect(granted.invoke('phone', 'remote:pullRequests', [{ id: 'x' }])).rejects.toThrow('profile is not valid')
    await expect(granted.invoke('phone', 'remote:pullRequests', [null, { cursor: 'nope!' }])).rejects.toThrow('cursor is not valid')
    await expect(granted.invoke('phone', 'remote:sessions', [{ limit: -3 }])).rejects.toThrow('limit is not valid')
  })

  it('pages the sessions trimmed as sessions:list is for a device', async () => {
    const sessions = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, commands: Array.from({ length: 300 }, (_, c) => ({ name: `cmd-${c}`, group: 'skill', description: 'd'.repeat(2000) })) }))
    const { hub } = setup(['sessions'], { sessions })
    const whole = await hub.invoke('phone', 'sessions:list', [])
    expect(fitsFrame({ t: 'result', id: 1, ok: true, value: whole })).toBe(false)
    const pages = await allPages((cursor) => hub.invoke('phone', 'remote:sessions', [cursor ? { cursor } : {}]) as Promise<RemotePage<{ id: string; commands: { description?: string }[] }>>)
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) expect(fitsFrame({ t: 'result', id: 1, ok: true, value: page })).toBe(true)
    const views = pages.flatMap((p) => p.items)
    expect(views.map((v) => v.id)).toEqual(sessions.map((s) => s.id))
    expect(views[0]!.commands[0]!.description!.length).toBeLessThanOrEqual(120)
  })

  it('does not page automations: the phone has no screen for them', async () => {
    const { hub } = setup(['automations'])
    await expect(hub.invoke('phone', 'remote:automations', [{ limit: 5 }])).rejects.toThrow('not available remotely')
    await expect(hub.invoke('phone', 'remote:automationRuns', [{ limit: 5 }])).rejects.toThrow('not available remotely')
  })

  it('sends a stub in place of a session too large for a page, so the rest of the list still goes', async () => {
    const sessions = [{ id: 's0', label: 'Huge', state: 'busy', name: 'x'.repeat(PAGE_BYTES * 2) }, { id: 's1', label: 'Small', state: 'ready' }]
    const { hub } = setup(['sessions'], { sessions })
    const page = (await hub.invoke('phone', 'remote:sessions', [{}])) as RemotePage<Record<string, unknown>>
    expect(page.items).toEqual([{ id: 's0', label: 'Huge', state: 'busy', tooLarge: true }, expect.objectContaining({ id: 's1' })])
    expect(fitsFrame({ t: 'result', id: 1, ok: true, value: page })).toBe(true)
  })

  it('refuses remote:activity to a device without the sessions capability', async () => {
    const { hub } = setup(['pullRequests'])
    await expect(hub.invoke('phone', 'remote:activity', ['s1'])).rejects.toThrow('not available remotely')
    await expect(setup(['sessions']).hub.invoke('phone', 'remote:activity', ['s1'])).resolves.toEqual({ subagents: [], backgroundTasks: [] })
  })
})

describe('what leaves the desktop about a session', () => {
  it('trims the sub-agents and tasks of a monitor update the way remote:activity does', () => {
    const e = remoteAgentEvent({
      sessionId: 's1',
      type: 'monitor',
      snapshot: {
        title: 'kept',
        subagents: [{ id: 'a', status: 'running', model: 'big', cost: { amount: 1, currency: 'USD' }, lastStep: 'z'.repeat(1000) }],
        backgroundTasks: [{ id: 't', kind: 'shell', description: 'd'.repeat(1000), since: 1 }]
      }
    } as AgentEvent) as Extract<AgentEvent, { type: 'monitor' }>
    expect(e.snapshot.title).toBe('kept')
    expect(e.snapshot.subagents![0]).not.toHaveProperty('model')
    expect(e.snapshot.subagents![0]).not.toHaveProperty('cost')
    expect(e.snapshot.subagents![0]!.lastStep!.length).toBeLessThanOrEqual(300)
    expect(e.snapshot.backgroundTasks![0]!.description.length).toBeLessThanOrEqual(300)
    const text = { sessionId: 's1', type: 'message', text: 'hi' } as unknown as AgentEvent
    expect(remoteAgentEvent(text)).toBe(text)
  })

  it('sends session:event monitor updates trimmed to a device', () => {
    const { ipc, handlers } = recordIpc({ handle: () => {}, on: () => {} } as IpcRegistrar)
    void ipc
    const hub = new RemoteHub({ handlers, profileFolders: async () => [], startMode: async () => null })
    const events: unknown[][] = []
    hub.attach({ id: 'p', capabilities: new Set(['sessions']), emit: (_c, args) => void events.push(args) })
    hub.tap('session:event', [{ sessionId: 's1', type: 'monitor', snapshot: { subagents: [{ id: 'a', tokens: { input: 1 } }] } }])
    expect((events[0]![0] as { snapshot: { subagents: object[] } }).snapshot.subagents[0]).toEqual({ id: 'a' })
  })

  it('cuts the title and detail of a waiting permission request', () => {
    const view = remoteSessionView({ id: 's1', pendingPermissions: [{ requestId: 'r', title: 't'.repeat(5000), detail: 'd'.repeat(5000), options: [], at: 1 }] } as unknown as SessionView)
    expect(view.pendingPermissions![0]!.title.length).toBeLessThanOrEqual(600)
    expect(view.pendingPermissions![0]!.detail!.length).toBeLessThanOrEqual(600)
    expect(view.pendingPermissions![0]!.requestId).toBe('r')
  })
})

describe('readActivity', () => {
  const log = new RemoteActivityLog()
  log.onEvent({ sessionId: 's1', type: 'monitor', snapshot: { subagents: [{ id: 'a', status: 'running' }] } })
  const open = () => ['s1', 's2']

  it('answers one open session, and refuses an unknown or closed one', () => {
    expect(readActivity(log, open, 's1')).toEqual({ subagents: [{ id: 'a', status: 'running' }], backgroundTasks: [] })
    expect(() => readActivity(log, open, 'gone')).toThrow('not open')
    expect(() => readActivity(log, open, 42)).toThrow('session is required')
  })

  it('answers a list of sessions by id, leaving closed ones out', () => {
    expect(readActivity(log, open, ['s1', 's2', 'gone'])).toEqual({ s1: { subagents: [{ id: 'a', status: 'running' }], backgroundTasks: [] }, s2: { subagents: [], backgroundTasks: [] } })
    expect(() => readActivity(log, open, ['s1', 3])).toThrow('not valid')
    expect(() => readActivity(log, open, Array.from({ length: ACTIVITY_IDS_MAX + 1 }, () => 's1'))).toThrow('not valid')
  })
})
