import { describe, expect, it } from 'vitest'
import { DEFAULT_USAGE_BUDGET, emptyConfig, gatePrompt, localDayKey, setApiCeiling, spendKey, type ApiCeilings, type UsageBudgetOptions } from '@workhub/core'
import { AgentUsageService } from '../src/main/agent-usage'
import { ApiSpendService, CostLedger, type CostLedgerState } from '../src/main/api-spend'
import { sessionBudget } from '../src/renderer/lib/agent-usage'

const NOW = new Date(2026, 9, 27, 15).getTime()
const day = (back: number) => localDayKey(new Date(2026, 9, 27 - back, 12))

function memory() {
  let value: CostLedgerState | undefined
  return { load: (fallback: CostLedgerState) => value ?? fallback, save: (v: CostLedgerState) => void (value = structuredClone(v)) }
}

/**
 * The gate as the main process runs it: a fake ledger of what a hypothetical API-billed agent
 * ("gemini", an agent whose cost arrives in session updates) spent, behind the real spend service.
 */
async function gateFor(spent: { today?: number; earlier?: number; unpriced?: number }, ceilings: ApiCeilings | undefined) {
  const ledger = new CostLedger(memory(), () => NOW)
  if (spent.today) ledger.record('gemini', 's1', spent.today)
  const days: Record<string, number> = {}
  if (spent.earlier) days[spendKey(day(2), 'codex', '/p')] = spent.earlier
  const unpriced: Record<string, number> = spent.unpriced ? { [spendKey(day(1), 'codex', '/p')]: spent.unpriced } : {}
  const spend = new ApiSpendService({
    config: async () => emptyConfig(),
    home: '/home/u',
    costs: () => ({ usd: days, unpriced, tokens: {} }),
    ledger,
    openCode: async () => [],
    now: () => NOW
  })
  const budget: UsageBudgetOptions = { ...DEFAULT_USAGE_BUDGET, apiCeilings: ceilings ? { gemini: ceilings, codex: ceilings } : {} }
  const usage = new AgentUsageService({
    providers: [],
    load: async () => ({ accounts: [], budget, knownKeys: [] }),
    emit: () => undefined,
    alert: () => undefined,
    alertState: { load: () => ({}), save: () => undefined },
    apiSpend: () => spend.summary(),
    now: () => NOW
  })
  await usage.refresh()
  await usage.readSpend()
  return { usage, budget, summary: await spend.summary() }
}

describe('dollar ceilings of agents billed by API key', () => {
  it('lets a send through under the ceiling', async () => {
    const { usage } = await gateFor({ today: 1 }, { daily: 5 })
    const status = usage.budgetOf('gemini', null)
    expect(status.action).toBe('allow')
    expect(gatePrompt(status, 'user').kind).toBe('send')
  })

  it('warns inside the margin: the prompt still goes, the status names the dollars', async () => {
    const { usage } = await gateFor({ today: 4.8 }, { daily: 5 })
    const status = usage.budgetOf('gemini', null)
    expect(status).toMatchObject({ action: 'warn', window: 'api-daily', usd: 4.8, ceilingUsd: 5 })
    expect(gatePrompt(status, 'user').kind).toBe('send')
  })

  it('blocks past the ceiling: the user confirms, automatic work pauses, an override sends once', async () => {
    const { usage } = await gateFor({ today: 5.2 }, { daily: 5 })
    const status = usage.budgetOf('gemini', null)
    expect(status).toMatchObject({ action: 'block', window: 'api-daily' })
    expect(status.resetsAt).toBeGreaterThan(NOW)
    expect(gatePrompt(status, 'user').kind).toBe('confirm')
    expect(gatePrompt(status, 'automation').kind).toBe('pause')
    expect(gatePrompt(status, 'user', true).kind).toBe('send')
    expect(gatePrompt(status, 'automation', true).kind).toBe('send')
  })

  it('judges the weekly ceiling over the last 7 days, and the daily one over today only', async () => {
    const { usage } = await gateFor({ earlier: 12 }, { daily: 5, weekly: 10 })
    expect(usage.budgetOf('codex', null)).toMatchObject({ action: 'block', window: 'api-weekly', usd: 12, ceilingUsd: 10 })
    expect(usage.budgetOf('gemini', null).action).toBe('allow')
  })

  it('never counts unpriced tokens as zero silently: the verdict says how many there are', async () => {
    const { usage } = await gateFor({ earlier: 11, unpriced: 4000 }, { weekly: 10 })
    expect(usage.budgetOf('codex', null)).toMatchObject({ action: 'block', unpricedTokens: 4000 })
  })

  it('does nothing without a ceiling, and an agent with no spend is not gated', async () => {
    expect((await gateFor({ today: 100 }, undefined)).usage.budgetOf('gemini', null).action).toBe('allow')
    expect((await gateFor({}, { daily: 1 })).usage.budgetOf('gemini', null).action).toBe('allow')
  })

  it('gates the composer the same way, from the spend the renderer reads', async () => {
    const { budget, summary } = await gateFor({ today: 6 }, { daily: 5 })
    const gate = sessionBudget({ agentId: 'gemini', accountId: null }, [], budget, (id) => id, NOW, undefined, summary)
    expect(gate.status).toMatchObject({ action: 'block', window: 'api-daily' })
    // Clearing the ceiling lifts it.
    const cleared = { ...budget, apiCeilings: setApiCeiling(budget.apiCeilings, 'gemini', 'daily', null) }
    expect(sessionBudget({ agentId: 'gemini', accountId: null }, [], cleared, (id) => id, NOW, undefined, summary).status.action).toBe('allow')
  })
})
