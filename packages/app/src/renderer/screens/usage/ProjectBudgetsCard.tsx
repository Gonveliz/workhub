import { useState, type ReactNode } from 'react'
import { parseTokenAmount, projectProgress, projectSpendOf, setProjectBudget, validProjectUsd, type ProjectBudgets, type ProjectProgress } from '@workhub/core'
import type { SpendTotals } from '@shared/analytics-api'
import { Button, Input } from '../../components/atoms'
import { Card, CardBody, CardHeader } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { folderName, formatTokens } from '../../lib/home'
import { formatUsd } from '../../lib/usageReports'

export interface ProjectBudgetsCardProps {
  budgets: ProjectBudgets
  /** This calendar month's spend per project (all profiles, no filters), as the totals table groups it. */
  month: SpendTotals[]
  /** Projects to suggest, most used first. */
  projects: string[]
  /** Moment shown as the month. */
  now: number
  disabled?: boolean
  /** Saves the whole set; resolves false when it could not be saved. */
  onSave: (next: ProjectBudgets) => Promise<boolean>
}

const TONE: Record<ProjectProgress['state'], string> = { ok: 'brand-gradient', warn: 'bg-warning', over: 'bg-danger' }

/**
 * Monthly budget per project: progress of each one (warning from 80 %, over from 100 %) and the
 * form that sets or clears one. The key of a budget is the project exactly as the table groups
 * it, so the form suggests the projects the reports know. Nothing here blocks a prompt.
 */
export function ProjectBudgetsCard({ budgets, month, projects, now, disabled = false, onSave }: ProjectBudgetsCardProps) {
  const { t, locale, formatDate } = useI18n()
  const [project, setProject] = useState('')
  const [usd, setUsd] = useState('')
  const [tokens, setTokens] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  // Without any budget the card folds to one line; its link opens the form.
  const [defining, setDefining] = useState(false)
  const spendOf = new Map(month.filter((r) => r.group !== null).map((r) => [r.group as string, projectSpendOf(r)]))
  const entries = Object.entries(budgets)

  const edit = (key: string) => {
    setProject(key)
    setUsd(budgets[key]?.usd === undefined ? '' : String(budgets[key]!.usd))
    setTokens(budgets[key]?.tokens === undefined ? '' : String(budgets[key]!.tokens))
    setError('')
  }
  const commit = async (next: ProjectBudgets) => {
    setSaving(true)
    const ok = await onSave(next).catch(() => false)
    setSaving(false)
    if (!ok) setError(t('budgets.error.saveFailed'))
    return ok
  }
  const save = async () => {
    const key = project.trim()
    if (!key) return setError(t('budgets.error.project'))
    const dollars = usd.trim() === '' ? null : validProjectUsd(Number(usd.replace(',', '.')))
    const count = tokens.trim() === '' ? null : parseTokenAmount(tokens)
    // A filled field that is no usable amount is an error, not a silent "no limit".
    if ((usd.trim() !== '' && dollars === null) || (tokens.trim() !== '' && count === null) || (dollars === null && count === null)) return setError(t('budgets.error.amount'))
    setError('')
    const next = setProjectBudget(budgets, key, { ...(dollars !== null ? { usd: dollars } : {}), ...(count !== null ? { tokens: count } : {}) })
    if (await commit(next)) {
      setProject('')
      setUsd('')
      setTokens('')
    }
  }
  const remove = async (key: string) => {
    setError('')
    await commit(setProjectBudget(budgets, key, null))
  }

  const listId = 'project-budget-projects'
  const header = (actions?: ReactNode) => <CardHeader title={t('budgets.title')} meta={formatDate(now, { month: 'long', year: 'numeric' })} help={t('budgets.help')} actions={actions} className={actions ? 'min-h-16 py-3' : undefined} />
  if (entries.length === 0 && !defining) {
    return (
      <Card aria-label={t('budgets.title')} data-testid="project-budgets" data-folded="true">
        {header(
          <span className="text-sm whitespace-nowrap text-muted">
            {t('budgets.folded')} ·{' '}
            <button type="button" className="text-text underline underline-offset-2 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-45" disabled={disabled} onClick={() => setDefining(true)} data-testid="project-budgets-define">
              {t('budgets.define')}
            </button>
          </span>
        )}
      </Card>
    )
  }
  return (
    <Card aria-label={t('budgets.title')} data-testid="project-budgets">
      {header()}
      <CardBody className="flex flex-col gap-3">
        {entries.length === 0 ? (
          <p className="text-sm text-muted" data-testid="project-budgets-empty">
            {t('budgets.empty')}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {entries.map(([key, budget]) => {
              const spend = spendOf.get(key)
              const p = projectProgress(budget, spend)
              const name = folderName(key)
              return (
                <li key={key} className="flex flex-col gap-1" data-testid="project-budget-row" data-state={p.state}>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate font-medium" title={key}>
                      {name}
                    </span>
                    <span className={cn('text-xs', p.state === 'over' ? 'text-danger' : p.state === 'warn' ? 'text-warning' : 'text-subtle')} data-testid="project-budget-state">
                      {t(`budgets.state.${p.state}`)}
                    </span>
                    <Button size="sm" variant="ghost" disabled={disabled || saving} aria-label={t('budgets.editLabel', { project: name })} onClick={() => edit(key)}>
                      {t('budgets.edit')}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={disabled || saving} aria-label={t('budgets.removeLabel', { project: name })} onClick={() => void remove(key)}>
                      {t('budgets.remove')}
                    </Button>
                  </div>
                  <span
                    className="relative h-1.5 overflow-hidden rounded-full bg-surface-hover"
                    role="progressbar"
                    aria-label={name}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.min(100, Math.round(p.percent))}
                    aria-valuetext={`${Math.round(p.percent)}%`}
                  >
                    <span className={cn('block h-full rounded-full', TONE[p.state])} style={{ width: `${Math.min(100, Math.max(2, p.percent))}%` }} />
                  </span>
                  <p className="text-2xs text-subtle tabular-nums">
                    {[
                      budget.usd !== undefined && `${t('budgets.usdOf', { spent: formatUsd(spend?.usd ?? 0, locale), budget: formatUsd(budget.usd, locale) })} (${Math.round(p.usdPercent ?? 0)}%)`,
                      budget.tokens !== undefined && `${t('budgets.tokensOf', { spent: formatTokens(spend?.tokens ?? 0, locale), budget: formatTokens(budget.tokens, locale) })} (${Math.round(p.tokensPercent ?? 0)}%)`
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {budget.usd !== undefined && (spend?.unpricedTokens ?? 0) > 0 && (
                    <p className="text-2xs text-warning" data-testid="project-budget-unpriced">
                      {t('budgets.unpriced', { tokens: formatTokens(spend!.unpricedTokens, locale) })}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-subtle">
            {t('budgets.project')}
            <Input list={listId} value={project} disabled={disabled} autoFocus={defining && entries.length === 0} placeholder={t('budgets.projectPlaceholder')} onChange={(e) => setProject(e.target.value)} data-testid="project-budget-project" />
            <datalist id={listId}>
              {projects.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </label>
          <label className="flex w-36 flex-col gap-1 text-xs text-subtle">
            {t('budgets.usd')}
            <Input type="number" min={0.01} step="any" inputMode="decimal" value={usd} disabled={disabled} placeholder={t('budgets.none')} onChange={(e) => setUsd(e.target.value)} data-testid="project-budget-usd" />
          </label>
          <label className="flex w-36 flex-col gap-1 text-xs text-subtle">
            {t('budgets.tokens')}
            <Input value={tokens} disabled={disabled} placeholder={t('budgets.none')} title={t('budgets.tokensHint')} onChange={(e) => setTokens(e.target.value)} data-testid="project-budget-tokens" />
          </label>
          <Button type="submit" size="sm" variant="secondary" disabled={disabled || saving}>
            {t('budgets.save')}
          </Button>
        </form>
        {error && (
          <p role="alert" className="text-xs text-danger" data-testid="project-budget-error">
            {error}
          </p>
        )}
        <p className="text-2xs text-subtle">{t('budgets.note')}</p>
      </CardBody>
    </Card>
  )
}
