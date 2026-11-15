import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent, PullRequestItem, SubagentSummary } from '@workhub/core'
import { BackgroundTasksRow, runningSubagents, SessionActivity, SUBAGENT_STALE_MS, SubagentsRunningRow } from '../src/web/screens/SessionActivity'
import { PullRequestLists } from '../src/web/screens/PullRequestsScreen'
import { cachedPullRequests, prFailed, prLoaded, prLoading, prStateFrom } from '../src/web/pr-pages'
import { refreshActivity } from '../src/web/activity'
import type { RemotePullRequestsPage } from '../src/shared/remote-api'

const sub = (id: string, status: string | undefined, startedAt: number, description?: string, lastActivityAt?: number): SubagentSummary => ({ id, status, startedAt, type: 'general-purpose', ...(description ? { description } : {}), ...(lastActivityAt !== undefined ? { lastActivityAt } : {}) })
const NOW = 100 * 60_000

describe('sub-agents in a session chat on the phone', () => {
  it('lists the ones at work, oldest first, leaving out ended ones and silent ones with no status', () => {
    const list = runningSubagents([sub('b', 'running', 20), sub('done', 'completed', 5), sub('a', undefined, NOW - 1000), sub('bg', 'background', 30), sub('x', 'failed', 1), sub('stale', undefined, 0, undefined, NOW - SUBAGENT_STALE_MS - 1)], NOW)
    expect(list.map((s) => s.id)).toEqual(['b', 'bg', 'a'])
    expect(runningSubagents(undefined, NOW)).toEqual([])
  })

  it('shows how many run and their names, each a tap target opening its conversation', () => {
    const html = renderToStaticMarkup(createElement(SubagentsRunningRow, { sessionId: 's1', subagents: [sub('a', 'running', 1, 'Explore the parser'), sub('b', 'running', 2)] }))
    expect(html).toContain('data-testid="subagents-running"')
    expect(html).toContain('2 sub-agents running')
    expect(html).toContain('Explore the parser')
    expect(html).toContain('general-purpose')
    expect(html.match(/data-testid="subagent-chip"/g)).toHaveLength(2)
    expect(html).toContain('min-h-11')
    expect(renderToStaticMarkup(createElement(SubagentsRunningRow, { sessionId: 's1', subagents: [sub('a', 'running', 1)] }))).toContain('1 sub-agent running')
  })

  it('folds the background tasks into one line that opens the desktop notice', () => {
    const tasks = [{ id: 't1', kind: 'shell' as const, description: 'Wait for CI checks', since: 0 }, { id: 't2', kind: 'monitor' as const, description: 'Watch the log', since: 0 }]
    const folded = renderToStaticMarkup(createElement(BackgroundTasksRow, { tasks, now: 65_000 }))
    expect(folded).toContain('2 background tasks')
    expect(folded).toContain('aria-expanded="false"')
    // The visible count is the button's name: no aria-label hides it.
    expect(folded).not.toMatch(/<button[^>]*aria-label/)
    expect(folded).not.toContain('Wait for CI checks')
    const open = renderToStaticMarkup(createElement(BackgroundTasksRow, { tasks, now: 65_000, initiallyOpen: true }))
    expect(open).toContain('data-testid="background-tasks-notice"')
    expect(open).toContain('Wait for CI checks')
    expect(open).toContain('1 min 5 s')
  })

  it('disappears when none runs or the session stopped, and counts background tasks without sub-agents', () => {
    expect(renderToStaticMarkup(createElement(SessionActivity, { sessionId: 's1', state: 'busy', monitor: { subagents: [sub('a', 'completed', 1)] }, now: NOW }))).toBe('')
    const monitor = { subagents: [sub('a', 'running', 1)], backgroundTasks: [{ id: 't1', kind: 'shell' as const, description: 'Wait for CI checks', since: 0 }, { id: 'sa', kind: 'agent' as const, description: 'a sub-agent', since: 0 }] }
    const html = renderToStaticMarkup(createElement(SessionActivity, { sessionId: 's1', state: 'busy', monitor, now: NOW }))
    expect(html).toContain('1 sub-agent running')
    expect(html).toContain('1 background task')
    expect(renderToStaticMarkup(createElement(SessionActivity, { sessionId: 's1', state: 'stopped', monitor, now: NOW }))).toBe('')
    expect(renderToStaticMarkup(createElement(SessionActivity, { sessionId: 's1', state: 'error', monitor, now: NOW }))).toBe('')
  })

  it('reads the activity of every listed session in one call after a reconnect', async () => {
    const invoke = vi.fn(async () => ({ s1: { subagents: [sub('a', 'completed', 1)], backgroundTasks: [] } }))
    const applied: AgentEvent[] = []
    await refreshActivity({ supports: () => true, transport: { invoke } }, ['s1', 's2'], (e) => void applied.push(e))
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('remote:activity', ['s1', 's2'])
    expect(applied).toEqual([{ sessionId: 's1', type: 'monitor', snapshot: { subagents: [sub('a', 'completed', 1)], backgroundTasks: [] } }])
    const old = vi.fn()
    await refreshActivity({ supports: () => false, transport: { invoke: old } }, ['s1'], () => {})
    expect(old).not.toHaveBeenCalled()
    await expect(refreshActivity({ supports: () => true, transport: { invoke: async () => Promise.reject(new Error('offline')) } }, ['s1'], () => {})).resolves.toBeUndefined()
  })
})

const item = (n: number): PullRequestItem => ({ pr: { url: `https://code.example.com/acme/app/pull/${n}`, repo: 'acme/app', number: n, title: `Change ${n}`, author: 'someone', isDraft: false, additions: 1, deletions: 1 }, status: 'approved' }) as unknown as PullRequestItem

describe('pull requests on the phone, each list a page at a time', () => {
  const first: RemotePullRequestsPage = {
    lists: { state: 'ready' },
    counts: { mine: 120, toReview: 2 },
    mine: { items: [item(1), item(2)], nextCursor: 'mine-2', total: 120 },
    toReview: { items: [item(100), item(101)], nextCursor: null, total: 2 }
  }

  it('shows both lists with their counts at once, and Load more only under the one that has more', () => {
    const html = renderToStaticMarkup(createElement(PullRequestLists, { state: prStateFrom(first, 1), online: true, onLoadMore: () => {} }))
    expect(html).toContain('Mine')
    expect(html).toContain('To review')
    expect(html).toContain('acme/app#100')
    expect(html.match(/data-testid="load-more"/g)).toHaveLength(1)
    expect(html).toContain('2 of 120')
    expect(html).toContain('min-h-11')
    const offline = renderToStaticMarkup(createElement(PullRequestLists, { state: prStateFrom(first, 1), online: false, onLoadMore: () => {} }))
    expect(offline).toMatch(/disabled=""[^>]*data-testid="load-more"|data-testid="load-more"[^>]*disabled=""/)
  })

  it('appends the next page of one list, each row once, and stops at its end', () => {
    let state = prStateFrom(first, 1)
    state = prLoading(state, 'mine', 1)
    expect(state.mine.loading).toBe(true)
    state = prLoaded(state, 'mine', 1, { lists: { state: 'ready' }, counts: { mine: 120, toReview: 2 }, mine: { items: [item(2), item(3)], nextCursor: null, total: 120 } })
    expect(state.mine.items.map((i) => i.pr.number)).toEqual([1, 2, 3])
    expect(state.mine).toMatchObject({ cursor: null, loading: false })
    expect(state.toReview.items).toHaveLength(2)
  })

  it('drops an answer that comes after a profile switch or a refresh, and clears a failed load', () => {
    const before = prLoading(prStateFrom(first, 1), 'mine', 1)
    // The screen moved on to generation 2 (another profile) while the request was out.
    const now = prStateFrom({ ...first, mine: { items: [item(50)], nextCursor: null, total: 1 } }, 2)
    const late = { lists: { state: 'ready' as const }, counts: { mine: 120, toReview: 2 }, mine: { items: [item(9)], nextCursor: 'x', total: 120 } }
    expect(prLoaded(now, 'mine', before.generation, late)).toBe(now)
    expect(prFailed(now, 'mine', 1)).toBe(now)
    expect(prFailed(before, 'mine', 1).mine.loading).toBe(false)
  })

  it('shows an older desktop answer (both lists whole) as complete lists', () => {
    const legacy = prStateFrom({ state: 'ready', login: 'me', mine: [item(1)], toReview: [item(2), item(3)] }, 1)
    expect(legacy).toMatchObject({ counts: { mine: 1, toReview: 2 }, lists: { state: 'ready', login: 'me' }, mine: { cursor: null }, toReview: { cursor: null } })
  })

  it('falls back offline to the whole lists an older desktop left in the cache', () => {
    const store: Record<string, unknown> = { 'codeHost:lists:["work"]': { state: 'ready', mine: [item(1)], toReview: [] } }
    const cached = <T,>(channel: string, args: unknown[]) => (store[`${channel}:${JSON.stringify(args)}`] as T) ?? null
    expect(cachedPullRequests(cached, 'work', ['work', { limit: 50 }])).toMatchObject({ mine: [{ pr: { number: 1 } }] })
    store['remote:pullRequests:["work",{"limit":50}]'] = first
    expect(cachedPullRequests(cached, 'work', ['work', { limit: 50 }])).toBe(first)
    expect(cachedPullRequests(cached, 'home', ['home', { limit: 50 }])).toBeNull()
  })
})
