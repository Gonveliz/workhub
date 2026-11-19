import type { BrowserWindow } from 'electron'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StateStore } from '@workhub/core'
import { AgentChangeJournal, agentChangesWindow, registerAgentChangesIpc, type AgentChangeState, type AgentChangeTargets } from '../src/main/agent-changes'
import type { IpcRegistrar } from '../src/main/ipc-guard'
import type { AgentChange } from '../src/shared/agent-changes-api'
import { AGENT_CHANGES_WINDOW_HASH, isAgentChangesHash } from '../src/shared/agent-changes-window'
import { AgentChangesSummary } from '../src/renderer/components/organisms/AgentChangesCard'
import { countsByKind, latestChange, readableValue, shownFields } from '../src/renderer/lib/agentChanges'
import { AgentChangesList } from '../src/renderer/screens/AgentChangesWindow'

const NOW = new Date(2026, 10, 6, 12).getTime()
const MIN = 60_000
const words = { yes: 'yes', no: 'no', empty: '(empty)', locale: 'en' }

afterEach(() => vi.unstubAllGlobals())

const change = (over: Partial<AgentChange> & Pick<AgentChange, 'kind'>): AgentChange => ({
  id: `c-${Math.random().toString(36).slice(2)}`,
  at: NOW - 5 * MIN,
  session: { id: 's1', name: 'Plan grooming', agent: 'Claude Code' },
  action: 'update',
  object: { id: 'o1', name: 'Orders digest' },
  fields: ['due'],
  before: { due: '2026-11-25' },
  after: { due: '2026-11-19' },
  check: 'x',
  ...over
})

const proposed = change({
  kind: 'inboxItem',
  action: 'create',
  object: { id: 'item-1', name: 'Draft the empty-state copy' },
  fields: ['id', 'kind', 'title', 'source', 'people', 'status'],
  before: {},
  after: { id: 'item-1', kind: 'task', title: 'Draft the empty-state copy', source: { type: 'meeting', ref: 'acme-review' }, people: ['ana', 'tom'], status: 'pending' }
})

describe('readable values', () => {
  it('shows yes or no, a day as a date, a list and a flat object in a short form, and deeper values as JSON', () => {
    expect(readableValue(false, words)).toBe('no')
    expect(readableValue('2026-11-19', words)).toBe('Nov 19, 2026')
    expect(readableValue(['ana', 'tom'], words)).toBe('ana, tom')
    expect(readableValue([], words)).toBe('(empty)')
    expect(readableValue({ every: 'week', at: 9 }, words)).toBe('every: week · at: 9')
    expect(readableValue({ steps: [{ a: 1 }] }, words)).toBe('{"steps":[{"a":1}]}')
    expect(readableValue('plain text', words)).toBe('plain text')
    expect(readableValue(undefined, words)).toBeNull()
  })

  it('hides the fields nobody decides on for an added object, never for an edit', () => {
    expect(shownFields(proposed)).toEqual(['kind', 'title', 'people', 'status'])
    expect(shownFields(change({ kind: 'automation', fields: ['id', 'name'] }))).toEqual(['id', 'name'])
  })

  it('counts the changes per kind and finds the latest', () => {
    const list = [change({ kind: 'inboxItem', at: NOW - MIN }), change({ kind: 'automation' }), change({ kind: 'automation' }), change({ kind: 'milestone', at: NOW - 60 * MIN })]
    expect(countsByKind(list)).toEqual([
      { kind: 'automation', count: 2 },
      { kind: 'milestone', count: 1 },
      { kind: 'inboxItem', count: 1 }
    ])
    expect(latestChange(list)).toBe(NOW - MIN)
    expect(latestChange([])).toBeNull()
  })
})

describe('the total on Home', () => {
  const render = (changes: AgentChange[]) => renderToStaticMarkup(createElement(AgentChangesSummary, { changes, now: NOW, onOpen: () => undefined }))

  it('shows nothing while no change waits', () => {
    expect(render([])).toBe('')
  })

  it('shows the count, the kinds when there are several, when the latest happened, and only "See changes"', () => {
    const html = render([change({ kind: 'automation' }), change({ kind: 'automation' }), change({ kind: 'milestone', at: NOW - 2 * MIN })])
    expect(html).toContain('Changes by agents')
    expect(html).toContain('2 automations · 1 milestone')
    expect(html).toContain('latest 2 minutes ago')
    expect(html).toContain('data-testid="agent-changes-open"')
    expect(html).toContain('See changes')
    // The list and its Keep and Revert live in the window, not on Home; the button is outlined.
    expect(html).not.toContain('agent-change-keep')
    expect(html).not.toContain('agent-change-revert')
    expect(html).not.toContain('bg-accent text-accent-fg')
  })

  it('says how many wait in one phrase when they are all of one kind', () => {
    expect(render([change({ kind: 'inboxItem' }), change({ kind: 'inboxItem' })])).toContain('2 changes wait for review')
  })
})

describe('the window', () => {
  const render = (changes: AgentChange[]) => renderToStaticMarkup(createElement(AgentChangesList, { changes, now: NOW }))

  it('lists each change with who and when, its fields readably, and Revert and Keep', () => {
    const html = render([proposed, change({ kind: 'inboxItem', object: { id: 'item-2', name: 'Review the toolbar' } })])
    expect(html.match(/data-testid="agent-change"/g)).toHaveLength(2)
    expect(html.match(/data-testid="agent-change-keep"/g)).toHaveLength(2)
    expect(html.match(/data-testid="agent-change-revert"/g)).toHaveLength(2)
    expect(html).toContain('By Plan grooming (Claude Code)')
    expect(html).toContain('ana, tom')
    expect(html).toContain('Nov 25, 2026')
    expect(html).toContain('Nov 19, 2026')
    // An added item shows what it holds, not its id or where it came from, and no "(not set)" side.
    expect(html).not.toContain('>id<')
    expect(html).not.toContain('>source<')
    expect(html).not.toContain('acme-review')
    expect(html.match(/\(not set\)/g)).toBeNull()
  })

  it('says so when nothing waits', () => {
    expect(render([])).toContain('Nothing waits for review')
  })

  it('has a hash of its own', () => {
    expect(isAgentChangesHash(AGENT_CHANGES_WINDOW_HASH)).toBe(true)
    expect(isAgentChangesHash('#review-loop?id=x')).toBe(false)
  })
})

describe('opening the window', () => {
  const fakeWindow = () => {
    const closed: (() => void)[] = []
    const win = { isDestroyed: vi.fn(() => false), isMinimized: vi.fn(() => false), restore: vi.fn(), focus: vi.fn(), on: vi.fn((_ev: string, cb: () => void) => void closed.push(cb)) }
    return { win, close: () => closed.forEach((cb) => cb()) }
  }

  it('opens one window and brings it to the front when asked again, and a new one once it is closed', () => {
    const first = fakeWindow()
    const second = fakeWindow()
    const create = vi.fn().mockReturnValueOnce(first.win).mockReturnValueOnce(second.win)
    const open = agentChangesWindow(create as unknown as (hash: string, title: string) => BrowserWindow)
    open()
    open()
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith('#agent-changes', 'Changes by agents')
    expect(first.win.focus).toHaveBeenCalledTimes(1)
    first.close()
    open()
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('is asked for over the bridge', () => {
    const on = new Map<string, (...args: unknown[]) => void>()
    const ipc: IpcRegistrar = { handle: () => undefined, on: (channel, cb) => void on.set(channel, cb as (...args: unknown[]) => void) }
    const store: StateStore<AgentChangeState> = { load: (f) => f, save: () => undefined, flush: () => undefined }
    const openWindow = vi.fn()
    registerAgentChangesIpc(ipc, { journal: new AgentChangeJournal({ store }), targets: {} as AgentChangeTargets }, openWindow)
    on.get('agentChanges:openWindow')?.({})
    expect(openWindow).toHaveBeenCalledTimes(1)
  })
})
