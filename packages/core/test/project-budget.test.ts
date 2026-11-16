import { describe, expect, it } from 'vitest'
import {
  CONFIG_VERSION,
  cleanProjectBudgets,
  evaluateProjectBudgetAlerts,
  monthBounds,
  parseConfig,
  parseTokenAmount,
  parseProjectBudgetAlertState,
  projectProgress,
  projectSpendOf,
  setProjectBudget,
  type ProjectBudgetAlertState
} from '../src'

const progress = (usdPercent: number) => projectProgress({ usd: 100 }, { usd: usdPercent, tokens: 0, unpricedTokens: 0 })

describe('project budget progress', () => {
  it('is ok below 80 %, warns from 80 % and is over from 100 %', () => {
    expect(progress(79.9).state).toBe('ok')
    expect(progress(80).state).toBe('warn')
    expect(progress(99.9).state).toBe('warn')
    expect(progress(100).state).toBe('over')
    expect(progress(250).percent).toBe(250)
  })

  it('takes the worse of dollars and tokens', () => {
    const p = projectProgress({ usd: 100, tokens: 1_000_000 }, { usd: 10, tokens: 900_000, unpricedTokens: 0 })
    expect(p).toMatchObject({ usdPercent: 10, tokensPercent: 90, percent: 90, measure: 'tokens', state: 'warn' })
  })

  it('has no percent for a measure without a budget, and none spent means zero', () => {
    const p = projectProgress({ tokens: 500 }, undefined)
    expect(p.usdPercent).toBeUndefined()
    expect(p).toMatchObject({ tokensPercent: 0, percent: 0, state: 'ok' })
  })

  it('counts fresh tokens (input, output, cache writes) and keeps the unpriced ones apart', () => {
    expect(projectSpendOf({ usd: 2, tokensIn: 10, tokensOut: 20, cacheWrite: 5, unpricedTokens: 7 })).toEqual({ usd: 2, tokens: 35, unpricedTokens: 7 })
  })
})

describe('local month', () => {
  it('covers the calendar month of the moment, end exclusive', () => {
    const m = monthBounds(new Date(2026, 10, 15, 13, 0).getTime())
    expect(m.key).toBe('2026-11')
    expect(m.since).toBe(new Date(2026, 10, 1).getTime())
    expect(m.until).toBe(new Date(2026, 11, 1).getTime())
    expect(monthBounds(m.until).key).toBe('2026-12')
    expect(monthBounds(m.until - 1).key).toBe('2026-11')
  })
})

describe('project budget alerts', () => {
  const at = (percent: number, measure: 'usd' | 'tokens' = 'usd') => ({ percent, measure, state: 'ok' as const })
  const run = (state: ProjectBudgetAlertState | undefined, month: string, percents: Record<string, number>) =>
    evaluateProjectBudgetAlerts(state, month, Object.fromEntries(Object.entries(percents).map(([k, v]) => [k, at(v)])))

  it('announces each threshold once in a month', () => {
    let r = run(undefined, '2026-11', { '/work/acme': 50 })
    expect(r.events).toEqual([])
    r = run(r.state, '2026-11', { '/work/acme': 85 })
    expect(r.events).toMatchObject([{ project: '/work/acme', threshold: 80 }])
    r = run(r.state, '2026-11', { '/work/acme': 90 })
    expect(r.events).toEqual([])
    r = run(r.state, '2026-11', { '/work/acme': 100 })
    expect(r.events).toMatchObject([{ threshold: 100 }])
    r = run(r.state, '2026-11', { '/work/acme': 300 })
    expect(r.events).toEqual([])
  })

  it('fires only the highest threshold on a jump, and never again when the spend drops or the budget is raised', () => {
    let r = run(undefined, '2026-11', { p: 120 })
    expect(r.events).toHaveLength(1)
    expect(r.events[0]?.threshold).toBe(100)
    r = run(r.state, '2026-11', { p: 30 })
    r = run(r.state, '2026-11', { p: 85 })
    expect(r.events).toEqual([])
  })

  it('starts over in a new month', () => {
    let r = run(undefined, '2026-11', { p: 100 })
    r = run(r.state, '2026-12', { p: 81 })
    expect(r.events).toMatchObject([{ threshold: 80 }])
  })

  it('tracks projects apart and forgets one that lost its budget', () => {
    let r = run(undefined, '2026-11', { a: 85, b: 10 })
    expect(r.events.map((e) => e.project)).toEqual(['a'])
    r = run(r.state, '2026-11', { b: 85 })
    expect(r.events.map((e) => e.project)).toEqual(['b'])
    expect(Object.keys(r.state.notified)).toEqual(['b'])
  })

  it('reads a state from disk and drops what is malformed', () => {
    expect(parseProjectBudgetAlertState({ month: '2026-11', notified: { a: 80, b: 'x' } })).toEqual({ month: '2026-11', notified: { a: 80 } })
    expect(parseProjectBudgetAlertState('nope')).toBeUndefined()
    expect(parseProjectBudgetAlertState({ month: 3, notified: {} })).toBeUndefined()
  })
})

describe('project budgets in the config', () => {
  it('keeps valid budgets and drops what is unusable, without failing the config', () => {
    const parsed = parseConfig({
      version: CONFIG_VERSION,
      options: { projectBudgets: { '/work/acme': { usd: 50, tokens: 20_000_000 }, '/work/b': { usd: -1 }, '/work/c': { usd: 'x', tokens: 1000.4 }, '  ': { usd: 5 }, '/work/d': 7 } }
    })
    expect(parsed.options?.projectBudgets).toEqual({ '/work/acme': { usd: 50, tokens: 20_000_000 }, '/work/c': { tokens: 1000 } })
  })

  it('is optional: a config without it loads, and a malformed value becomes none', () => {
    expect(parseConfig({ version: CONFIG_VERSION, options: {} }).options?.projectBudgets).toBeUndefined()
    expect(parseConfig({ version: CONFIG_VERSION, options: { projectBudgets: ['x'] } }).options?.projectBudgets).toEqual({})
  })

  it('an older document (no bump needed) loads at the current version', () => {
    expect(parseConfig({ version: 8, options: { projectBudgets: { p: { usd: 1 } } } }).options?.projectBudgets).toEqual({ p: { usd: 1 } })
  })

  it('sets and clears one budget', () => {
    const one = setProjectBudget({}, '/work/acme', { usd: 12.345 })
    expect(one).toEqual({ '/work/acme': { usd: 12.35 } })
    expect(setProjectBudget(one, '/work/acme', { usd: 0 })).toEqual({})
    expect(setProjectBudget(one, '/work/acme', null)).toEqual({})
    expect(cleanProjectBudgets(one)).toEqual(one)
  })
})

describe('token amounts typed by hand', () => {
  it('reads plain numbers and k, m, b suffixes', () => {
    expect(parseTokenAmount('20000000')).toBe(20_000_000)
    expect(parseTokenAmount(' 1.5M ')).toBe(1_500_000)
    expect(parseTokenAmount('800k')).toBe(800_000)
    expect(parseTokenAmount('2,5b')).toBe(2_500_000_000)
  })

  it('refuses what is no usable budget', () => {
    for (const bad of ['', 'abc', '-5', '0', '0k', '1e9', '12 tokens']) expect(parseTokenAmount(bad)).toBeNull()
  })
})
