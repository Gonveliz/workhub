import { cn } from '../../lib/cn'
import { sparklinePoints, sparklineY } from '../../lib/metricAlerts'

export interface SparklineProps {
  values: readonly number[]
  label: string
  width?: number
  height?: number
  className?: string
  /** A range drawn as a grey band behind the line (the usual values), on the same scale. */
  band?: readonly [number, number] | null
  /** Shades the area under the line in its color. */
  fill?: boolean
}

/** A tiny inline SVG line of a few values (oldest left), no chart library; the last value is marked. */
export function Sparkline({ values, label, width = 96, height = 24, className, band, fill = false }: SparklineProps) {
  const pad = 1.5
  // With a band the line and the band share one scale, so the band reads as "where it usually is".
  const domain: [number, number] | undefined = band && values.length > 0 ? [Math.min(...values, band[0]), Math.max(...values, band[1])] : undefined
  const points = sparklinePoints(values, width, height, pad, domain)
  const last = points.split(' ').at(-1)?.split(',').map(Number)
  const bandTop = domain && band ? sparklineY(band[1], height, domain, pad) : 0
  const bandBottom = domain && band ? sparklineY(band[0], height, domain, pad) : 0
  return (
    <svg role="img" aria-label={label} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cn('shrink-0 text-accent', className)}>
      {domain && band && <rect data-testid="sparkline-band" x={0} y={bandTop} width={width} height={Math.max(bandBottom - bandTop, 1.5)} className="fill-subtle" opacity={0.16} />}
      {fill && values.length > 1 && <polygon points={`${pad},${height} ${points} ${width - pad},${height}`} fill="currentColor" opacity={0.13} />}
      {values.length > 1 && <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />}
      {last && last.length === 2 && <circle cx={last[0]} cy={last[1]} r={2} fill="currentColor" />}
    </svg>
  )
}
