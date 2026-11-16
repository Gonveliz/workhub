import { evaluateProjectBudgetAlerts, monthBounds, parseProjectBudgetAlertState, projectProgress, projectSpendOf, type AppOptions, type ProjectBudgetAlertEvent, type ProjectBudgets, type StateStore, type TrayText } from '@workhub/core'
import { folderName, formatTokens } from '../renderer/lib/home'

/** One project's spend in the month, as the totals report returns it. */
export interface MonthRow {
  group: string | null
  usd: number
  tokensIn: number
  tokensOut: number
  cacheWrite: number
  unpricedTokens: number
}

export interface ProjectBudgetAlertsDeps {
  /** The app options as saved (`appOptions(await configuration.current())`). */
  options: () => Promise<AppOptions>
  /** Spend per project over `[since, until)` (the report worker's totals grouped by project, no filters). */
  month: (since: number, until: number) => Promise<MonthRow[]>
  /** The last announced threshold per project (`kv_state`); read without a default. */
  store: StateStore<unknown>
  text: () => TrayText
  locale: () => string
  /** Shows one notification; the notifier applies the master switch, the pause and quiet hours. */
  show: (words: { title: string; body: string }, project: string) => void
  now?: () => number
  log?: (message: string) => void
}

/** The notification of one crossed threshold, in the tray's language. */
export function projectBudgetWords(event: ProjectBudgetAlertEvent, budgets: ProjectBudgets, spend: { usd: number; tokens: number }, text: TrayText, locale: string): { title: string; body: string } {
  const project = folderName(event.project)
  const title = event.threshold >= 100 ? text.t('notify.projectBudget.over', { project }) : text.t('notify.projectBudget.warn', { project, percent: event.threshold })
  const budget = budgets[event.project]
  const body =
    event.measure === 'tokens'
      ? text.t('notify.projectBudget.bodyTokens', { spent: formatTokens(spend.tokens, locale), budget: formatTokens(budget?.tokens ?? 0, locale) })
      : text.t('notify.projectBudget.bodyUsd', { spent: usd(spend.usd, locale), budget: usd(budget?.usd ?? 0, locale) })
  return { title, body }
}

const usd = (n: number, locale: string) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(n)

/**
 * Announces when a project crosses 80 % and 100 % of its monthly budget, once per month per
 * threshold. It reads the month's spend after each turn scan; nothing here blocks a send. Events
 * are dropped (not queued) while usage alerts are off, so turning them on later does not announce
 * old crossings.
 */
export class ProjectBudgetAlerts {
  private running: Promise<void> | null = null
  private again = false

  constructor(private readonly deps: ProjectBudgetAlertsDeps) {}

  /** Reads the month now; calls during a run fold into one more run after it. Never throws. */
  check(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.run().finally(() => {
      this.running = null
      if (this.again) {
        this.again = false
        void this.check()
      }
    })
    return this.running
  }

  private async run(): Promise<void> {
    try {
      const options = await this.deps.options()
      const budgets = options.projectBudgets ?? {}
      const now = this.deps.now?.() ?? Date.now()
      const month = monthBounds(now)
      const previous = parseProjectBudgetAlertState(this.deps.store.load({}))
      // No budgets and nothing remembered: nothing to read, nothing to write.
      if (Object.keys(budgets).length === 0 && !previous?.month) return
      const rows = Object.keys(budgets).length > 0 ? await this.deps.month(month.since, month.until) : []
      const spends = new Map(rows.filter((r) => r.group !== null).map((r) => [r.group as string, projectSpendOf(r)]))
      const progress = Object.fromEntries(Object.entries(budgets).map(([project, budget]) => [project, projectProgress(budget, spends.get(project))]))
      const { state, events } = evaluateProjectBudgetAlerts(previous, month.key, progress)
      this.deps.store.save(state)
      if (!options.usageBudget.alerts) return
      for (const event of events) {
        const spend = spends.get(event.project) ?? { usd: 0, tokens: 0 }
        this.deps.show(projectBudgetWords(event, budgets, spend, this.deps.text(), this.deps.locale()), event.project)
      }
    } catch (err) {
      this.deps.log?.(`project budget check failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
