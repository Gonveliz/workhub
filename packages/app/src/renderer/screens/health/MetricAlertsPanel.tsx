import { BellOff, Check, ExternalLink, Inbox, LayoutGrid, List, ListFilter, RotateCcw, Star, X } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { availableAlertActions, moduleScreens, SNOOZE_CHOICES, type MetricAlert, type MetricAlertAction, type MetricAlertActionType, type SnoozeChoice } from '@workhub/core'
import { Badge, Button, Select, Spinner } from '../../components/atoms'
import { EmptyState, RefreshButton, useToast } from '../../components/molecules'
import { FILTER_ITEM, FILTER_MENU } from '../../components/molecules/FilterChip'
import { Sparkline } from '../../components/molecules/Sparkline'
import { useConfig } from '../../configStore'
import { useI18n, type I18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/errorText'
import { toggleKey } from '../../lib/healthBoard'
import {
  activeFilters,
  changeText,
  DEFAULT_ALERT_FILTERS,
  filterAlerts,
  KIND_FILTERS,
  KIND_LABEL,
  metricName,
  pinnedAlertKey,
  SEVERITY_FILTERS,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  splitPinned,
  STATUS_FILTERS,
  STATUS_LABEL,
  type AlertFilters
} from '../../lib/metricAlerts'
import { readPrefs, setPrefs, usePrefs } from '../../lib/prefs'
import { relativeTime } from '../../lib/pullRequests'
import { useMetricAlerts } from '../../metricAlertsStore'
import { AlertCard, alertWhere, dayDate, SNOOZE_LABEL, snoozedText } from './AlertCard'
import { BoardHeading } from './ServiceBoard'

interface ActionContext {
  alert: MetricAlert
  busy: boolean
  act: (action: MetricAlertAction) => void
  /** Files the alert in Plan's inbox as a pending bug. */
  sendToInbox: () => void
  t: I18n['t']
}

/**
 * How each action shows on a row, by action type. A new action adds its type in core's
 * `availableAlertActions` and one entry here.
 */
const ACTION_CONTROLS: Record<MetricAlertActionType, (c: ActionContext) => ReactNode> = {
  track: ({ busy, act, t }) => (
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ type: 'track' })}>
      {t('metricAlerts.action.track')}
    </Button>
  ),
  snooze: ({ busy, act, t }) => (
    <Select
      value=""
      placeholder={t('metricAlerts.action.snooze')}
      aria-label={t('metricAlerts.action.snooze')}
      disabled={busy}
      className="h-7 w-auto min-w-28 text-sm"
      onChange={(v) => {
        if ((SNOOZE_CHOICES as readonly string[]).includes(v)) act({ type: 'snooze', until: v as SnoozeChoice })
      }}
      options={SNOOZE_CHOICES.map((c) => ({ value: c, label: t(SNOOZE_LABEL[c]) }))}
    />
  ),
  resolve: ({ busy, act, t }) => (
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ type: 'resolve' })}>
      {t('metricAlerts.action.resolve')}
    </Button>
  ),
  reopen: ({ busy, act, t }) => (
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ type: 'reopen' })}>
      {t('metricAlerts.action.reopen')}
    </Button>
  ),
  sendToInbox: ({ busy, sendToInbox, t }) => (
    <Button size="sm" variant="ghost" disabled={busy} icon={<Inbox className="size-3.5" aria-hidden />} title={t('metricAlerts.action.sendToInboxHint')} onClick={sendToInbox}>
      {t('metricAlerts.action.sendToInbox')}
    </Button>
  )
}

function AlertRow({ alert, profileId, busy, act, inbox, sendToInbox }: { alert: MetricAlert; profileId: string; busy: boolean; act: (action: MetricAlertAction) => void; inbox: boolean; sendToInbox: () => void }) {
  const { t, formatDate } = useI18n()
  const name = metricName(alert, t)
  const change = changeText(alert, t('metricAlerts.points'))
  const where = alertWhere(alert)
  const since = formatDate(dayDate(alert.firstSeenDay), { day: 'numeric', month: 'short' })
  const snoozed = snoozedText(alert, { t, formatDate })
  return (
    <li className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0" data-testid="metric-alert">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={SEVERITY_TONE[alert.severity]}>{t(SEVERITY_LABEL[alert.severity])}</Badge>
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-text" title={`${name} · ${where}`}>
            {name} <span className="font-normal text-muted">· {where}</span>
          </p>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <span>{t(KIND_LABEL[alert.kind])}</span>
            {change && <span className="font-medium tabular-nums text-text">{change}</span>}
            <span className="tabular-nums">{t('metricAlerts.values', { value: alert.lastValue, baseline: alert.baseline })}</span>
            <span>{t('metricAlerts.since', { date: since })}</span>
            <span>{t(STATUS_LABEL[alert.status])}</span>
            {snoozed && <span>{snoozed}</span>}
          </p>
        </div>
        <Sparkline values={alert.history.map((h) => h.value)} label={t('metricAlerts.sparkline', { name, where })} />
        <div className="flex shrink-0 items-center gap-1">
          {alert.link && (
            <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" aria-hidden />} title={t('metricAlerts.openLink')} aria-label={t('metricAlerts.openLink')} onClick={() => window.hub.openExternal(alert.link!, profileId)} />
          )}
          {availableAlertActions(alert, { inbox }).map((type) => (
            <span key={type}>{ACTION_CONTROLS[type]({ alert, busy, act, sendToInbox, t })}</span>
          ))}
        </div>
      </div>
      {alert.proposeResolve && alert.status !== 'resolved' && (
        <div className="flex items-center gap-2 rounded-md bg-success-soft px-3 py-1.5 text-sm text-success" role="note">
          <span className="flex-1">{t('metricAlerts.proposeResolve')}</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ type: 'resolve' })}>
            {t('metricAlerts.action.resolve')}
          </Button>
        </div>
      )}
    </li>
  )
}

/** Health → Alerts: the profile's metric alerts, pinned first, as cards (or the compact list), with filters and the per-alert actions. */
export function MetricAlertsPanel({ profileId }: { profileId: string }) {
  const { t, tn, locale } = useI18n()
  const { view, loading, error, refresh, act } = useMetricAlerts(profileId)
  const toast = useToast()
  const snap = useConfig()
  const prefs = usePrefs()
  const inbox = moduleScreens(snap?.config.profiles.find((p) => p.id === profileId)?.modules).includes('planner')
  const [filters, setFilters] = useState<AlertFilters>(DEFAULT_ALERT_FILTERS)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const all = view?.alerts ?? []
  const pinnedKeys = useMemo(() => new Set(prefs.pinnedMetricAlerts), [prefs.pinnedMetricAlerts])
  const isPinned = useCallback((a: MetricAlert) => pinnedKeys.has(pinnedAlertKey(profileId, a.key)), [pinnedKeys, profileId])
  const filtered = useMemo(() => filterAlerts(all, filters), [all, filters])
  const shown = useMemo(() => (prefs.alertsPinnedOnly ? filtered.filter(isPinned) : filtered), [filtered, isPinned, prefs.alertsPinnedOnly])
  const { pinned, rest } = useMemo(() => splitPinned(shown, isPinned), [shown, isPinned])
  const run = (key: string, action: MetricAlertAction) => {
    setBusyKey(key)
    void act(key, action).finally(() => setBusyKey(null))
  }
  const sendToInbox = (key: string) => {
    setBusyKey(key)
    window.hub.planner
      .fromAlert(profileId, key)
      .then((r) => toast(r.ok ? t('metricAlerts.sentToInbox') : r.error, r.ok ? undefined : 'danger'), (e: unknown) => toast(errorText(e), 'danger'))
      .finally(() => setBusyKey(null))
  }
  const pin = (a: MetricAlert) => setPrefs({ pinnedMetricAlerts: toggleKey(readPrefs().pinnedMetricAlerts, pinnedAlertKey(profileId, a.key)) })
  const cards = prefs.alertsLayout === 'cards'
  const card = (a: MetricAlert, large: boolean) => (
    <AlertCard key={a.key} alert={a} profileId={profileId} large={large} pinned={isPinned(a)} onPin={() => pin(a)} busy={busyKey === a.key} act={(action) => run(a.key, action)} inbox={inbox} sendToInbox={() => sendToInbox(a.key)} />
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" data-testid="metric-alerts-toolbar">
        <AlertFiltersMenu filters={filters} onChange={setFilters} />
        <span className="ml-1 text-xs text-subtle" data-testid="metric-alerts-count">
          {tn('metricAlerts.count', shown.length)} · {tn('metricAlerts.pinnedCount', pinned.length)}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          aria-pressed={prefs.alertsPinnedOnly}
          onClick={() => setPrefs({ alertsPinnedOnly: !prefs.alertsPinnedOnly })}
          className={cn('inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs whitespace-nowrap text-text transition-colors', prefs.alertsPinnedOnly ? 'border-accent bg-accent-soft' : 'border-border-strong hover:bg-surface-hover')}
        >
          <Star className="size-3 fill-current" aria-hidden />
          {t('metricAlerts.onlyPinned')}
        </button>
        <div role="radiogroup" aria-label={t('metricAlerts.layout')} className="inline-flex rounded-[9px] border border-border bg-surface-raised p-0.5">
          {(['list', 'cards'] as const).map((layout) => (
            <button
              key={layout}
              type="button"
              role="radio"
              aria-checked={prefs.alertsLayout === layout}
              onClick={() => setPrefs({ alertsLayout: layout })}
              className={cn('inline-flex h-[26px] items-center gap-1.5 rounded-[7px] px-2.5 text-[12.5px] whitespace-nowrap transition-colors', prefs.alertsLayout === layout ? 'bg-accent-soft font-semibold text-text' : 'text-muted hover:text-text')}
            >
              {layout === 'list' ? <List className="size-3.5" aria-hidden /> : <LayoutGrid className="size-3.5" aria-hidden />}
              {t(layout === 'list' ? 'metricAlerts.layout.list' : 'metricAlerts.layout.cards')}
            </button>
          ))}
        </div>
        <RefreshButton
          label={t('metricAlerts.refresh')}
          hint={view?.updatedAt !== undefined ? <span className="text-subtle">{t('metricAlerts.evaluated', { time: relativeTime(view.updatedAt, Date.now(), locale) })}</span> : undefined}
          loading={loading}
          onRefresh={refresh}
        />
      </div>
      {error && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3">
          <p className="min-w-0 flex-1 break-words text-sm text-danger">{t('metricAlerts.loadFailed', { message: error })}</p>
          <Button size="sm" icon={loading ? <Spinner /> : <RotateCcw className="size-3.5" aria-hidden />} disabled={loading} onClick={() => void refresh()}>
            {t('health.retry')}
          </Button>
        </div>
      )}
      {!view && !error ? (
        <p className="flex items-center gap-2 py-10 text-sm text-muted" role="status">
          <Spinner /> {t('metricAlerts.loading')}
        </p>
      ) : shown.length === 0 ? (
        <EmptyState
          compact
          icon={<BellOff className="size-5" aria-hidden />}
          title={all.length === 0 ? t('metricAlerts.empty') : prefs.alertsPinnedOnly && filtered.length > 0 ? t('metricAlerts.noPinned') : t('metricAlerts.emptyFiltered')}
          description={all.length === 0 ? t('metricAlerts.emptyHint') : undefined}
        />
      ) : cards ? (
        <>
          {pinned.length > 0 && (
            <section className="flex flex-col gap-3" aria-label={t('metricAlerts.pinned')}>
              <BoardHeading note={<span title={t('metricAlerts.intro')}>{t('metricAlerts.band')}</span>}>{t('metricAlerts.pinned')}</BoardHeading>
              <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">{pinned.map((a) => card(a, true))}</ul>
            </section>
          )}
          {rest.length > 0 && (
            <section className={cn('flex flex-col gap-3', pinned.length > 0 && 'mt-1')} aria-label={t(pinned.length > 0 ? 'metricAlerts.rest' : 'metricAlerts.bySeverity')}>
              <BoardHeading note={pinned.length === 0 ? <span title={t('metricAlerts.intro')}>{t('metricAlerts.band')}</span> : undefined}>{t(pinned.length > 0 ? 'metricAlerts.rest' : 'metricAlerts.bySeverity')}</BoardHeading>
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-2.5">{rest.map((a) => card(a, false))}</ul>
            </section>
          )}
        </>
      ) : (
        <>
          <p className="text-sm text-muted">{t('metricAlerts.intro')}</p>
          <ul className="rounded-lg border border-border bg-surface shadow-sm">
            {[...pinned, ...rest].map((a) => (
              <AlertRow key={a.key} alert={a} profileId={profileId} busy={busyKey === a.key} act={(action) => run(a.key, action)} inbox={inbox} sendToInbox={() => sendToInbox(a.key)} />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/** "Filters · 1": the three filters of the tab in one menu; each one set shows as a chip next to it that clears it. */
function AlertFiltersMenu({ filters, onChange }: { filters: AlertFilters; onChange: (f: AlertFilters) => void }) {
  const { t } = useI18n()
  const active = activeFilters(filters)
  const groups = [
    { key: 'status', title: t('metricAlerts.filter.status'), options: STATUS_FILTERS.map((s) => ({ value: s, label: s === 'all' ? t('metricAlerts.filter.allStatuses') : s === 'open' ? t('metricAlerts.filter.open') : t(STATUS_LABEL[s]) })) },
    { key: 'severity', title: t('metricAlerts.filter.severity'), options: SEVERITY_FILTERS.map((s) => ({ value: s, label: s === 'all' ? t('metricAlerts.filter.allSeverities') : t(SEVERITY_LABEL[s]) })) },
    { key: 'kind', title: t('metricAlerts.filter.kind'), options: KIND_FILTERS.map((k) => ({ value: k, label: k === 'all' ? t('metricAlerts.filter.allKinds') : t(KIND_LABEL[k]) })) }
  ] as const
  const set = (key: keyof AlertFilters, value: string) => onChange({ ...filters, [key]: value } as AlertFilters)
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('metricAlerts.filters')}>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button size="sm" icon={<ListFilter className="size-3.5" aria-hidden />} data-testid="metric-alerts-filters">
            {active.length > 0 ? t('metricAlerts.filtersCount', { count: active.length }) : t('metricAlerts.filters')}
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={4} className={FILTER_MENU.replace('max-h-80', 'max-h-(--radix-dropdown-menu-content-available-height)')}>
            {groups.map((g, i) => (
              <DropdownMenu.Group key={g.key}>
                {i > 0 && <DropdownMenu.Separator className="my-1 h-px bg-border" />}
                <DropdownMenu.Label className="px-2 py-1 text-xs font-semibold text-subtle">{g.title}</DropdownMenu.Label>
                <DropdownMenu.RadioGroup value={filters[g.key]} onValueChange={(v) => set(g.key, v)}>
                  {g.options.map((o) => (
                    <DropdownMenu.RadioItem key={o.value} value={o.value} className={FILTER_ITEM} onSelect={(e) => e.preventDefault()}>
                      <span className="flex w-4 justify-center">
                        <DropdownMenu.ItemIndicator>
                          <Check className="size-3.5" aria-hidden />
                        </DropdownMenu.ItemIndicator>
                      </span>
                      {o.label}
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Group>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {active.map((key) => {
        const g = groups.find((x) => x.key === key)!
        const label = `${g.title}: ${(g.options as readonly { value: string; label: string }[]).find((o) => o.value === filters[key])?.label ?? filters[key]}`
        return (
          <span key={key} className="inline-flex h-6 items-center gap-1 rounded-full border border-accent bg-accent-soft pr-1 pl-2.5 text-xs whitespace-nowrap text-text" data-testid="metric-alerts-chip">
            {label}
            <button type="button" aria-label={t('metricAlerts.chip.remove', { filter: label })} title={t('metricAlerts.chip.remove', { filter: label })} onClick={() => set(key, 'all')} className="inline-flex size-4 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-text">
              <X className="size-3" aria-hidden />
            </button>
          </span>
        )
      })}
    </div>
  )
}
