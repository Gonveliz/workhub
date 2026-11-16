import { appOptions, isNotificationKind, sessionIdentity, TRAY_ROUTES, type ConfigurationService, type DueAction, type FlowAlert, type HealthAlert, type HealthAlertChannel, type MetricAlert, type TicketChange, type TrayPrEvent, type TrayRoute } from '@workhub/core'
import type { BrowserWindow } from 'electron'
import type { SessionNotification } from '../shared/api'
import type { PullRequestWindowTab } from '../shared/codehost-api'
import type { PrNotification } from '../shared/pr-events-api'
import type { Locale } from '../renderer/i18n/translate'
import type { AutomationService } from './automations'
import type { Notifier } from './notifier'
import { reminderNotifications, viewedSessions } from './permission-reminders'
import { meetingReminderWords } from './plan-ipc'
import type { SessionManager } from './session-manager'
import type { SessionWindows } from './session-windows'
import { flowAlertWords, healthAlertWords, metricAlertWords, trayText } from './tray-text'

// Open permission requests and questions are announced again every N minutes (Settings →
// Notifications, "Needs an answer") until answered, so one does not wait for hours unseen.
const PERMISSION_REMINDER_TICK_MS = 60_000

export interface NotificationsDeps {
  configuration: ConfigurationService
  // Built after the notifications: read when a notification is shown or clicked.
  notifier: () => Pick<Notifier, 'show'>
  sessions: () => Pick<SessionManager, 'list'>
  automations: () => Pick<AutomationService, 'notifies' | 'viewing'>
  sessionWindows: () => Pick<SessionWindows, 'focusedSession'>
  /** The main window while it exists. */
  liveMain: () => BrowserWindow | null
  showMain: () => void
  openSettings: (section: string | undefined) => void
  openPullRequestWindow: (profileId: string | null, url: string, tab?: PullRequestWindowTab) => void
  /** Set once the ticket IPC is registered. */
  openTicketWindow: () => ((profileId: string, key: string) => void) | null
  openLink: (profileId: string | null, url: string) => Promise<void>
  send: (channel: string, ...message: unknown[]) => void
  locale: () => Locale
  /** A pull request event the tray lists. */
  notePrEvent: (event: TrayPrEvent) => void
  scheduleTray: () => void
  log: (message: string) => void
}

export type Notifications = ReturnType<typeof createNotifications>

/** The OS notifications Workhub words itself and where a click on each one leads. */
export function createNotifications(deps: NotificationsDeps) {
  const { send, showMain } = deps
  const text = () => trayText(deps.locale())

  /** Brings the main window to `route`; Settings opens its own window on `section` (`general#updates` also points at one of its groups). */
  function navigate(route: TrayRoute, section?: string): void {
    if (route === 'settings') return deps.openSettings(section)
    showMain()
    send('tray:navigate', route)
  }

  /** A PR window's "Show in Workhub": the main window comes up on Pull requests with that PR selected. */
  function showPullRequestInMain(url: string, profileId: string | null): void {
    showMain()
    send('codeHost:focus', url, profileId)
  }

  /** A notification worded by the renderer; a click opens its session, or its screen. */
  function showSessionNotification(n: SessionNotification): void {
    if (!n || typeof n.title !== 'string' || typeof n.sessionId !== 'string') return
    const kind = isNotificationKind(n.kind) ? n.kind : 'replied'
    const route = n.route && TRAY_ROUTES.includes(n.route) ? n.route : undefined
    // An automation's sessions follow its own Notify setting (default: only failures).
    const view = deps.sessions().list().find((s) => s.id === n.sessionId)
    if (view && (kind === 'replied' || kind === 'needsAnswer' || kind === 'error') && !deps.automations().notifies(sessionIdentity(view), kind)) return
    void deps.notifier().show(kind, n, () => {
      if (route) return navigate(route)
      showMain()
      send('notifications:open', n.sessionId)
    }, { sessionId: n.sessionId }, `session:${n.sessionId}`)
  }

  const remindedAt = new Map<string, number>()
  let permissionReminderTimer: ReturnType<typeof setInterval> | undefined
  async function remindWaitingSessions(): Promise<void> {
    const options = appOptions(await deps.configuration.current())
    const main = deps.liveMain()
    const viewing = viewedSessions({ visible: !!main?.isVisible(), focused: !!main?.isFocused(), session: deps.automations().viewing() }, deps.sessionWindows().focusedSession())
    const input = { views: deps.sessions().list(), remindedAt, now: Date.now(), intervalMinutes: options.notifyNeedsAnswer ? options.remindNeedsAnswerMinutes : 0, viewing, t: text().t }
    for (const n of reminderNotifications(input)) showSessionNotification(n)
  }

  /** A usage alert (worded by the renderer); a click brings the window up on Home. */
  function showUsageNotification(n: { title: string; body: string }): void {
    void deps.notifier().show('usage', n, () => {
      showMain()
      send('usage:open')
    })
  }

  /** An OS notification about a pull request event; a click opens that pull request. */
  function showPullRequestNotification(n: PrNotification): void {
    if (typeof n?.title !== 'string') return
    deps.notePrEvent({ profileId: n.profileId, url: n.url, title: n.title })
    deps.scheduleTray()
    void deps.notifier().show('prEvent', n, () => {
      if (deps.liveMain()) showMain()
      deps.openPullRequestWindow(n.profileId || null, n.url)
    }, { url: n.url, profileId: n.profileId })
  }

  function ticketNotification(profileId: string, change: TicketChange): void {
    const { t } = text()
    const words =
      change.kind === 'status'
        ? { title: t('notify.ticket.status', { key: change.key, from: change.from, to: change.to }), body: t('notify.ticket.statusBody', { title: change.title }) }
        : change.kind === 'assigned'
          ? { title: t('notify.ticket.assigned', { key: change.key }), body: t('notify.ticket.assignedBody', { title: change.title, status: change.status }) }
          : { title: t('notify.ticket.left', { key: change.key }), body: t('notify.ticket.leftBody', { title: change.title }) }
    void deps.notifier().show('tickets', words, () => deps.openTicketWindow()?.(profileId, change.key), { ticket: change.key })
  }

  function healthNotification(alert: HealthAlert, channels: HealthAlertChannel[]): void {
    void deps.notifier().show('health', healthAlertWords(alert, text().t), () => navigate('health'), { environmentId: alert.environmentId }, undefined, channels)
  }

  function flowAlertNotification(alert: FlowAlert): void {
    void deps.notifier().show('flowMaps', flowAlertWords(alert, text().t), () => navigate('flowMaps'), { mapId: alert.mapId, environmentId: alert.environmentId })
  }

  /** A meeting reminder; a click joins the call when there is a link, else shows the Plan screen. */
  function meetingReminder(profileId: string, action: DueAction): void {
    const now = Date.now()
    const words = meetingReminderWords(action, now, text())
    const url = action.event.meetingUrl
    void deps.notifier().show('meeting', words, () => {
      if (url) return void deps.openLink(profileId, url)
      showMain()
      send('plan:focus')
    }, { eventId: action.event.id, rule: action.ruleId })
  }

  /** Demo calendar: a brief rule matched. Nothing starts; "Prepare brief" on the meeting does, on request. */
  async function demoBriefNotice(action: DueAction): Promise<void> {
    const { t } = text()
    const words = { title: t('notify.brief.demo', { title: action.event.title || t('plan.untitled') }), body: t('notify.brief.demoBody') }
    void deps.notifier().show('meeting', words, () => {
      showMain()
      send('plan:focus')
    }, { eventId: action.event.id, rule: action.ruleId })
  }

  function metricAlertNotification(profileId: string, alerts: MetricAlert[]): void {
    void deps.notifier().show('metricAlert', metricAlertWords(alerts, text().t), () => {
      navigate('health')
      send('metricAlerts:open', profileId)
    }, { profileId, alerts: alerts.map((a) => a.key) })
  }

  return {
    navigate,
    showPullRequestInMain,
    showSessionNotification,
    showUsageNotification,
    showPullRequestNotification,
    ticketNotification,
    healthNotification,
    flowAlertNotification,
    meetingReminder,
    demoBriefNotice,
    metricAlertNotification,
    startReminders: () => {
      permissionReminderTimer = setInterval(() => void remindWaitingSessions().catch((err: unknown) => deps.log(`permission reminders: ${err instanceof Error ? err.message : String(err)}`)), PERMISSION_REMINDER_TICK_MS)
    },
    stopReminders: () => {
      if (permissionReminderTimer) clearInterval(permissionReminderTimer)
    }
  }
}
