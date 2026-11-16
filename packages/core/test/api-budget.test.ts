import { describe, expect, it } from 'vitest'
import { evaluateApiBudget, parseConfig, setApiCeiling, strictestBudget, type ApiAgentSpend } from '../src'

const NOW = new Date(2026, 9, 27, 15).getTime()
const spend = (today: number, week: number, unpricedTokens = 0): ApiAgentSpend => ({ agent: 'opencode', today, week, days: [], tokens: 0, unpricedTokens })

describe('evaluateApiBudget', () => {
  it('allows without a ceiling or without spend', () => {
    expect(evaluateApiBudget(spend(50, 50), undefined, 5, NOW).action).toBe('allow')
    expect(evaluateApiBudget(spend(50, 50), { daily: 0 }, 5, NOW).action).toBe('allow')
    expect(evaluateApiBudget(undefined, { daily: 5 }, 5, NOW).action).toBe('allow')
  })

  it('warns at the margin and blocks at the ceiling, with dollars in the status', () => {
    expect(evaluateApiBudget(spend(4, 4), { daily: 5 }, 5, NOW).action).toBe('allow')
    expect(evaluateApiBudget(spend(4.75, 4.75), { daily: 5 }, 5, NOW)).toMatchObject({ action: 'warn', usd: 4.75, ceilingUsd: 5 })
    expect(evaluateApiBudget(spend(5, 5), { daily: 5 }, 5, NOW)).toMatchObject({ action: 'block', window: 'api-daily' })
  })

  it('reports the daily window as resetting at the next local midnight, the weekly as unknown', () => {
    const daily = evaluateApiBudget(spend(9, 9), { daily: 5 }, 5, NOW)
    expect(daily.resetsAt).toBe(new Date(2026, 9, 28).getTime())
    expect(evaluateApiBudget(spend(0, 9), { weekly: 5 }, 5, NOW).resetsAt).toBeUndefined()
  })

  it('carries unpriced tokens on the deciding window only', () => {
    expect(evaluateApiBudget(spend(9, 9, 300), { daily: 5 }, 5, NOW).unpricedTokens).toBe(300)
    expect(evaluateApiBudget(spend(1, 1, 300), { daily: 5 }, 5, NOW).unpricedTokens).toBeUndefined()
  })
})

describe('strictestBudget and setApiCeiling', () => {
  it('keeps the stricter verdict, the first on a tie', () => {
    const warn = { action: 'warn' as const, window: '5h' }
    const block = { action: 'block' as const, window: 'api-daily' }
    expect(strictestBudget(warn, block)).toBe(block)
    expect(strictestBudget(block, warn)).toBe(block)
    expect(strictestBudget({ action: 'allow' }, warn)).toBe(warn)
  })

  it('sets, clears and drops an agent left without ceilings', () => {
    const one = setApiCeiling({}, 'opencode', 'daily', 5)
    const two = setApiCeiling(one, 'opencode', 'weekly', 20.456)
    expect(two).toEqual({ opencode: { daily: 5, weekly: 20.46 } })
    expect(setApiCeiling(two, 'opencode', 'daily', null)).toEqual({ opencode: { weekly: 20.46 } })
    expect(setApiCeiling(one, 'opencode', 'daily', null)).toEqual({})
    expect(setApiCeiling(one, 'opencode', 'daily', -3)).toEqual({})
  })
})

describe('config', () => {
  it('keeps valid dollar ceilings and drops hand-edited nonsense without failing to load', () => {
    const parsed = parseConfig({ version: 5, options: { usageBudget: { apiCeilings: { opencode: { daily: 5, weekly: 'x' }, codex: { daily: -1 } } } } })
    expect(parsed.options?.usageBudget?.apiCeilings).toEqual({ opencode: { daily: 5 } })
  })
})
