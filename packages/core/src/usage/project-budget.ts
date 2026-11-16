/**
 * Monthly budgets per project, in dollars, in tokens or both. A project is what the Usage screen
 * groups by "project" (the resolved project folder, or the folder when none was resolved), so the
 * key of a budget is that exact string. The month is the local calendar month.
 *
 * Progress is spend over budget, each measure on its own; the verdict is the worse of the two.
 * Everything here is pure (the clock is passed in), like the plan-window budgets. Nothing here
 * blocks anything: a project budget only shows progress and notifies (see `project-budget-alerts`
 * in the app's main process).
 *
 * Dollars are list prices of priced turns. Tokens of a model with no price are in no dollar total,
 * so `ProjectSpend.unpricedTokens` travels with the spend and the UI says the dollars are a lower
 * bound instead of counting them as zero silently.
 */

/** Monthly budget of one project; a missing measure is no limit on it. */
export interface ProjectBudget {
  usd?: number
  /** Fresh tokens: input, output and cache writes, as Home and the Usage screen count them. */
  tokens?: number
}

/** Budgets by project key. */
export type ProjectBudgets = Record<string, ProjectBudget>

/** The share of a budget at which the warning starts, and the one at which it is over. */
export const PROJECT_BUDGET_THRESHOLDS: readonly number[] = [80, 100]

/** More budgets than anyone sets by hand; keeps a hand-edited config bounded. */
export const MAX_PROJECT_BUDGETS = 200

/** A dollar budget usable for progress: a finite amount above zero, rounded to cents. */
export function validProjectUsd(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1_000_000 ? Math.max(0.01, Math.round(value * 100) / 100) : null
}

/** A token budget usable for progress: a whole number of tokens above zero. */
export function validProjectTokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 1e13 ? Math.round(value) : null
}

/** Tokens as a person types them: "20000000", "20m", "1.5M", "800k", "2b" (decimal point or comma). Null when it is no usable budget. */
export function parseTokenAmount(text: string): number | null {
  const m = /^(\d+(?:[.,]\d+)?)\s*([kmb])?$/i.exec(text.trim())
  if (!m) return null
  const unit = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? '').toLowerCase() as 'k' | 'm' | 'b'] ?? 1
  return validProjectTokens(Number(m[1]!.replace(',', '.')) * unit)
}

/**
 * Budgets read from the config: an entry with no usable measure, a blank project or an entry past
 * `MAX_PROJECT_BUDGETS` is dropped instead of keeping the config from loading.
 */
export function cleanProjectBudgets(raw: unknown): ProjectBudgets {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: ProjectBudgets = {}
  for (const [project, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_PROJECT_BUDGETS) break
    if (!project.trim() || project.length > 2048 || !value || typeof value !== 'object') continue
    const v = value as { usd?: unknown; tokens?: unknown }
    const usd = validProjectUsd(v.usd)
    const tokens = validProjectTokens(v.tokens)
    if (usd !== null || tokens !== null) out[project] = { ...(usd !== null ? { usd } : {}), ...(tokens !== null ? { tokens } : {}) }
  }
  return out
}

/** Sets a project's budget, or clears it (null, or no usable measure). */
export function setProjectBudget(all: Readonly<ProjectBudgets>, project: string, budget: ProjectBudget | null): ProjectBudgets {
  const next = { ...all }
  const clean = budget ? cleanProjectBudgets({ [project]: budget })[project] : undefined
  if (clean) next[project] = clean
  else delete next[project]
  return next
}

/** The local calendar month holding `now`: `since` inclusive, `until` exclusive (epoch ms), and its `YYYY-MM` key. */
export function monthBounds(now: number): { since: number; until: number; key: string } {
  const d = new Date(now)
  const since = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  const until = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
  return { since, until, key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }
}

/** What a project spent in the month. */
export interface ProjectSpend {
  usd: number
  tokens: number
  /** Tokens of models with no price: in `tokens`, in no `usd`. */
  unpricedTokens: number
}

/** The spend of a report row (`spendTotals`): fresh tokens are input, output and cache writes. */
export function projectSpendOf(row: { usd: number; tokensIn: number; tokensOut: number; cacheWrite: number; unpricedTokens: number }): ProjectSpend {
  return { usd: row.usd, tokens: row.tokensIn + row.tokensOut + row.cacheWrite, unpricedTokens: row.unpricedTokens }
}

export type ProjectBudgetState = 'ok' | 'warn' | 'over'

export interface ProjectProgress {
  /** Percent of each measure that has a budget. */
  usdPercent?: number
  tokensPercent?: number
  /** The larger of the two (0 without a budget). */
  percent: number
  /** The measure that gives `percent`; `usd` on a tie. */
  measure: 'usd' | 'tokens'
  state: ProjectBudgetState
}

/** Warning at 80 % of either measure, over at 100 %. Spend is unknown (undefined) counts as none. */
export function projectProgress(budget: ProjectBudget, spend: ProjectSpend | undefined): ProjectProgress {
  const usd = validProjectUsd(budget.usd)
  const tokens = validProjectTokens(budget.tokens)
  const usdPercent = usd !== null ? ((spend?.usd ?? 0) / usd) * 100 : undefined
  const tokensPercent = tokens !== null ? ((spend?.tokens ?? 0) / tokens) * 100 : undefined
  const measure = tokensPercent !== undefined && (usdPercent === undefined || tokensPercent > usdPercent) ? 'tokens' : 'usd'
  const percent = Math.max(usdPercent ?? 0, tokensPercent ?? 0)
  const [warn = 80, over = 100] = PROJECT_BUDGET_THRESHOLDS
  return { ...(usdPercent !== undefined ? { usdPercent } : {}), ...(tokensPercent !== undefined ? { tokensPercent } : {}), percent, measure, state: percent >= over ? 'over' : percent >= warn ? 'warn' : 'ok' }
}

/** The highest threshold already announced per project in one month. */
export interface ProjectBudgetAlertState {
  /** `YYYY-MM` the entries belong to; a new month starts empty. */
  month: string
  notified: Record<string, number>
}

export interface ProjectBudgetAlertEvent {
  project: string
  /** The threshold crossed (80 or 100). */
  threshold: number
  percent: number
  measure: 'usd' | 'tokens'
}

/**
 * Applies one reading of the month. Per project, the highest threshold at or below its percent
 * fires ONE event if it is above the highest already announced: 10 % to 120 % fires 100, never 80
 * and 100. The announced threshold only grows within the month (spend falling or a raised budget
 * never re-arms it); a new month starts over. A project that has no budget any more is forgotten.
 * Events are returned even when notifications are off: dropping them is the caller's job, which
 * keeps the state warm so turning them on later does not announce old crossings.
 */
export function evaluateProjectBudgetAlerts(
  state: ProjectBudgetAlertState | undefined,
  month: string,
  progress: Readonly<Record<string, ProjectProgress>>
): { state: ProjectBudgetAlertState; events: ProjectBudgetAlertEvent[] } {
  const known = state?.month === month ? state.notified : {}
  const notified: Record<string, number> = {}
  const events: ProjectBudgetAlertEvent[] = []
  for (const [project, p] of Object.entries(progress)) {
    const before = known[project] ?? 0
    const highest = [...PROJECT_BUDGET_THRESHOLDS].filter((t) => p.percent >= t).pop() ?? 0
    notified[project] = Math.max(before, highest)
    if (highest > before) events.push({ project, threshold: highest, percent: p.percent, measure: p.measure })
  }
  return { state: { month, notified }, events }
}

/** A state read from disk: anything malformed is dropped (at worst one announcement is repeated). */
export function parseProjectBudgetAlertState(raw: unknown): ProjectBudgetAlertState | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { month, notified } = raw as { month?: unknown; notified?: unknown }
  if (typeof month !== 'string' || !notified || typeof notified !== 'object' || Array.isArray(notified)) return undefined
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(notified as Record<string, unknown>)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  return { month, notified: out }
}
