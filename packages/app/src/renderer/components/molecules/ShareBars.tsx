import { cn } from '../../lib/cn'
import { OTHER_KEY } from '../../lib/usageReports'
import { Tooltip } from '../atoms/Tooltip'
import { seriesColor, type ChartSeries } from './StackedBarChart'

export interface ShareRow extends ChartSeries {
  value: number
  /** Full name for the tooltip (a folder's whole path, a PR's URL). */
  fullLabel?: string
  /** Extra lines for the tooltip (the other metrics). */
  details?: string[]
}

/**
 * Each row's share of the total (0-1) and its bar's length relative to the largest row (0-1). The
 * total is `base` when given (the period's own total, so groups that overlap, a session with two
 * tickets, are not shrunk to fit 100%), else the rows' sum.
 */
export function shareGeometry(rows: readonly Pick<ShareRow, 'value'>[], base?: number): { share: number; length: number }[] {
  const total = base !== undefined && base > 0 ? base : rows.reduce((a, r) => a + Math.max(0, r.value), 0)
  const max = Math.max(0, ...rows.map((r) => r.value))
  return rows.map((r) => ({ share: total > 0 ? Math.max(0, r.value) / total : 0, length: max > 0 ? Math.max(0, r.value) / max : 0 }))
}

/**
 * Each group's share of the period as a ranked horizontal bar (one row per group: swatch, name,
 * bar, exact value and percent), the bars in the same colors as the stacked chart. A list, so
 * every number is text; rows are buttons when `onPick` turns a group into a filter.
 */
export function ShareBars({
  rows,
  total,
  format,
  formatPercent,
  label,
  onPick,
  pickHint,
  onHighlight,
  highlight
}: {
  rows: ShareRow[]
  /** What 100% is: the period's total over every group; the rows' sum when left out. */
  total?: number
  format: (value: number) => string
  formatPercent: (fraction: number) => string
  label: string
  onPick?: (key: string) => void
  pickHint?: string
  onHighlight?: (key: string | null) => void
  highlight?: string | null
}) {
  const geo = shareGeometry(rows, total)
  return (
    <ul aria-label={label} className="flex flex-col gap-1.5" data-testid="share-bars">
      {rows.map((r, i) => {
        const g = geo[i]!
        const pickable = onPick && r.key !== OTHER_KEY && !r.key.startsWith('\u0000')
        const faded = highlight && highlight !== r.key
        const content = (
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{r.fullLabel ?? r.label}</span>
            <span className="tabular-nums">
              {format(r.value)} · {formatPercent(g.share)}
            </span>
            {r.details?.map((d) => (
              <span key={d} className="text-xs text-muted tabular-nums">
                {d}
              </span>
            ))}
            {pickable && pickHint && <span className="text-xs text-subtle">{pickHint}</span>}
          </span>
        )
        return (
          <li key={r.key} className={cn('transition-opacity', faded && 'opacity-40')}>
            <Tooltip side="left" content={content} className="max-w-80">
              <button
                type="button"
                onClick={pickable ? () => onPick!(r.key) : undefined}
                onMouseEnter={() => onHighlight?.(r.key)}
                onMouseLeave={() => onHighlight?.(null)}
                onFocus={() => onHighlight?.(r.key)}
                onBlur={() => onHighlight?.(null)}
                aria-disabled={pickable ? undefined : true}
                className={cn('grid w-full grid-cols-[minmax(0,10rem)_minmax(3rem,1fr)_auto] items-center gap-2.5 rounded-md px-1.5 py-1 text-left text-sm hover:bg-surface-hover', !pickable && 'cursor-default')}
                data-testid="share-row"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="size-2.5 shrink-0 rounded-sm" style={{ background: seriesColor(r.slot) }} aria-hidden />
                  <span className="truncate">{r.label}</span>
                </span>
                <span className="h-2.5 overflow-hidden rounded-r bg-surface-hover" aria-hidden>
                  <span className="block h-full rounded-r" style={{ width: `${Math.max(1, g.length * 100)}%`, background: seriesColor(r.slot) }} />
                </span>
                <span className="text-right text-xs whitespace-nowrap text-muted tabular-nums">
                  <span className="font-medium text-text">{format(r.value)}</span> · {formatPercent(g.share)}
                </span>
              </button>
            </Tooltip>
          </li>
        )
      })}
    </ul>
  )
}
