import { Check, ExternalLink, Inbox, MoreHorizontal, RotateCcw, Star } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { availableAlertActions, SNOOZE_CHOICES, type AlertSeverity, type MetricAlert, type MetricAlertAction, type SnoozeChoice } from '@workhub/core'
import { Badge, Button, Tooltip } from '../../components/atoms'
import { FILTER_ITEM, FILTER_MENU } from '../../components/molecules/FilterChip'
import { Sparkline } from '../../components/molecules/Sparkline'
import { useI18n, type I18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { cn } from '../../lib/cn'
import { changeText, historyBand, KIND_LABEL, metricName, SEVERITY_LABEL, SEVERITY_TONE, STATUS_LABEL } from '../../lib/metricAlerts'

export const SNOOZE_LABEL: Record<SnoozeChoice, MessageKey> = { '7d': 'metricAlerts.snooze.7d', '30d': 'metricAlerts.snooze.30d', trendChange: 'metricAlerts.snooze.trendChange' }

/** The change and the line in the color of the alert's severity. */
const SEVERITY_TEXT: Record<AlertSeverity, string> = { high: 'text-danger', medium: 'text-warning', low: 'text-info' }

/** A local `YYYY-MM-DD` as a date. */
export const dayDate = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

/** "until Nov 25" or "until the trend changes" for a snoozed alert; null otherwise. */
export function snoozedText(alert: MetricAlert, { t, formatDate }: Pick<I18n, 't' | 'formatDate'>): string | null {
  if (alert.status !== 'snoozed') return null
  if (alert.snoozedUntil === 'trendChange') return t('metricAlerts.snoozedTrend')
  return typeof alert.snoozedUntil === 'number' ? t('metricAlerts.snoozedUntil', { date: formatDate(alert.snoozedUntil, { day: 'numeric', month: 'short' }) }) : null
}

/** Where an alert is: its subject and segment. */
export const alertWhere = (alert: Pick<MetricAlert, 'subject' | 'segment'>) => (alert.segment ? `${alert.subject} · ${alert.segment}` : alert.subject)

export interface AlertCardProps {
  alert: MetricAlert
  profileId: string
  /** Pinned alerts are drawn large, with their own "To the inbox" button. */
  large: boolean
  pinned: boolean
  onPin: () => void
  busy: boolean
  act: (action: MetricAlertAction) => void
  /** Plan's inbox is on for the profile. */
  inbox: boolean
  sendToInbox: () => void
}

/**
 * One alert as a card: the change in the severity's color with its two values, its last 14 days
 * over a band of the values before the last, its status, and one action (Resolve, or Reopen once
 * resolved). Every other action of the list row (open the source, follow, send to the inbox,
 * snooze) is in the card's ⋯ menu.
 */
export function AlertCard({ alert, profileId, large, pinned, onPin, busy, act, inbox, sendToInbox }: AlertCardProps) {
  const i18n = useI18n()
  const { t, formatDate, formatNumber } = i18n
  const name = metricName(alert, t)
  const where = alertWhere(alert)
  const change = changeText(alert, t('metricAlerts.points'))
  const actions = availableAlertActions(alert, { inbox })
  const snoozed = snoozedText(alert, i18n)
  const since = t('metricAlerts.since', { date: formatDate(dayDate(alert.firstSeenDay), { day: 'numeric', month: 'short' }) })
  const status = alert.proposeResolve && alert.status !== 'resolved' ? t('metricAlerts.proposeResolve') : snoozed ? `${t(STATUS_LABEL[alert.status])} ${snoozed}` : alert.status === 'resolved' ? t(STATUS_LABEL[alert.status]) : `${t(STATUS_LABEL[alert.status])} · ${since}`
  const inboxButton = large && actions.includes('sendToInbox')
  const pinLabel = t(pinned ? 'metricAlerts.unpin' : 'metricAlerts.pin', { name })
  return (
    <li className={cn('flex min-w-0 flex-col overflow-hidden rounded-[10px] border border-border bg-surface', large ? 'px-4 py-3.5' : 'px-3 py-2.5')} data-testid="metric-alert-card">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-pressed={pinned}
          aria-label={pinLabel}
          title={pinLabel}
          onClick={onPin}
          data-testid="metric-alert-pin"
          className={cn('-ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-surface-hover', pinned ? 'text-warning' : 'text-subtle opacity-60 hover:opacity-100 focus-visible:opacity-100')}
        >
          <Star className={cn('size-3.5', pinned && 'fill-current')} aria-hidden />
        </button>
        <Badge tone={SEVERITY_TONE[alert.severity]} className="shrink-0">
          {t(SEVERITY_LABEL[alert.severity])}
        </Badge>
        <h3 className="min-w-0 flex-1 truncate text-md font-semibold" title={`${name} · ${where}`}>
          {name}
        </h3>
        <AlertMenu alert={alert} profileId={profileId} busy={busy} act={act} actions={actions} sendToInbox={inboxButton ? undefined : sendToInbox} />
      </div>
      <p className="mt-0.5 truncate text-xs text-subtle">
        {where} · {t(KIND_LABEL[alert.kind])}
      </p>
      <div className={cn('flex items-end gap-3', large ? 'mt-2.5' : 'mt-2')}>
        <div className="shrink-0">
          <div className={cn('leading-none font-semibold whitespace-nowrap tabular-nums', large ? 'text-[26px]' : 'text-[19px]', SEVERITY_TEXT[alert.severity])}>{change ?? formatNumber(alert.lastValue)}</div>
          <div className="mt-1 text-xs whitespace-nowrap text-subtle tabular-nums">{t('metricAlerts.values', { value: alert.lastValue, baseline: alert.baseline })}</div>
        </div>
        <span className="flex-1" />
        {alert.history.length > 1 && (
          <Sparkline
            values={alert.history.map((h) => h.value)}
            band={historyBand(alert.history)}
            fill
            width={large ? 300 : 128}
            height={large ? 78 : 44}
            label={t('metricAlerts.sparkline', { name, where })}
            className={cn('min-w-0', SEVERITY_TEXT[alert.severity])}
          />
        )}
      </div>
      <div className={cn('mt-auto flex items-center gap-2', large ? 'pt-2.5' : 'pt-2')}>
        <span className={cn('line-clamp-2 min-w-0 flex-1 text-xs', alert.proposeResolve && alert.status !== 'resolved' ? 'text-success' : 'text-subtle')} title={status}>
          {status}
        </span>
        {inboxButton && (
          <Button size="sm" variant="ghost" disabled={busy} icon={<Inbox className="size-3.5" aria-hidden />} title={t('metricAlerts.action.sendToInboxHint')} onClick={sendToInbox}>
            {t('metricAlerts.action.toInbox')}
          </Button>
        )}
        {actions.includes('resolve') ? (
          <Button size="sm" disabled={busy} icon={<Check className="size-3.5" aria-hidden />} onClick={() => act({ type: 'resolve' })}>
            {t('metricAlerts.action.resolve')}
          </Button>
        ) : (
          actions.includes('reopen') && (
            <Button size="sm" disabled={busy} icon={<RotateCcw className="size-3.5" aria-hidden />} onClick={() => act({ type: 'reopen' })}>
              {t('metricAlerts.action.reopen')}
            </Button>
          )
        )}
      </div>
    </li>
  )
}

/** The ⋯ of a card: the source link and every action but the card's own button. */
function AlertMenu({ alert, profileId, busy, act, actions, sendToInbox }: { alert: MetricAlert; profileId: string; busy: boolean; act: (action: MetricAlertAction) => void; actions: ReturnType<typeof availableAlertActions>; sendToInbox?: () => void }) {
  const { t } = useI18n()
  // Resolve is the card's button; Reopen too once resolved.
  const reopen = actions.includes('reopen') && actions.includes('resolve')
  const items = [alert.link, actions.includes('track'), sendToInbox && actions.includes('sendToInbox'), actions.includes('snooze'), reopen].filter(Boolean)
  if (items.length === 0) return null
  return (
    <DropdownMenu.Root>
      <Tooltip content={t('metricAlerts.more')}>
        <DropdownMenu.Trigger aria-label={t('metricAlerts.more')} disabled={busy} className="-mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-surface-hover hover:text-text disabled:opacity-45" data-testid="metric-alert-menu">
          <MoreHorizontal className="size-3.5" aria-hidden />
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={FILTER_MENU}>
          {alert.link && (
            <DropdownMenu.Item className={FILTER_ITEM} onSelect={() => window.hub.openExternal(alert.link!, profileId)}>
              <ExternalLink className="size-3.5 text-muted" aria-hidden />
              {t('metricAlerts.openLink')}
            </DropdownMenu.Item>
          )}
          {actions.includes('track') && (
            <DropdownMenu.Item className={FILTER_ITEM} onSelect={() => act({ type: 'track' })}>
              <span className="size-3.5" aria-hidden />
              {t('metricAlerts.action.track')}
            </DropdownMenu.Item>
          )}
          {sendToInbox && actions.includes('sendToInbox') && (
            <DropdownMenu.Item className={FILTER_ITEM} onSelect={sendToInbox}>
              <Inbox className="size-3.5 text-muted" aria-hidden />
              {t('metricAlerts.action.sendToInbox')}
            </DropdownMenu.Item>
          )}
          {reopen && (
            <DropdownMenu.Item className={FILTER_ITEM} onSelect={() => act({ type: 'reopen' })}>
              <RotateCcw className="size-3.5 text-muted" aria-hidden />
              {t('metricAlerts.action.reopen')}
            </DropdownMenu.Item>
          )}
          {actions.includes('snooze') && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Label className="px-2 py-1 text-xs text-subtle">{t('metricAlerts.action.snooze')}</DropdownMenu.Label>
              {SNOOZE_CHOICES.map((c) => (
                <DropdownMenu.Item key={c} className={FILTER_ITEM} onSelect={() => act({ type: 'snooze', until: c })}>
                  <span className="size-3.5" aria-hidden />
                  {t(SNOOZE_LABEL[c])}
                </DropdownMenu.Item>
              ))}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
