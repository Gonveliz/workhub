import { ListOrdered, Sparkles } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { breaches, flowMeasures, flowThresholds, formatMs, worstHour, type FlowMap, type FlowMapReading, type FlowPartRank, type FlowPartRef, type FlowTiming, type FlowTrace } from '@workhub/core'
import { Badge, Button } from '../../components/atoms'
import type { Tone } from '../../components/atoms/Badge'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { flowEntryNode, flowEntryTiming, flowPartStanding, type FlowStanding, type FlowTone } from '../../lib/flowMapCards'

const BADGE_TONE: Record<FlowTone, Tone> = { ok: 'success', warn: 'warning', bad: 'danger' }
const TEXT_TONE: Record<FlowTone, string> = { ok: '', warn: 'text-warning', bad: 'text-danger' }

/** How a flow (or a part) stands, as a word: Normal, Slow, Errors, Over limit. */
export function StandingBadge({ standing, className }: { standing: FlowStanding; className?: string }) {
  const { t } = useI18n()
  return (
    <Badge tone={BADGE_TONE[standing.tone]} className={className} title={t(`flowMaps.standing.${standing.label}.hint`)} data-testid="flow-standing">
      {t(`flowMaps.standing.${standing.label}`)}
    </Badge>
  )
}

const pct = (r: number) => `${(r * 100).toFixed(1)} %`
const perMinute = (n: number) => (n >= 10 ? Math.round(n).toString() : n.toFixed(1))
const ratio = (timing: FlowTiming): number | undefined => (timing.weekly && timing.weekly.count > 0 && timing.weekly.p95Ms > 0 ? timing.p95Ms / timing.weekly.p95Ms : undefined)

function Tile({ label, value, caption, tone = 'ok', testId }: { label: string; value: React.ReactNode; caption?: React.ReactNode; tone?: FlowTone; testId: string }) {
  return (
    <section aria-label={label} className="flex min-w-0 flex-col rounded-lg border border-border bg-surface px-3 py-2" data-testid={testId}>
      <span className="truncate text-xs text-muted">{label}</span>
      <span className={cn('truncate text-[17px] font-semibold leading-tight tabular-nums', TEXT_TONE[tone])}>{value}</span>
      <span className="truncate text-xs text-subtle">{caption}</span>
    </section>
  )
}

/**
 * The flow's own numbers over the window, as four tiles: the entry's p95 (against its seven-day
 * usual), its calls, its failure share (against its limit) and the part where the time goes.
 */
export function FlowSummaryTiles({ map, reading, ranks, standing, onPick }: { map: FlowMap; reading: FlowMapReading; ranks: readonly FlowPartRank[]; standing: FlowStanding | null; onPick: (p: FlowPartRef) => void }) {
  const { t, formatNumber } = useI18n()
  const timing = flowEntryTiming(map, reading)
  const entry = flowEntryNode(map)
  const limits = entry ? flowThresholds(map, { key: entry.id }) : {}
  const over = timing ? breaches(timing, limits) : []
  const r = timing ? ratio(timing) : undefined
  const slowest = ranks[0]
  const none = <span className="font-normal text-muted">–</span>
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-testid="flow-summary">
      <Tile
        testId="flow-summary-p95"
        label={t('flowMaps.flow.p95')}
        value={timing ? formatMs(timing.p95Ms) : none}
        tone={over.some((b) => b.kind !== 'flowErrors') ? 'bad' : r !== undefined && r > 1.2 ? 'warn' : 'ok'}
        caption={!timing ? t('flowMaps.summary.noNumbers') : r !== undefined ? t('flowMaps.flow.vsWeek', { ratio: `×${r.toFixed(1)}` }) : t('flowMaps.flow.noUsual')}
      />
      <Tile testId="flow-summary-calls" label={t('flowMaps.calls')} value={timing ? formatNumber(timing.count) : none} caption={timing?.perMinute !== undefined ? t('flowMaps.flow.perMinute', { value: perMinute(timing.perMinute) }) : ''} />
      <Tile
        testId="flow-summary-errors"
        label={t('flowMaps.errors')}
        value={timing?.errorRate !== undefined ? pct(timing.errorRate) : none}
        tone={over.some((b) => b.kind === 'flowErrors') ? 'bad' : standing?.label === 'errors' ? standing.tone : 'ok'}
        caption={limits.errorRate !== undefined ? t('flowMaps.flow.errorLimit', { value: pct(limits.errorRate) }) : t('flowMaps.flow.noErrorLimit')}
      />
      <Tile
        testId="flow-summary-slowest"
        label={t('flowMaps.flow.slowest')}
        value={
          slowest ? (
            <button type="button" className="max-w-full truncate text-left underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none" onClick={() => onPick({ of: slowest.of, key: slowest.key })}>
              {slowest.label}
            </button>
          ) : (
            none
          )
        }
        caption={slowest ? t('flowMaps.flow.shareOfTime', { share: `${Math.round(slowest.share * 100)} %` }) : t('flowMaps.summary.noNumbers')}
      />
    </div>
  )
}

/** A time on the hour axis: the hour alone within a day, the weekday too over longer windows. */
const hourLabel = (at: number, locale: string, long: boolean): string =>
  long ? new Date(at).toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })

const LINE_TONE: Record<FlowTone, string> = { ok: 'text-accent', warn: 'text-warning', bad: 'text-danger' }

/**
 * A part hour by hour, as two plots over one time axis so each has its own scale: its p95 as a
 * line (with its seven-day usual and its limit as dashed marks, the slowest hour as a dot) and its
 * calls as bars. Hovering an hour gives its numbers.
 */
export function PartChart({ timing, usual, limit, tone, hours }: { timing: FlowTiming; usual?: number; limit?: number; tone: FlowTone; hours: number }) {
  const { t, locale, formatNumber } = useI18n()
  // Drawn at the width it gets, one unit per pixel: a wider table makes the chart longer, not taller.
  const frame = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(760)
  useLayoutEffect(() => {
    const el = frame.current
    if (!el) return
    const measure = () => setW((prev) => (Math.abs(prev - el.clientWidth) < 1 || el.clientWidth < 200 ? prev : el.clientWidth))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const pts = timing.hourly
  if (pts.length < 2) return null
  const L = 52, R = 10, plotW = W - L - R
  const line = { y: 16, h: 60 }, bars = { y: 98, h: 30 }, H = 150
  const maxP95 = Math.max(1, ...pts.map((p) => p.p95Ms), usual ?? 0, limit ?? 0) * 1.12
  const maxCount = Math.max(1, ...pts.map((p) => p.count))
  const step = plotW / pts.length
  const cx = (i: number) => L + i * step + step / 2
  const yP = (ms: number) => line.y + line.h - (ms / maxP95) * line.h
  // The line only joins hours that had calls: a gap in the traffic is a gap in the line.
  const path = pts.reduce((d, p, i) => (p.count === 0 ? d : `${d}${d === '' || pts[i - 1]?.count === 0 ? 'M' : 'L'} ${cx(i).toFixed(1)} ${yP(p.p95Ms).toFixed(1)} `), '')
  const worst = worstHour(timing)
  const worstIndex = worst ? pts.findIndex((p) => p.at === worst.at) : -1
  const every = Math.max(1, Math.ceil(pts.length / Math.max(4, Math.floor(plotW / 110))))
  const long = hours > 24
  const axis = 'text-subtle'
  return (
    <figure className="flex min-w-0 flex-col gap-1.5" data-testid="flow-part-chart">
      {/* The drawing is laid over a box of its height, so its width never widens what holds it (a table cell would grow to fit it). */}
      <div ref={frame} className="relative w-full overflow-hidden" style={{ height: H }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="absolute left-0 top-0" role="img" aria-label={t('flowMaps.chart.title', { hours })}>
        <text x={L} y={10} fontSize={10} fill="currentColor" className="text-muted">{t('flowMaps.band.p95Title')}</text>
        <text x={L - 6} y={yP(maxP95 / 1.12) + 3} fontSize={9.5} textAnchor="end" fill="currentColor" className={axis}>{formatMs(maxP95 / 1.12)}</text>
        <text x={L - 6} y={line.y + line.h + 3} fontSize={9.5} textAnchor="end" fill="currentColor" className={axis}>0</text>
        <line x1={L} x2={W - R} y1={yP(maxP95 / 1.12)} y2={yP(maxP95 / 1.12)} stroke="currentColor" className="text-border" strokeDasharray="2 4" />
        <line x1={L} x2={W - R} y1={line.y + line.h} y2={line.y + line.h} stroke="currentColor" className="text-border" />
        {usual !== undefined && <line x1={L} x2={W - R} y1={yP(usual)} y2={yP(usual)} stroke="currentColor" className="text-muted" strokeDasharray="5 4" data-testid="flow-chart-usual" />}
        {limit !== undefined && <line x1={L} x2={W - R} y1={yP(limit)} y2={yP(limit)} stroke="currentColor" className="text-danger" strokeDasharray="5 4" data-testid="flow-chart-limit" />}
        <path d={path} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" className={LINE_TONE[tone]} />
        {worstIndex >= 0 && <circle cx={cx(worstIndex)} cy={yP(pts[worstIndex]!.p95Ms)} r={3.2} fill="currentColor" className={LINE_TONE[tone]} />}
        <text x={L} y={bars.y - 6} fontSize={10} fill="currentColor" className="text-muted">{t('flowMaps.band.callsTitle')}</text>
        <text x={L - 6} y={bars.y + 8} fontSize={9.5} textAnchor="end" fill="currentColor" className={axis}>{formatNumber(maxCount)}</text>
        <line x1={L} x2={W - R} y1={bars.y + bars.h} y2={bars.y + bars.h} stroke="currentColor" className="text-border" />
        {pts.map((p, i) => {
          const h = Math.max(p.count > 0 ? 1 : 0, (p.count / maxCount) * bars.h)
          return <rect key={p.at} x={L + i * step + Math.min(1, step * 0.15)} y={bars.y + bars.h - h} width={Math.max(0.6, step - 2 * Math.min(1, step * 0.15))} height={h} rx={Math.min(1.5, step / 4)} fill="currentColor" className={i === worstIndex ? LINE_TONE[tone] : 'text-muted'} opacity={i === worstIndex ? 0.9 : 0.55} />
        })}
        {pts.map((p, i) => (i % every === 0 ? <text key={p.at} x={cx(i)} y={H - 6} fontSize={9.5} textAnchor="middle" fill="currentColor" className={axis}>{hourLabel(p.at, locale, long)}</text> : null))}
        {/* One invisible column per hour, so pointing anywhere over it tells its numbers. */}
        {pts.map((p, i) => (
          <rect key={`hit:${p.at}`} x={L + i * step} y={line.y} width={step} height={bars.y + bars.h - line.y} fill="transparent">
            <title>{t('flowMaps.chart.point', { hour: hourLabel(p.at, locale, long), count: formatNumber(p.count), p50: formatMs(p.p50Ms), p95: formatMs(p.p95Ms) })}</title>
          </rect>
        ))}
      </svg>
      </div>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5"><span className={cn('inline-block h-0.5 w-4 rounded bg-current', LINE_TONE[tone])} aria-hidden />{t('flowMaps.band.keyP95')}</span>
        {usual !== undefined && <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 border-t border-dashed border-current" aria-hidden />{t('flowMaps.band.keyUsual', { value: formatMs(usual) })}</span>}
        {limit !== undefined && <span className="inline-flex items-center gap-1.5 text-danger"><span className="inline-block w-4 border-t border-dashed border-current" aria-hidden />{t('flowMaps.band.keyLimit', { value: formatMs(limit) })}</span>}
        {worst && <span className="inline-flex items-center gap-1.5"><span className={cn('inline-block size-1.5 rounded-full bg-current', LINE_TONE[tone])} aria-hidden />{t('flowMaps.band.keyWorst', { hour: hourLabel(worst.at, locale, long), value: formatMs(worst.p95Ms) })}</span>}
      </figcaption>
    </figure>
  )
}

const CODE_TONE = (code: string): string => (/\b2\d\d\b|2xx|OK|success/i.test(code) ? 'bg-success' : /3xx|\b3\d\d\b/i.test(code) ? 'bg-info' : /4xx|\b4\d\d\b/i.test(code) ? 'bg-warning' : /5xx|\b5\d\d\b|fail|error/i.test(code) ? 'bg-danger' : 'bg-muted')

/** How the calls ended, as one bar split by result and the shares next to it. */
function ResultCodes({ timing }: { timing: FlowTiming }) {
  const { t, formatNumber } = useI18n()
  const codes = timing.codes ?? []
  if (codes.length === 0) return null
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="flow-part-codes">
      <span className="text-muted">{t('flowMaps.detail.codes')}</span>
      <span className="flex h-2 w-28 overflow-hidden rounded-full bg-border" aria-hidden>
        {codes.map((c) => (
          <span key={c.code} className={cn('h-full', CODE_TONE(c.code))} style={{ width: `${(c.count / timing.count) * 100}%` }} />
        ))}
      </span>
      {codes.map((c) => (
        <span key={c.code} className="inline-flex items-center gap-1 whitespace-nowrap" title={formatNumber(c.count)}>
          <span className={cn('inline-block size-1.5 rounded-full', CODE_TONE(c.code))} aria-hidden />
          {c.code} <span className="font-medium tabular-nums text-text">{pct(c.count / timing.count)}</span>
        </span>
      ))}
    </div>
  )
}

export interface PartDetailProps {
  map: FlowMap
  reading?: FlowMapReading
  /** The chosen execution, when one is laid over the map: the detail says what this part took in it. */
  trace: FlowTrace | null
  part: FlowPartRef
  /** Opens Settings → Flow maps, where the map's limits are looked after. */
  onAdjust?: () => void
  /** Health is off: the detail links to Settings → Health instead of showing numbers. */
  onTurnOnHealth?: () => void
  /** "Investigate": the Claude draft, focused on the part. */
  onInvestigate: (part: FlowPartRef) => void
  /** Shows the real executions of the flow (the Executions tab); absent without Health. */
  onExecutions?: () => void
}

/**
 * What a row of the Parts table opens, under the row: the part's kind, how it stands and why in a
 * sentence, with what to do next; the window hour by hour; and how its calls ended, with its
 * limits. The numbers themselves stay in the row, so nothing is said twice.
 */
export function PartDetail({ map, reading, trace, part, onAdjust, onTurnOnHealth, onInvestigate, onExecutions }: PartDetailProps) {
  const { t, tn } = useI18n()
  const timing = reading ? reading[part.of][part.key] : undefined
  const error = reading ? reading.errors[part.key] : undefined
  const hop = trace ? trace.hops[part.key] : undefined
  const measured = flowMeasures(map).some((m) => m.of === part.of && m.key === part.key)
  const limits = flowThresholds(map, part)
  const standing = flowPartStanding(map, reading, part)
  const kind = part.of === 'nodes' ? t(`flowMaps.legend.kind.${map.nodes.find((n) => n.id === part.key)?.kind ?? 'service'}`) : part.of === 'stages' ? t('flowMaps.drawer.kind.stage') : t('flowMaps.drawer.kind.edge')
  const numbers = timing && timing.count > 0 ? timing : null
  const usual = numbers?.weekly && numbers.weekly.count > 0 ? numbers.weekly : undefined
  const reason = standing?.reason
  const why = !reason
    ? ''
    : reason.kind === 'overErrors'
      ? t('flowMaps.why.overErrors', { value: pct(reason.value), limit: pct(reason.limit) })
      : reason.kind === 'overP95'
        ? t('flowMaps.why.overP95', { value: formatMs(reason.value), limit: formatMs(reason.limit) })
        : reason.kind === 'overSlowShare'
          ? t('flowMaps.why.overSlowShare', { value: pct(reason.value), over: formatMs(reason.overMs), limit: pct(reason.limit) })
          : reason.kind === 'moreErrors'
            ? t('flowMaps.why.moreErrors', { value: pct(reason.value), usual: pct(reason.usual) })
            : reason.kind === 'slower'
              ? t('flowMaps.why.slower', { value: formatMs(reason.value), usual: formatMs(reason.usual), ratio: `×${reason.ratio.toFixed(1)}` })
              : t('flowMaps.why.fine')
  const message = !reading ? (measured ? t('flowMaps.tile.noNumbers') : t('flowMaps.noMeasure')) : error ? t('flowMaps.measureFailed', { error }) : !measured ? t('flowMaps.noMeasure') : !numbers ? t('flowMaps.coverage.noData.hint') : ''
  const hasLimits = limits.p95Ms !== undefined || limits.errorRate !== undefined || limits.slowMs !== undefined
  const over = (k: string) => (reason?.kind === k ? 'danger' : 'neutral') as 'danger' | 'neutral'
  return (
    <div className="flex flex-col gap-3" data-testid="flow-part-detail">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <Badge className="shrink-0">{kind}</Badge>
        {standing && <StandingBadge standing={standing} className="shrink-0" />}
        <p className={cn('min-w-0 flex-1 basis-64 text-xs', error ? 'text-danger' : 'text-muted')} data-testid="flow-part-why">
          {numbers ? why : message}
          {!reading && measured && onTurnOnHealth && (
            <>
              {' · '}
              <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={onTurnOnHealth}>{t('flowMaps.tile.turnOnHealth')}</button>
            </>
          )}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="primary" icon={<Sparkles className="size-3.5" aria-hidden />} onClick={() => onInvestigate(part)}>
            {t('flowMaps.band.investigate')}
          </Button>
          {onExecutions && (
            <Button size="sm" variant="secondary" icon={<ListOrdered className="size-3.5" aria-hidden />} onClick={onExecutions}>
              {t('flowMaps.tab.executions')}
            </Button>
          )}
        </div>
      </div>
      {numbers && (
        <p className="-mt-1 text-xs text-muted" data-testid="flow-part-more">
          {[
            numbers.p99Ms !== undefined ? `p99 ${formatMs(numbers.p99Ms)}` : '',
            numbers.perMinute !== undefined ? t('flowMaps.flow.perMinute', { value: perMinute(numbers.perMinute) }) : '',
            numbers.previous && numbers.previous.count > 0 && numbers.previous.p95Ms > 0 ? t('flowMaps.detail.vsPrevious', { ratio: `×${(numbers.p95Ms / numbers.previous.p95Ms).toFixed(1)}` }) : ''
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {numbers && <PartChart timing={numbers} usual={usual?.p95Ms} limit={limits.p95Ms} tone={standing?.tone ?? 'ok'} hours={reading?.windowHours ?? 0} />}
      {(numbers || measured || hop) && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
          {numbers && <ResultCodes timing={numbers} />}
          {measured && (
            <div className="flex flex-wrap items-center gap-1.5" data-testid="flow-part-limits">
              <span className="text-muted">{t('flowMaps.drawer.limits')}</span>
              {!hasLimits && <span className="text-subtle">{t('flowMaps.band.noLimits')}</span>}
              {limits.p95Ms !== undefined && <Badge tone={over('overP95')}>{t('flowMaps.drawer.limitP95', { value: formatMs(limits.p95Ms) })}</Badge>}
              {limits.slowMs !== undefined && <Badge tone={over('overSlowShare')}>{t('flowMaps.band.limitSlow', { value: formatMs(limits.slowMs) })}</Badge>}
              {limits.errorRate !== undefined && <Badge tone={over('overErrors')}>{t('flowMaps.drawer.limitErrors', { value: pct(limits.errorRate) })}</Badge>}
              {onAdjust && <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={onAdjust}>{t('flowMaps.drawer.adjust')}</button>}
            </div>
          )}
          {hop && (
            <span className="rounded bg-accent-soft px-1.5 py-0.5" data-testid="flow-part-hop">
              {t('flowMaps.band.execution', { duration: formatMs(hop.durationMs), start: formatMs(hop.startMs) })}
              {hop.failed ? ` · ${t('flowMaps.traces.outcome.failure')}` : hop.count > 1 ? ` · ${tn('flowMaps.traces.times', hop.count)}` : ''}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/** A swatch and what it means, for the key. */
function KeyRow({ swatch, children }: { swatch: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2.5">
      <span className="flex w-12 shrink-0 items-center justify-center" aria-hidden>{swatch}</span>
      <span>{children}</span>
    </li>
  )
}

/** How to read the diagram, as three short keys with the marks drawn: how a part stands, what a node shows, what the arrows are. */
export function StandingLegend({ compact = false }: { /** One column, for a popover. */ compact?: boolean }) {
  const { t } = useI18n()
  const dot = (cls: string) => <span className={cn('inline-block size-2.5 rounded-full', cls)} />
  const lineKey = (cls: string, style?: React.CSSProperties) => <span className={cn('inline-block w-8 border-t-2', cls)} style={style} />
  return (
    <div className={cn('grid gap-x-8 text-xs text-muted', compact ? 'gap-y-4' : 'gap-y-5 md:grid-cols-3')} data-testid="flow-legend">
      <section className="flex flex-col gap-2">
        <h4 className="font-medium text-text">{t('flowMaps.key.standing')}</h4>
        <ul className="flex flex-col gap-1.5">
          <KeyRow swatch={dot('bg-success')}>{t('flowMaps.key.ok')}</KeyRow>
          <KeyRow swatch={dot('bg-warning')}>{t('flowMaps.key.warn')}</KeyRow>
          <KeyRow swatch={dot('bg-danger')}>{t('flowMaps.key.bad')}</KeyRow>
          <KeyRow swatch={<span className="inline-block h-3.5 w-7 rounded border border-dashed border-border-strong opacity-70" />}>{t('flowMaps.key.unmeasured')}</KeyRow>
          <KeyRow swatch={<span className="inline-block h-3.5 w-7 rounded border border-border-strong" style={{ background: 'repeating-linear-gradient(45deg, transparent 0 3px, var(--color-border-strong) 3px 4px)' }} />}>{t('flowMaps.key.noData')}</KeyRow>
        </ul>
      </section>
      <section className="flex flex-col gap-2">
        <h4 className="font-medium text-text">{t('flowMaps.key.node')}</h4>
        <div className="flex w-44 flex-col gap-1 rounded-lg border border-border-strong bg-surface px-2.5 py-2" aria-hidden>
          <span className="flex items-center gap-1.5 text-[12px] font-semibold text-text">{dot('bg-success')}orders</span>
          <span className="flex items-baseline justify-between text-[11px]"><span>place order</span><span className="font-semibold text-text">1.6 s</span></span>
          <span className="h-1 overflow-hidden rounded-full bg-border"><span className="block h-full w-1/3 rounded-full bg-success" /></span>
        </div>
        <ul className="flex list-inside list-disc flex-col gap-1">
          <li>{t('flowMaps.key.nodeWhat')}</li>
          <li>{t('flowMaps.key.nodeP95')}</li>
          <li>{t('flowMaps.key.nodeBar')}</li>
        </ul>
      </section>
      <section className="flex flex-col gap-2">
        <h4 className="font-medium text-text">{t('flowMaps.key.arrows')}</h4>
        <ul className="flex flex-col gap-1.5">
          <KeyRow swatch={lineKey('border-[#64748b]')}>{t('flowMaps.key.sync')}</KeyRow>
          <KeyRow swatch={lineKey('border-dashed border-[#64748b]')}>{t('flowMaps.key.async')}</KeyRow>
          <KeyRow swatch={lineKey('border-dotted', { borderColor: '#fb7185' })}>{t('flowMaps.key.wait')}</KeyRow>
          <KeyRow swatch={<span className="whitespace-nowrap rounded border border-border-strong px-1 text-[10px]">652 ms</span>}>{t('flowMaps.key.label')}</KeyRow>
        </ul>
        <p>{t('flowMaps.key.percentiles')}</p>
      </section>
    </div>
  )
}
