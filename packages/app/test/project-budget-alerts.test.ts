import { describe, expect, it } from 'vitest'
import { DEFAULT_OPTIONS, type AppOptions, type StateStore } from '@workhub/core'
import { ProjectBudgetAlerts, type MonthRow } from '../src/main/project-budget-alerts'
import { trayText } from '../src/main/tray-text'

const memory = (): StateStore<unknown> => {
  let value: unknown
  return { load: (fallback) => (value === undefined ? fallback : value), save: (v) => (value = v), flush: () => undefined }
}
const row = (group: string, usd: number, tokensIn = 0): MonthRow => ({ group, usd, tokensIn, tokensOut: 0, cacheWrite: 0, unpricedTokens: 0 })

function setup(options: Partial<AppOptions> = {}) {
  const shown: { title: string; body: string }[] = []
  let rows: MonthRow[] = []
  let now = new Date(2026, 10, 15, 12).getTime()
  const alerts = new ProjectBudgetAlerts({
    options: async () => ({ ...DEFAULT_OPTIONS, projectBudgets: { '/w/acme': { usd: 100 } }, ...options }),
    month: async () => rows,
    store: memory(),
    text: () => trayText('en'),
    locale: () => 'en',
    show: (words) => shown.push(words),
    now: () => now
  })
  return { alerts, shown, spend: (r: MonthRow[]) => (rows = r), at: (d: Date) => (now = d.getTime()) }
}

describe('project budget notifications', () => {
  it('announces 80 % and 100 % once each in a month, and again in the next month', async () => {
    const t = setup()
    t.spend([row('/w/acme', 50)])
    await t.alerts.check()
    expect(t.shown).toHaveLength(0)
    t.spend([row('/w/acme', 85)])
    await t.alerts.check()
    await t.alerts.check()
    expect(t.shown.map((w) => w.title)).toEqual(['acme is at 80% of its monthly budget'])
    expect(t.shown[0]?.body).toContain('$85.00 of $100.00')
    t.spend([row('/w/acme', 130)])
    await t.alerts.check()
    await t.alerts.check()
    expect(t.shown.map((w) => w.title)).toEqual(['acme is at 80% of its monthly budget', 'acme is over its monthly budget'])
    t.at(new Date(2026, 11, 2, 9))
    t.spend([row('/w/acme', 90)])
    await t.alerts.check()
    expect(t.shown).toHaveLength(3)
  })

  it('stays quiet, and does not queue old crossings, while usage alerts are off', async () => {
    const t = setup({ usageBudget: { ...DEFAULT_OPTIONS.usageBudget, alerts: false } })
    t.spend([row('/w/acme', 120)])
    await t.alerts.check()
    expect(t.shown).toEqual([])
    const on = setup()
    on.spend([row('/w/acme', 120)])
    await on.alerts.check()
    expect(on.shown).toHaveLength(1)
  })

  it('words a token budget with tokens', async () => {
    const t = setup({ projectBudgets: { '/w/acme': { tokens: 1000 } } })
    t.spend([row('/w/acme', 0, 900)])
    await t.alerts.check()
    expect(t.shown[0]?.body).toContain('900 of 1K tokens')
  })

  it('does not read the month without budgets', async () => {
    let read = 0
    const alerts = new ProjectBudgetAlerts({ options: async () => DEFAULT_OPTIONS, month: async () => (read++, []), store: memory(), text: () => trayText('en'), locale: () => 'en', show: () => undefined })
    await alerts.check()
    expect(read).toBe(0)
  })
})
