import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { niceMax, OTHER_KEY, type StackBucket } from '../../lib/usageReports'
import { Tooltip } from '../atoms/Tooltip'

/** A series' fill: its palette slot (`--wh-series-N`, per theme), or the neutral gray of "Other". */
export function seriesColor(slot: number): string {
  return slot > 0 ? `var(--wh-series-${slot})` : 'var(--wh-series-other)'
}

export interface ChartSeries {
  key: string
  slot: number
  label: string
}

/** Thicker bars stop reading as marks; the band's leftover is air. */
export const MAX_BAR = 24
/** The surface gap between stacked segments. */
export const SEGMENT_GAP = 2
const PAD = { top: 8, right: 8, bottom: 22, left: 56 }

export interface SegmentBox {
  series: number
  x: number
  y: number
  width: number
  height: number
  /** The top segment of its bar: drawn with rounded top corners. */
  top: boolean
}

export interface BarColumn {
  /** The column's hit area: the whole band, full height. */
  x: number
  width: number
  segments: SegmentBox[]
}

/**
 * Where every bar and segment goes: one band per bucket, the bar centered in it and at most
 * `MAX_BAR` wide, segments stacked from the baseline in series order with a `SEGMENT_GAP` of
 * surface between them. Segments too thin to survive the gap are dropped (they stay in the tooltip
 * and the table).
 */
export function stackGeometry(buckets: readonly StackBucket[], width: number, height: number, max: number): { columns: BarColumn[]; plot: { x: number; y: number; width: number; height: number } } {
  const plot = { x: PAD.left, y: PAD.top, width: Math.max(1, width - PAD.left - PAD.right), height: Math.max(1, height - PAD.top - PAD.bottom) }
  const band = plot.width / Math.max(1, buckets.length)
  const barW = Math.max(2, Math.min(MAX_BAR, band * 0.7))
  const scale = max > 0 ? plot.height / max : 0
  const baseline = plot.y + plot.height
  const columns = buckets.map((b, i) => {
    const x = plot.x + i * band
    const barX = x + (band - barW) / 2
    let y = baseline
    const segments: SegmentBox[] = []
    b.values.forEach((v, series) => {
      const h = v * scale
      if (h <= 0) return
      const gap = segments.length > 0 ? SEGMENT_GAP : 0
      const drawn = h - gap
      if (drawn >= 0.75) segments.push({ series, x: barX, y: y - h, width: barW, height: drawn, top: false })
      y -= h
    })
    const last = segments.at(-1)
    if (last) last.top = true
    return { x, width: band, segments }
  })
  return { columns, plot }
}

/** A rectangle with its top corners rounded by `r` (a bar's data end), square at the baseline. */
export function topRoundedPath(x: number, y: number, w: number, h: number, r = 4): string {
  const rr = Math.max(0, Math.min(r, w / 2, h))
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`
}

function useWidth(fallback: number): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(fallback)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(240, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}

export interface StackedBarChartProps {
  buckets: StackBucket[]
  series: ChartSeries[]
  /** The bucket's axis label ("Mon 3", "Nov 3"). */
  tick: (start: number) => string
  /** The bucket's tooltip title (full date, or the week's range). */
  title: (start: number) => string
  format: (value: number) => string
  /** One-sentence summary for screen readers (the label of the chart's group). */
  summary: string
  /** Caption of the hidden data table and its first column. */
  tableCaption: string
  bucketHeader: string
  totalLabel: string
  height?: number
  /** A series to stress (hover or focus in a legend); the others fade. */
  highlight?: string | null
}

/** The bar that holds the chart's tab stop: the last focused one, kept within the bars there are. */
export function activeBar(focused: number, count: number): number {
  return Math.max(0, Math.min(count - 1, focused))
}

/**
 * Bars of one metric per bucket, stacked by group, with a recessive grid and a tooltip per bar on
 * hover and keyboard focus (one tab stop; arrow keys move between bars). The same numbers are in a
 * visually hidden table for screen readers.
 */
export function StackedBarChart({ buckets, series, tick, title, format, summary, tableCaption, bucketHeader, totalLabel, height = 220, highlight }: StackedBarChartProps) {
  const [ref, width] = useWidth(720)
  const [focused, setFocused] = useState(0)
  // The tab stop stays on a bar when the period shrinks under it.
  const active = activeBar(focused, buckets.length)
  const setActive = setFocused
  const max = niceMax(Math.max(0, ...buckets.map((b) => b.total)))
  const { columns, plot } = stackGeometry(buckets, width, height, max)
  const baseline = plot.y + plot.height
  // At most about one label per 56px, always the first.
  const every = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(plot.width / 56))))
  const colRefs = useRef<(SVGRectElement | null)[]>([])
  const onKey = (e: KeyboardEvent<SVGRectElement>, i: number) => {
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? buckets.length - 1 : null
    if (next === null) return
    e.preventDefault()
    const to = Math.max(0, Math.min(buckets.length - 1, next))
    setActive(to)
    colRefs.current[to]?.focus()
  }
  return (
    <div ref={ref} className="relative w-full" data-testid="stacked-bar-chart">
      <svg role="group" aria-label={summary} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block max-w-full overflow-visible">
        {[0, 0.5, 1].map((f) => {
          const y = baseline - f * plot.height
          return (
            <g key={f} aria-hidden>
              <line x1={plot.x} x2={plot.x + plot.width} y1={y} y2={y} stroke="var(--wh-border)" strokeWidth={1} shapeRendering="crispEdges" />
              <text x={plot.x - 6} y={y} dy="0.32em" textAnchor="end" fill="var(--wh-text-subtle)" fontSize={10} className="tabular-nums">
                {format(max * f)}
              </text>
            </g>
          )
        })}
        {columns.map((c, i) => (
          <g key={buckets[i]!.start} aria-hidden>
            {c.segments.map((s) => {
              const key = series[s.series]?.key
              const faded = highlight && key !== highlight
              return s.top ? (
                <path key={s.series} d={topRoundedPath(s.x, s.y, s.width, s.height)} fill={seriesColor(series[s.series]?.slot ?? 0)} opacity={faded ? 0.25 : 1} />
              ) : (
                <rect key={s.series} x={s.x} y={s.y} width={s.width} height={s.height} fill={seriesColor(series[s.series]?.slot ?? 0)} opacity={faded ? 0.25 : 1} />
              )
            })}
            {i % every === 0 && (
              <text x={c.x + c.width / 2} y={height - 6} textAnchor="middle" fill="var(--wh-text-subtle)" fontSize={10}>
                {tick(buckets[i]!.start)}
              </text>
            )}
          </g>
        ))}
        <line x1={plot.x} x2={plot.x + plot.width} y1={baseline} y2={baseline} stroke="var(--wh-border-strong)" strokeWidth={1} shapeRendering="crispEdges" aria-hidden />
        {columns.map((c, i) => {
          const b = buckets[i]!
          const label = `${title(b.start)}: ${format(b.total)}`
          return (
            <Tooltip key={b.start} side="top" content={<BarTooltip title={title(b.start)} bucket={b} series={series} format={format} totalLabel={totalLabel} />}>
              <rect
                ref={(el) => {
                  colRefs.current[i] = el
                }}
                x={c.x}
                y={plot.y}
                width={c.width}
                height={plot.height}
                fill="transparent"
                tabIndex={i === active ? 0 : -1}
                role="img"
                aria-label={label}
                onFocus={() => setActive(i)}
                onKeyDown={(e) => onKey(e, i)}
                className="cursor-default outline-none focus-visible:fill-[var(--wh-accent-soft)] hover:fill-[var(--wh-accent-soft)]"
                data-testid="chart-column"
              />
            </Tooltip>
          )
        })}
      </svg>
      <table className="sr-only">
        <caption>{tableCaption}</caption>
        <thead>
          <tr>
            <th scope="col">{bucketHeader}</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
            <th scope="col">{totalLabel}</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.start}>
              <th scope="row">{title(b.start)}</th>
              {b.values.map((v, i) => (
                <td key={series[i]?.key ?? i}>{format(v)}</td>
              ))}
              <td>{format(b.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function BarTooltip({ title, bucket, series, format, totalLabel }: { title: string; bucket: StackBucket; series: ChartSeries[]; format: (v: number) => string; totalLabel: string }) {
  // Largest first; empty series left out. "Other" goes last.
  const rows = series
    .map((s, i) => ({ s, v: bucket.values[i] ?? 0 }))
    .filter((r) => r.v > 0)
    .sort((a, b) => (a.s.key === OTHER_KEY ? 1 : b.s.key === OTHER_KEY ? -1 : b.v - a.v))
  return (
    <div className="flex min-w-40 flex-col gap-1 py-0.5">
      <div className="text-xs text-muted">{title}</div>
      <div className="text-base font-semibold tabular-nums">
        {format(bucket.total)} <span className="text-xs font-normal text-muted">{totalLabel}</span>
      </div>
      {rows.length > 0 && (
        <ul className="flex max-w-72 flex-col gap-0.5">
          {rows.map(({ s, v }) => (
            <li key={s.key} className="flex items-center gap-2 text-xs">
              <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: seriesColor(s.slot) }} aria-hidden />
              <span className="font-medium tabular-nums">{format(v)}</span>
              <span className="min-w-0 truncate text-muted">{s.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The chart's legend: a swatch and name per series; hover or focus stresses that series, a click picks it (as a filter). */
export function ChartLegend({ series, onHighlight, onPick, pickHint }: { series: ChartSeries[]; onHighlight?: (key: string | null) => void; onPick?: (key: string) => void; pickHint?: string }): ReactNode {
  if (series.length < 2) return null
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1" data-testid="chart-legend">
      {series.map((s) => {
        const pickable = onPick && s.key !== OTHER_KEY && !s.key.startsWith('\u0000')
        return (
          <li key={s.key} className="min-w-0">
            <button
              type="button"
              className={cn('inline-flex max-w-56 items-center gap-1.5 rounded px-1 py-0.5 text-xs text-muted hover:bg-surface-hover hover:text-text', !pickable && 'cursor-default')}
              onMouseEnter={() => onHighlight?.(s.key)}
              onMouseLeave={() => onHighlight?.(null)}
              onFocus={() => onHighlight?.(s.key)}
              onBlur={() => onHighlight?.(null)}
              onClick={pickable ? () => onPick!(s.key) : undefined}
              title={pickable ? pickHint : undefined}
              aria-disabled={pickable ? undefined : true}
            >
              <span className="size-2.5 shrink-0 rounded-sm" style={{ background: seriesColor(s.slot) }} aria-hidden />
              <span className="truncate">{s.label}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
