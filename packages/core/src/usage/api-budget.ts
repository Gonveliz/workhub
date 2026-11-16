/**
 * Dollar ceilings for agents billed by API key. They have no plan window, so the ceiling is an
 * amount per day or per week (the last 7 local days, as the API spend ledger sums them). The
 * verdict reuses the plan-window one: spend is turned into a percentage of its ceiling, so the
 * warning margin, the block and the one-shot override behave exactly as for the other ceilings.
 *
 * Tokens of a model missing from the price table are in no dollar total. They are never counted
 * as zero silently: the verdict carries their count so the UI can say the total is a lower bound.
 */
import type { PlanUsageWindow } from '../domain/monitor'
import { evaluateBudget, type BudgetStatus } from './budget'
import type { ApiAgentSpend } from './api-spend'
import { startOfLocalDay } from './credits'

/** The two windows a dollar ceiling covers; they appear as `BudgetStatus.window`. */
export const API_WINDOWS = ['api-daily', 'api-weekly'] as const
export type ApiWindow = (typeof API_WINDOWS)[number]

/** Dollar ceilings of one agent; a missing one is no limit. */
export interface ApiCeilings {
  daily?: number
  weekly?: number
}

/** A ceiling usable for gating: a finite amount above zero (and sane enough to round-trip a config file). */
export function validUsdCeiling(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1_000_000 ? Math.round(value * 100) / 100 : null
}

/** Whether a status window is one of the dollar ceilings. */
export function isApiWindow(window: string | undefined): window is ApiWindow {
  return window === 'api-daily' || window === 'api-weekly'
}

/**
 * The verdict of one agent's dollar ceilings. Allow (fail open) without ceilings or without any
 * spend. The deciding window carries `usd` and `ceilingUsd`, and `unpricedTokens` when some of
 * the week's tokens could not be priced.
 */
export function evaluateApiBudget(spend: ApiAgentSpend | undefined, ceilings: ApiCeilings | undefined, warnMargin: number, now: number): BudgetStatus {
  const daily = validUsdCeiling(ceilings?.daily)
  const weekly = validUsdCeiling(ceilings?.weekly)
  if (!spend || (daily === null && weekly === null)) return { action: 'allow' }
  const windows: PlanUsageWindow[] = []
  const usd: Record<string, { spent: number; ceiling: number }> = {}
  if (daily !== null) {
    const tomorrow = new Date(startOfLocalDay(now))
    tomorrow.setDate(tomorrow.getDate() + 1)
    windows.push({ window: 'api-daily', percent: (spend.today / daily) * 100, resetsAt: tomorrow.getTime() })
    usd['api-daily'] = { spent: spend.today, ceiling: daily }
  }
  if (weekly !== null) {
    windows.push({ window: 'api-weekly', percent: (spend.week / weekly) * 100 })
    usd['api-weekly'] = { spent: spend.week, ceiling: weekly }
  }
  const status = evaluateBudget(windows, { 'api-daily': 100, 'api-weekly': 100 }, warnMargin, now)
  const deciding = status.window ? usd[status.window] : undefined
  if (!deciding) return status
  return { ...status, usd: deciding.spent, ceilingUsd: deciding.ceiling, ...(spend.unpricedTokens > 0 ? { unpricedTokens: spend.unpricedTokens } : {}) }
}

const RANK: Record<BudgetStatus['action'], number> = { allow: 0, warn: 1, block: 2 }

/** The stricter of two verdicts (the first one on a tie): a plan window and a dollar ceiling both gate one agent. */
export function strictestBudget(a: BudgetStatus, b: BudgetStatus): BudgetStatus {
  return RANK[b.action] > RANK[a.action] ? b : a
}

/** Sets or clears (null) one dollar ceiling of an agent, dropping an agent left without any. */
export function setApiCeiling(all: Readonly<Record<string, ApiCeilings>>, agentId: string, which: 'daily' | 'weekly', value: number | null): Record<string, ApiCeilings> {
  const own: ApiCeilings = { ...all[agentId] }
  const ceiling = value === null ? null : validUsdCeiling(value)
  if (ceiling === null) delete own[which]
  else own[which] = ceiling
  const next = { ...all }
  if (own.daily !== undefined || own.weekly !== undefined) next[agentId] = own
  else delete next[agentId]
  return next
}
