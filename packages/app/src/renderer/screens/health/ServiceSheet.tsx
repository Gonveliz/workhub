import { Maximize2, Minimize2, Star, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { flowKey, type ErrorGroup, type FlowDetails, type ServiceErrorCount, type ServiceErrorDetails, type SlowTransaction } from '@workhub/core'
import type { HealthEnvironmentView } from '@shared/health-api'
import { Badge, IconButton, StateDot } from '../../components/atoms'
import { PaneResizeHandle } from '../../components/molecules/PaneResizeHandle'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { formatMs, formatRate, groupTitle, leadGroupText, shortType, TREND_LABEL, TREND_TONE, whyText } from '../../lib/health'
import { primaryRow, SERVICE_TONE, serviceLabel, type BoardService } from '../../lib/healthBoard'
import { DEFAULT_PREFS, setPrefs, SIZE_RANGES, usePrefs } from '../../lib/prefs'
import { relativeTime } from '../../lib/pullRequests'
import { scrollParentOf } from '../../lib/rowAnchor'
import { ErrorBars } from './ErrorBars'
import { PodRow, SilentRow } from './HealthCards'
import { FlowDetailsView } from './FlowDetailsView'
import { DetailFooter, Disclosure, InvestigateButton, KibanaLink, useHealthDetail } from './HealthRows'

/** A slow endpoint's failure share is coloured from here up: a fraction of a percent is noise, not a warning. */
export const SLOW_FAILURES_WARN = 0.02

/** One endpoint's latency as a range on a shared scale: a track, a bar from p50 to p95 and a tick at p99. */
export function LatencyRange({ tx, max }: { tx: SlowTransaction; max: number }) {
  const { t } = useI18n()
  const pct = (ms: number) => `${Math.min((ms / max) * 100, 100)}%`
  return (
    <div className="relative h-3" role="img" aria-label={t('health.board.range', { p50: formatMs(tx.p50Ms), p95: formatMs(tx.p95Ms), p99: formatMs(tx.p99Ms) })} data-testid="latency-range">
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border-strong" />
      <span className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-accent/70" style={{ left: pct(tx.p50Ms), width: `calc(${pct(tx.p95Ms)} - ${pct(tx.p50Ms)})`, minWidth: 3 }} />
      <span className="absolute top-0 h-3 w-0.5 rounded-full bg-text/70" style={{ left: pct(tx.p99Ms) }} />
    </div>
  )
}

const H = 'text-sm font-semibold'

/**
 * A service's error groups, read once when shown (kept 10 minutes): each with its count and its
 * share of the groups as a bar, where it happens and since when; a new one is flagged.
 */
export function ErrorGroups({ entry, env }: { entry: ServiceErrorCount; env: HealthEnvironmentView }) {
  const i18n = useI18n()
  const { t, tn, formatNumber } = i18n
  const details = useHealthDetail<ServiceErrorDetails>({ kind: 'errors', service: entry.service }, true)
  const groups = details.value?.groups
  const total = (groups ?? []).reduce((sum, g) => sum + g.recent, 0)
  return (
    <section className="flex flex-col gap-1.5" data-testid="health-error-groups">
      <div className="flex items-baseline gap-2">
        <h4 className={H}>{t('health.sheet.groups')}</h4>
        <span className="text-xs text-subtle">
          {t('health.board.window', { hours: env.errorWindowHours })}
          {groups && groups.length > 0 ? ` · ${tn('health.sheet.groupCount', groups.length)}` : ''}
        </span>
      </div>
      {groups && groups.length === 0 && <p className="text-xs text-muted">{t('health.errors.noGroups', { hours: env.errorWindowHours })}</p>}
      {groups && groups.length > 0 && (
        <ul className="flex flex-col divide-y divide-border border-t border-border">
          {groups.map((g) => (
            <GroupRow key={g.groupingKey} group={g} share={total > 0 ? g.recent / total : 0} count={formatNumber(g.recent)} />
          ))}
        </ul>
      )}
      <DetailFooter state={details} fetchedAt={details.value?.fetchedAt} />
    </section>
  )
}

function GroupRow({ group: g, share, count }: { group: ErrorGroup; share: number; count: string }) {
  const { t, locale } = useI18n()
  const when = [
    g.firstSeen !== undefined ? t('health.errors.groupFirst', { time: relativeTime(g.firstSeen, Date.now(), locale) }) : undefined,
    g.lastSeen !== undefined ? t('health.errors.groupLast', { time: relativeTime(g.lastSeen, Date.now(), locale) }) : undefined,
    !g.isNew && g.daysWithData > 1 ? t('health.errors.groupDays', { active: g.activeDays, days: g.daysWithData }) : undefined
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <li className="flex items-start gap-3 py-2.5" data-testid="health-error-group">
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-semibold" title={g.exceptionType ?? groupTitle(g)}>{shortType(groupTitle(g))}</span>
          {g.isNew && <Badge tone={TREND_TONE.new} className="shrink-0">{t(TREND_LABEL.new)}</Badge>}
          {g.endpoint && <span className="truncate font-mono text-xs text-subtle">{g.endpoint}</span>}
        </p>
        {g.message && <p className="line-clamp-2 text-xs text-muted select-text">{g.message}</p>}
        <p className="truncate text-[11.5px] text-subtle" title={[g.culprit, when].filter(Boolean).join(' · ')}>
          {[g.culprit && g.culprit !== groupTitle(g) ? t('health.errors.culprit', { culprit: g.culprit }) : undefined, when].filter(Boolean).join(' · ')}
        </p>
      </div>
      <div className="w-24 shrink-0">
        <p className="flex items-center gap-1.5 text-xs">
          <span className="text-sm font-semibold tabular-nums">{count}</span>
          <span className="text-subtle tabular-nums">{formatRate(share)}</span>
          <span className="flex-1" />
          <KibanaLink url={g.kibanaUrl} label={t('health.errors.kibanaGroup')} />
        </p>
        <span className="mt-1 block h-1 overflow-hidden rounded-full bg-border" aria-hidden>
          <span className={cn('block h-full rounded-full', g.isNew ? 'bg-danger' : 'bg-warning')} style={{ width: `${Math.max(2, Math.round(share * 100))}%` }} />
        </span>
      </div>
    </li>
  )
}

/** The sentence that sums the service up: how its errors stand, and what is new about them. */
function Verdict({ entry, env }: { entry: ServiceErrorCount; env: HealthEnvironmentView }) {
  const i18n = useI18n()
  const details = useHealthDetail<ServiceErrorDetails>({ kind: 'errors', service: entry.service }, true)
  const groups = details.value?.groups
  const lead = groups ? leadGroupText(groups, entry.stats.recent, i18n) : null
  const top = groups?.[0]
  return (
    <p className="text-sm leading-relaxed text-muted" data-testid="health-sheet-verdict">
      <span className="text-text">{whyText(entry.stats, env.errorWindowHours, i18n)}</span>
      {lead && ` ${lead}`}
      {top?.isNew && top.firstSeen !== undefined && <span className="font-semibold text-warning"> {i18n.t('health.errors.newSince', { time: relativeTime(top.firstSeen, Date.now(), i18n.locale) })}</span>}
    </p>
  )
}

/** Under this width the sheet's Investigate button shows only its icon. */
const COMPACT_BELOW = 640

export interface ServiceSheetProps {
  env: HealthEnvironmentView
  service: BoardService
  /** Whether the environment's errors were read: an absent service then has none. */
  errorsRead: boolean
  favorite: boolean
  onFavorite: () => void
  onClose: () => void
}

/** A slow endpoint of the sheet: its range on the shared scale; its name opens where the time goes and how this window compares with the one before. */
function SlowEndpoint({ tx, max }: { tx: SlowTransaction; max: number }) {
  const { t, tn, formatNumber } = useI18n()
  const [open, setOpen] = useState(false)
  const details = useHealthDetail<FlowDetails>({ kind: 'flow', service: tx.service, name: tx.name }, open)
  return (
    <li className="flex flex-col gap-1.5 py-2.5" data-testid="health-sheet-endpoint">
      <div className="flex items-baseline gap-2">
        <Disclosure open={open} onToggle={() => setOpen((o) => !o)}>
          <span className="block truncate font-mono text-xs" title={tx.name}>{tx.name}</span>
        </Disclosure>
        <span className="shrink-0 text-xs whitespace-nowrap text-subtle tabular-nums">
          {tn('health.slow.calls', tx.calls, { count: formatNumber(tx.calls) })} · <span className={tx.failureRate >= SLOW_FAILURES_WARN ? 'text-danger' : undefined}>{t('health.slow.failures', { rate: formatRate(tx.failureRate) })}</span>
        </span>
      </div>
      <LatencyRange tx={tx} max={max} />
      <p className="text-xs whitespace-nowrap text-subtle tabular-nums">
        p50 <b className="font-semibold text-text">{formatMs(tx.p50Ms)}</b> · p95 <b className="font-semibold text-text">{formatMs(tx.p95Ms)}</b> · p99 <b className="font-semibold text-text">{formatMs(tx.p99Ms)}</b>
      </p>
      {open && (
        <div className="mt-1 flex flex-col gap-2.5 overflow-x-auto text-sm">
          {details.value && <FlowDetailsView details={details.value} />}
          <DetailFooter state={details} fetchedAt={details.value?.fetchedAt} />
        </div>
      )}
    </li>
  )
}

/**
 * What a service card opens: a sheet at the right, over the board, so nothing on the board moves
 * and another card can be picked without closing it. Top to bottom: the service and what to do
 * next, a sentence that sums it up, its errors per day, its error groups, its slow endpoints, and
 * its pods and agent. Its left edge drags to resize (double click resets), a button widens it, and
 * the width is remembered. Escape closes it.
 */
export function ServiceSheet(props: ServiceSheetProps) {
  const { onClose } = props
  const prefs = usePrefs()
  const anchor = useRef<HTMLSpanElement>(null)
  // The sheet starts where the screen's own scrolling area starts, under the app's bar.
  const [top, setTop] = useState(0)
  useLayoutEffect(() => {
    const measure = () => {
      const scroller = anchor.current ? scrollParentOf(anchor.current) : null
      setTop(scroller && scroller !== document.scrollingElement ? Math.max(0, scroller.getBoundingClientRect().top) : 0)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A menu or a dialog that is open handles its own Escape first.
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="dialog"], [role="menu"]')) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <>
      <span ref={anchor} className="hidden" />
      {typeof document === 'undefined' ? null : createPortal(<ServiceSheetPanel {...props} top={top} width={prefs.healthDetailWidth} />, document.body)}
    </>
  )
}

/** The sheet itself, `top` pixels down the window and `remembered` pixels wide: see `ServiceSheet`. */
export function ServiceSheetPanel({ env, service: s, errorsRead, favorite, onFavorite, onClose, top, width: remembered }: ServiceSheetProps & { top: number; width: number }) {
  const { t, tn, formatNumber } = useI18n()
  // While the edge is dragged the sheet follows the pointer; the width is saved when it is let go.
  const [dragging, setDragging] = useState<number | null>(null)
  const [min, max] = SIZE_RANGES.healthDetailWidth
  const width = dragging ?? remembered
  const wide = width >= max - 1
  const primary = primaryRow(s)
  const stats = s.errors?.stats
  const slowMax = Math.max(...s.slow.map((tx) => tx.p99Ms), 1)
  const quiet = s.pods.length === 0 && !s.silent
  return (
    <aside
      aria-label={t('health.sheet.label', { name: s.name })}
      className="fixed right-0 bottom-0 z-40 flex max-w-[calc(100vw-20rem)] animate-fade-in flex-col border-l border-border-strong bg-bg shadow-[-24px_0_60px_rgba(0,0,0,0.45)]"
      style={{ top, width }}
      data-testid="health-service-sheet"
    >
      <PaneResizeHandle
        edge="left"
        width={width}
        min={min}
        max={max}
        label={t('health.sheet.resize')}
        title={t('pane.resizeHint')}
        onWidth={(w, done) => {
          if (done) {
            setDragging(null)
            setPrefs({ healthDetailWidth: w })
          } else setDragging(w)
        }}
        onReset={() => {
          setDragging(null)
          setPrefs({ healthDetailWidth: DEFAULT_PREFS.healthDetailWidth })
        }}
      />
      <header className="flex items-center gap-2 border-b border-border px-5 py-3">
        <button
          type="button"
          aria-pressed={favorite}
          aria-label={t(favorite ? 'health.board.unstar' : 'health.board.star', { name: s.name })}
          title={t(favorite ? 'health.board.unstar' : 'health.board.star', { name: s.name })}
          onClick={onFavorite}
          className={cn('inline-flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-surface-hover', favorite ? 'text-warning' : 'text-subtle')}
        >
          <Star className={cn('size-4', favorite && 'fill-current')} aria-hidden />
        </button>
        <h3 className="min-w-0 truncate text-[17px] font-semibold" title={s.name}>{s.name}</h3>
        <Badge tone={SERVICE_TONE[s.tone]} className="shrink-0">{t(serviceLabel(s))}</Badge>
        <span className="flex-1" />
        {/* A narrow sheet keeps the room for the service's name: the button is its icon there. */}
        {primary && <InvestigateButton rowKey={primary.id} row={primary.row} compact={width < COMPACT_BELOW} />}
        <KibanaLink url={env.errorUrls[s.name] ?? env.serviceUrls[s.name]} label={t('health.kibana.service', { service: s.name })} />
        <IconButton
          size="sm"
          label={t(wide ? 'health.sheet.shrink' : 'health.sheet.widen')}
          icon={wide ? <Minimize2 className="size-3.5" aria-hidden /> : <Maximize2 className="size-3.5" aria-hidden />}
          onClick={() => setPrefs({ healthDetailWidth: wide ? DEFAULT_PREFS.healthDetailWidth : max })}
          data-testid="health-sheet-widen"
        />
        <IconButton size="sm" label={t('health.board.close')} icon={<X className="size-3.5" aria-hidden />} onClick={onClose} />
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
        {s.errors ? <Verdict entry={s.errors} env={env} /> : <p className="text-sm text-muted">{errorsRead ? t('health.errors.empty') : t('health.errors.off')}</p>}
        <section className="rounded-lg border border-border bg-surface px-4 py-3" data-testid="health-sheet-chart">
          <div className="flex items-baseline gap-2">
            <h4 className={H}>{t('health.sheet.perDay')}</h4>
            {stats?.daily && <span className="text-xs text-subtle">{tn('health.sheet.days', stats.daily.length)}</span>}
            <span className="flex-1" />
            <span className="text-xs text-subtle">
              <b className="text-base font-semibold text-text tabular-nums">{stats ? formatNumber(stats.recent) : errorsRead ? '0' : '—'}</b> {t('health.board.window', { hours: env.errorWindowHours })}
              {stats ? ` · ${t('health.board.typical', { count: formatNumber(stats.typicalDay) })}` : ''}
            </span>
          </div>
          <div className="mt-2.5 flex">
            <ErrorBars daily={stats?.daily} recent={stats?.recent ?? 0} typicalDay={stats?.typicalDay ?? 0} hours={env.errorWindowHours} tone={s.tone} height={72} label={t('health.board.chart', { name: s.name })} className="flex-1" />
          </div>
          <p className="mt-1.5 text-[11px] text-subtle">{t('health.board.legend')}</p>
        </section>
        {s.errors && <ErrorGroups entry={s.errors} env={env} />}
        {s.slow.length > 0 && (
          <section className="flex flex-col gap-1.5" data-testid="health-sheet-slow">
            <div className="flex items-baseline gap-2">
              <h4 className={H}>{t('health.slow.title')}</h4>
              <span className="text-xs text-subtle">{t('health.board.slowMeta', { hours: env.slowFlowHours })}</span>
            </div>
            <ul className="flex flex-col divide-y divide-border border-t border-border">
              {s.slow.map((tx) => (
                <SlowEndpoint key={flowKey(tx)} tx={tx} max={slowMax} />
              ))}
            </ul>
          </section>
        )}
        <section className="flex flex-col gap-1.5" data-testid="health-sheet-infra">
          <h4 className={H}>{t('health.sheet.infra')}</h4>
          {quiet ? (
            <p className="flex items-center gap-2 border-t border-border pt-2.5 text-xs text-muted">
              <StateDot tone="success" />
              {t('health.sheet.infraQuiet')}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border border-t border-border">
              {s.silent && <SilentRow service={s.silent} url={env.serviceUrls[s.name]} />}
              {s.pods.map((p) => (
                <PodRow key={p.pod} pod={p} env={env} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  )
}
