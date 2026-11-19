import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { errorBars, type ServiceTone } from '../../lib/healthBoard'

const BAR_FILL: Record<ServiceTone, string> = { ok: 'fill-success', warn: 'fill-warning', bad: 'fill-danger', unknown: 'fill-subtle' }

export interface ErrorBarsProps {
  /** Errors per calendar day, oldest first, today last (`TrendStats.daily`); undefined draws an empty baseline. */
  daily?: readonly number[]
  /** The rolling window's count, drawn as the last bar. */
  recent: number
  typicalDay: number
  /** The rolling window, in hours, for the last bar's tooltip. */
  hours: number
  tone: ServiceTone
  height: number
  label: string
  /** Shows "typical N" by the dashed line. */
  showTypical?: boolean
  className?: string
  now?: number
}

/**
 * A service's errors per day as bars: the complete days of the trend window muted, then the rolling
 * window (the last 24 h) in the card's state color, with a dashed line at the typical day. Each bar
 * names its day and count on hover. It fills the width it is given; without a series it draws only
 * the baseline, so cards keep their height.
 */
export function ErrorBars({ daily, recent, typicalDay, hours, tone, height, label, showTypical = false, className, now = Date.now() }: ErrorBarsProps) {
  const { t, tn, formatDate, formatNumber } = useI18n()
  const bars = errorBars(daily, recent)
  const max = Math.max(...bars, typicalDay, 1) * 1.12
  const slot = 10
  const width = Math.max(bars.length, 1) * slot
  const y = (v: number) => height - (v / max) * (height - 1)
  const dayLabel = (i: number) => formatDate(now - (bars.length - 1 - i) * 86_400_000, { day: 'numeric', month: 'short' })
  return (
    <div className={cn('relative min-w-0', className)} style={{ height }} role="img" aria-label={label} data-testid="error-bars">
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="block overflow-visible">
        <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} className="stroke-border-strong" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {bars.map((v, i) => {
          const last = i === bars.length - 1
          const top = v > 0 ? Math.min(y(v), height - 1.5) : height
          return (
            <rect key={i} x={i * slot + 1.5} y={top} width={slot - 3} height={height - top} className={last ? BAR_FILL[tone] : 'fill-subtle'} opacity={last ? 0.95 : 0.4}>
              <title>{last ? t('health.board.bar.recent', { hours, count: formatNumber(v) }) : `${dayLabel(i)}: ${tn('health.board.bar.day', v, { count: formatNumber(v) })}`}</title>
            </rect>
          )
        })}
        {typicalDay > 0 && bars.length > 0 && (
          <line x1={0} x2={width} y1={y(typicalDay)} y2={y(typicalDay)} className="stroke-muted" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" data-testid="error-bars-typical" />
        )}
      </svg>
      {showTypical && typicalDay > 0 && bars.length > 0 && (
        <span className="pointer-events-none absolute left-0 rounded-sm bg-surface/80 px-0.5 text-[10px] leading-none text-muted" style={{ bottom: `calc(${(typicalDay / max) * 100}% + 2px)` }}>
          {t('health.board.typical', { count: formatNumber(typicalDay) })}
        </span>
      )}
    </div>
  )
}
