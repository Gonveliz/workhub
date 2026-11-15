import { ChevronLeft, ChevronRight } from 'lucide-react'
import { IconButton, Spinner } from '../atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'

/** Rows per page of every paged list. */
export const PAGE_SIZE = 10

export interface PagerModel {
  /** 1-based first and last row shown; both 0 when the page is empty. */
  from: number
  to: number
  hasPrev: boolean
  hasNext: boolean
  /** Everything fits in one page: no pager needed. */
  single: boolean
}

/**
 * Where a page sits: rows `from`–`to`, and whether there is a page before and after. `total` is
 * the row count when known; without it `hasNext` says whether more rows follow (a cursor API).
 */
export function pagerModel({ offset, count, total = null, hasNext }: { offset: number; count: number; total?: number | null; hasNext?: boolean }): PagerModel {
  const from = count > 0 ? offset + 1 : 0
  const to = offset + count
  const next = (hasNext ?? true) && (total === null ? hasNext === true : to < total)
  const hasPrev = offset > 0
  return { from, to, hasPrev, hasNext: next, single: !hasPrev && !next }
}

/** The page `page` (0-based) of `rows`. */
export function pageRows<T>(rows: readonly T[], page: number): T[] {
  return rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
}

/** `page` held to the pages `total` rows fill (page 0 when there is none). */
export function clampPage(page: number, total: number): number {
  return Math.max(0, Math.min(page, Math.ceil(total / PAGE_SIZE) - 1))
}

/**
 * "11–20 of 57" with previous and next page buttons, compact enough to sit under a table. Hidden
 * when everything fits in one page. Without a known total it reads "11–20 of more than 20".
 */
export function Pager({
  offset,
  count,
  total = null,
  hasNext,
  onPrev,
  onNext,
  busy = false,
  label,
  className,
  testId = 'pager'
}: {
  /** Rows before this page. */
  offset: number
  /** Rows on this page. */
  count: number
  total?: number | null
  /** More rows follow (needed when the total is unknown; with a total it can only narrow). */
  hasNext?: boolean
  onPrev: () => void
  onNext: () => void
  /** A page is loading: both buttons wait. */
  busy?: boolean
  /** What is paged, for screen readers ("Sessions pages"). */
  label?: string
  className?: string
  testId?: string
}) {
  const { t, formatNumber } = useI18n()
  const m = pagerModel({ offset, count, total, hasNext })
  if (m.single) return null
  const params = { from: formatNumber(m.from), to: formatNumber(m.to), total: total === null ? '' : formatNumber(total) }
  const text = total !== null ? t('reports.pager.rangeOf', params) : m.hasNext ? t('reports.pager.rangeMore', params) : t('reports.pager.range', params)
  return (
    <nav aria-label={label ?? t('reports.pager.label')} aria-busy={busy || undefined} className={cn('flex items-center justify-end gap-1 text-xs text-muted', className)} data-testid={testId}>
      {busy && <Spinner className="size-3" />}
      <span aria-live="polite" className="px-1 tabular-nums" data-testid={`${testId}-range`}>
        {text}
      </span>
      <IconButton size="sm" label={t('reports.pager.prev')} icon={<ChevronLeft className="size-4" aria-hidden />} disabled={!m.hasPrev || busy} onClick={onPrev} data-testid={`${testId}-prev`} />
      <IconButton size="sm" label={t('reports.pager.next')} icon={<ChevronRight className="size-4" aria-hidden />} disabled={!m.hasNext || busy} onClick={onNext} data-testid={`${testId}-next`} />
    </nav>
  )
}
