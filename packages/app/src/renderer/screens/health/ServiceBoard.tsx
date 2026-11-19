import { Bell, CheckCircle2, ChevronRight, Sparkles, Star } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { flowKey } from '@workhub/core'
import type { HealthEnvironmentView } from '@shared/health-api'
import { Badge, IconButton, Spinner, StateDot } from '../../components/atoms'
import { Card } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { formatMs, formatRate, POD_LABEL, TREND_LABEL } from '../../lib/health'
import { leadReason, primaryRow, SERVICE_TEXT, SERVICE_TONE, serviceLabel, type BoardService } from '../../lib/healthBoard'
import { ErrorBars } from './ErrorBars'
import { SlowRow } from './HealthCards'
import { useRowActions } from './HealthRows'
import { LatencyRange, ServiceSheet, SLOW_FAILURES_WARN } from './ServiceSheet'

/** The small uppercase heading of a board section, with an optional note at its right. */
export function BoardHeading({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-subtle">{children}</h3>
      {note && <span className="ml-auto truncate text-xs text-subtle">{note}</span>}
    </div>
  )
}

const BORDER: Record<BoardService['tone'], string> = { bad: 'border-danger', warn: 'border-warning', ok: 'border-border', unknown: 'border-border' }
/** The trend word in the facts line, as colored text. */
const TREND_TEXT: Record<NonNullable<BoardService['errors']>['stats']['state'], string> = { new: 'text-danger', worsening: 'text-warning', ongoing: 'text-info', chronic: 'text-muted' }

export interface ServiceBoardProps {
  env: HealthEnvironmentView
  /** Every service of the environment, worst first (`boardServices`). */
  services: BoardService[]
  /** The starred services, by name. */
  favorites: ReadonlySet<string>
  onFavorite: (service: string) => void
  /** Only the starred services are shown. */
  onlyFavorites: boolean
  /** Whether the environment's errors were read: an absent service then has none. */
  errorsRead: boolean
}

/**
 * The services of an environment as cards, worst first: the starred ones large, the rest small,
 * each with its errors per day. A click on a card opens its details in a sheet at the right, over
 * the board, so no card moves; while selecting, a click picks the card's signal.
 */
export function ServiceBoard({ env, services, favorites, onFavorite, onlyFavorites, errorsRead }: ServiceBoardProps) {
  const { t } = useI18n()
  const a = useRowActions()
  const [opened, setOpened] = useState<string | null>(null)
  const starred = services.filter((s) => favorites.has(s.name))
  const rest = services.filter((s) => !favorites.has(s.name))
  const openedService = services.find((s) => s.name === opened)
  const click = (s: BoardService) => {
    if (a.selecting) {
      const primary = primaryRow(s)
      if (primary) a.toggle(primary.id)
      return
    }
    setOpened((o) => (o === s.name ? null : s.name))
  }
  const common = (s: BoardService) => ({ service: s, env, errorsRead, favorite: favorites.has(s.name), onFavorite: () => onFavorite(s.name), opened: opened === s.name && !a.selecting, onClick: () => click(s) })
  const showRest = !onlyFavorites && rest.length > 0
  // The chart legend, once, on the first section shown.
  const legend = t('health.board.legend')

  if (services.length === 0) return <p className="text-sm text-subtle">{errorsRead ? t('health.board.empty') : t('health.errors.off')}</p>
  return (
    <div className="flex flex-col gap-5">
      {starred.length > 0 && (
        <section className="flex flex-col gap-3" aria-label={t('health.board.favorites')} data-testid="health-favorites">
          <BoardHeading note={legend}>{t('health.board.favorites')}</BoardHeading>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
            {starred.map((s) => (
              <LargeCard key={s.name} {...common(s)} />
            ))}
          </ul>
        </section>
      )}
      {openedService && !a.selecting && (
        <ServiceSheet key={openedService.name} env={env} service={openedService} errorsRead={errorsRead} favorite={favorites.has(openedService.name)} onFavorite={() => onFavorite(openedService.name)} onClose={() => setOpened(null)} />
      )}
      {onlyFavorites && starred.length === 0 && <p className="text-sm text-subtle">{t('health.board.noFavorites')}</p>}
      {showRest && (
        <section className="flex flex-col gap-3" aria-label={t('health.board.all')} data-testid="health-services">
          <BoardHeading note={starred.length === 0 ? legend : undefined}>{t('health.board.all')}</BoardHeading>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            {rest.map((s) => (
              <SmallCard key={s.name} {...common(s)} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

interface CardProps {
  service: BoardService
  env: HealthEnvironmentView
  errorsRead: boolean
  favorite: boolean
  onFavorite: () => void
  opened: boolean
  onClick: () => void
}

/** The star on a card: it sits over the card's button, so it is a button of its own. */
function StarButton({ name, on, onClick, className }: { name: string; on: boolean; onClick: () => void; className?: string }) {
  const { t } = useI18n()
  const label = t(on ? 'health.board.unstar' : 'health.board.star', { name })
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={onClick}
      data-testid="health-star"
      className={cn('absolute inline-flex size-6 items-center justify-center rounded-sm hover:bg-surface-hover', on ? 'text-warning' : 'text-subtle opacity-60 hover:opacity-100 focus-visible:opacity-100', className)}
    >
      <Star className={cn('size-3.5', on && 'fill-current')} aria-hidden />
    </button>
  )
}

/** The card's own button: opens the details, or picks the card while selecting. */
function useCardState(service: BoardService) {
  const a = useRowActions()
  const primary = primaryRow(service)
  const picked = a.selecting && primary !== null && a.isSelected(primary.id)
  return { a, primary, picked, pickable: !a.selecting || primary !== null }
}

/** Errors in the window: the count, a dash when errors were not read. */
const errorCount = (s: BoardService, errorsRead: boolean, formatNumber: (n: number) => string) => (s.errors ? formatNumber(s.errors.stats.recent) : errorsRead ? '0' : '—')

/** The chart of a card: errors per day, or an empty baseline for a service without errors. */
function CardChart({ service: s, env, height, showTypical }: { service: BoardService; env: HealthEnvironmentView; height: number; showTypical?: boolean }) {
  const { t } = useI18n()
  const stats = s.errors?.stats
  return (
    <ErrorBars
      daily={stats?.daily}
      recent={stats?.recent ?? 0}
      typicalDay={stats?.typicalDay ?? 0}
      hours={env.errorWindowHours}
      tone={s.tone}
      height={height}
      showTypical={showTypical}
      label={t('health.board.chart', { name: s.name })}
      className="flex-1"
    />
  )
}

/** The caption under the big number: the reason for the card's color when it is not its errors, else errors against a typical day. */
function Caption({ service: s, errorsRead }: { service: BoardService; errorsRead: boolean }) {
  const { t, formatNumber } = useI18n()
  const lead = leadReason(s)
  const errors = s.errors ? t('health.board.errorsTypical', { count: formatNumber(s.errors.stats.typicalDay) }) : errorsRead ? t('health.board.errors') : t('health.board.errorsUnread')
  if (!lead) return <>{errors}</>
  return (
    <>
      <span className={cn('font-medium', SERVICE_TEXT[s.tone])}>{lead.kind === 'pod' ? t(POD_LABEL[lead.pod.kind]) : t('health.reporting.silent', { minutes: lead.minutes })}</span>
      {' · '}
      {s.errors ? t('health.board.errors') : errors}
    </>
  )
}

/** Short facts of a card: the error trend as colored text, the p95 of the slowest endpoint, pods that need attention, and (large cards) alerts. */
function Facts({ service: s, env, alerts }: { service: BoardService; env: HealthEnvironmentView; alerts?: boolean }) {
  const { t, tn } = useI18n()
  const slowest = s.slow[0]
  const parts: ReactNode[] = []
  if (s.errors)
    parts.push(
      <span key="trend" className={TREND_TEXT[s.errors.stats.state]}>
        {t(TREND_LABEL[s.errors.stats.state])}
      </span>
    )
  if (slowest)
    parts.push(
      <span key="p95" title={t('health.board.p95Hint', { hours: env.slowFlowHours })}>
        p95 <b className="font-semibold text-text">{formatMs(slowest.p95Ms)}</b>
      </span>
    )
  if (s.pods.length > 0)
    parts.push(
      <span key="pods" className="text-danger">
        {tn('health.board.pods', s.pods.length)}
      </span>
    )
  if (s.silent && leadReason(s)?.kind !== 'silent')
    parts.push(
      <span key="silent" className="text-warning">
        {t('health.reporting.silent', { minutes: s.silent.silentMinutes })}
      </span>
    )
  if (alerts)
    parts.push(
      s.alerts > 0 ? (
        <span key="alerts" className="inline-flex items-center gap-1">
          <Bell className="size-3" aria-hidden />
          {tn('health.board.alerts', s.alerts)}
        </span>
      ) : (
        <span key="alerts">{t('health.board.noAlerts')}</span>
      )
    )
  return <span className="flex min-h-4 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-subtle">{parts}</span>
}

/** A starred service: name and state, its errors large beside their chart, then the facts. */
function LargeCard({ service: s, env, errorsRead, favorite, onFavorite, opened, onClick }: CardProps) {
  const { t, formatNumber } = useI18n()
  const { a, primary, picked, pickable } = useCardState(s)
  const busy = primary !== null && a.busyKey === primary.id
  return (
    <li className="relative min-w-0">
      <button
        type="button"
        aria-expanded={a.selecting ? undefined : opened}
        aria-pressed={a.selecting ? picked : undefined}
        disabled={!pickable}
        title={a.selecting ? undefined : t(opened ? 'health.details.hide' : 'health.details.show')}
        onClick={onClick}
        data-testid="health-service-card"
        className={cn(
          'flex h-full w-full flex-col rounded-[10px] border bg-surface px-4 py-3.5 text-left transition-colors hover:bg-surface-hover',
          BORDER[s.tone],
          opened && 'ring-1 ring-accent',
          picked && 'bg-accent-soft ring-1 ring-accent',
          !pickable && 'opacity-60'
        )}
      >
        <span className="flex w-full items-center gap-2 pr-7 pl-6">
          <span className="min-w-0 truncate text-md font-semibold" title={s.name}>
            {s.name}
          </span>
          <Badge tone={SERVICE_TONE[s.tone]} className="shrink-0">
            {t(serviceLabel(s))}
          </Badge>
          {picked && <CheckCircle2 className="ml-auto size-4 shrink-0 text-accent" aria-hidden />}
        </span>
        <span className="mt-2.5 flex w-full items-end gap-4">
          <span className="max-w-[45%] shrink-0">
            <span className="block text-[30px] leading-none font-semibold tabular-nums">{errorCount(s, errorsRead, formatNumber)}</span>
            <span className="mt-1.5 block text-xs text-subtle" data-testid="health-card-caption">
              <Caption service={s} errorsRead={errorsRead} />
            </span>
          </span>
          <CardChart service={s} env={env} height={60} showTypical />
        </span>
        <span className="mt-3 w-full">
          <Facts service={s} env={env} alerts />
        </span>
      </button>
      <StarButton name={s.name} on={favorite} onClick={onFavorite} className="top-3 left-3" />
      {primary && !a.selecting && (
        <IconButton
          size="sm"
          label={t('health.investigate')}
          hint={<span className="text-subtle">{a.folderHelp(primary.row)}</span>}
          disabled={a.busyKey !== null}
          icon={busy ? <Spinner /> : <Sparkles className="size-3.5" aria-hidden />}
          onClick={() => a.investigate(primary.id, primary.row)}
          className="absolute top-2.5 right-2.5"
        />
      )}
    </li>
  )
}

/** Any other service: star, name, a state dot, its errors with a small chart, and the facts. */
function SmallCard({ service: s, env, errorsRead, favorite, onFavorite, opened, onClick }: CardProps) {
  const { t, formatNumber } = useI18n()
  const { a, picked, pickable } = useCardState(s)
  const lead = leadReason(s)
  return (
    <li className="relative min-w-0">
      <button
        type="button"
        aria-expanded={a.selecting ? undefined : opened}
        aria-pressed={a.selecting ? picked : undefined}
        disabled={!pickable}
        title={a.selecting ? undefined : t(opened ? 'health.details.hide' : 'health.details.show')}
        onClick={onClick}
        data-testid="health-service-card"
        className={cn(
          'flex h-full w-full flex-col rounded-[10px] border border-border bg-surface px-3 py-2.5 text-left transition-colors hover:bg-surface-hover',
          opened && 'border-accent ring-1 ring-accent',
          picked && 'bg-accent-soft ring-1 ring-accent',
          !pickable && 'opacity-60'
        )}
      >
        <span className="flex w-full items-center gap-2 pl-6">
          <span className="min-w-0 flex-1 truncate font-semibold" title={s.name}>
            {s.name}
          </span>
          {picked ? <CheckCircle2 className="size-4 shrink-0 text-accent" aria-hidden /> : <StateDot tone={SERVICE_TONE[s.tone]} />}
          <span className="sr-only">{t(serviceLabel(s))}</span>
        </span>
        <span className="mt-2 flex w-full items-end gap-3">
          <span className="flex shrink-0 items-baseline gap-1">
            <span className="text-xl leading-none font-semibold tabular-nums">{errorCount(s, errorsRead, formatNumber)}</span>
            <span className="text-xs text-subtle">{t('health.board.errorsShort')}</span>
          </span>
          <CardChart service={s} env={env} height={28} />
        </span>
        <span className="mt-2 w-full">
          {lead && (
            <span className={cn('mb-0.5 block text-xs font-medium', SERVICE_TEXT[s.tone])} data-testid="health-card-caption">
              {lead.kind === 'pod' ? t(POD_LABEL[lead.pod.kind]) : t('health.reporting.silent', { minutes: lead.minutes })}
            </span>
          )}
          <Facts service={s} env={env} />
        </span>
      </button>
      <StarButton name={s.name} on={favorite} onClick={onFavorite} className="top-2 left-2" />
    </li>
  )
}

/** The slowest endpoints, one per row on a shared latency scale; "See all" opens the whole list, each row with its details, under them. */
export function SlowEndpoints({ env }: { env: HealthEnvironmentView }) {
  const { t, tn, formatNumber } = useI18n()
  const [open, setOpen] = useState(false)
  const slow = env.snapshot.slow
  const top = slow.slice(0, 4)
  const max = Math.max(...top.map((tx) => tx.p99Ms), 1)
  return (
    <Card aria-label={t('health.slow.title')} className="px-4 py-3.5" data-testid="health-slow">
      <div className="flex items-baseline gap-2">
        <h3 className="text-md font-semibold">{t('health.slow.title')}</h3>
        <span className="truncate text-xs text-subtle">{t('health.board.slowMeta', { hours: env.slowFlowHours })}</span>
        {slow.length > 0 && (
          <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-sm text-xs whitespace-nowrap text-subtle hover:text-text">
            {open ? t('health.board.slowHide') : tn('health.board.slowAll', slow.length)}
            <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} aria-hidden />
          </button>
        )}
      </div>
      {slow.length === 0 ? (
        <p className="mt-2 text-sm text-subtle">{t('health.slow.empty')}</p>
      ) : (
        <ul className="mt-2.5 flex flex-col divide-y divide-border">
          {top.map((tx) => (
            <li key={flowKey(tx)} className="grid grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto] items-center gap-x-5 py-2" data-testid="health-slow-row">
              <div className="min-w-0">
                <p className="truncate text-sm" title={`${tx.service} · ${tx.name}`}>
                  <span className="font-mono text-xs text-text">{tx.name}</span> <span className="text-xs text-subtle">{tx.service}</span>
                </p>
                <p className="text-xs whitespace-nowrap text-subtle tabular-nums">
                  p50 {formatMs(tx.p50Ms)} · p95 <b className="font-semibold text-text">{formatMs(tx.p95Ms)}</b> · p99 {formatMs(tx.p99Ms)}
                </p>
              </div>
              <LatencyRange tx={tx} max={max} />
              <div className="text-right text-xs whitespace-nowrap tabular-nums">
                <p className="text-muted">{tn('health.slow.calls', tx.calls, { count: formatNumber(tx.calls) })}</p>
                <p className={tx.failureRate >= SLOW_FAILURES_WARN ? 'text-danger' : 'text-subtle'}>{t('health.slow.failures', { rate: formatRate(tx.failureRate) })}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <ul className="mt-2 flex flex-col divide-y divide-border border-t border-border">
          {slow.map((tx) => (
            <SlowRow key={flowKey(tx)} tx={tx} env={env} />
          ))}
        </ul>
      )}
    </Card>
  )
}
