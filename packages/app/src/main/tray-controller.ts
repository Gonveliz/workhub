import { app, nativeTheme, type BrowserWindow } from 'electron'
import { appOptions, buildTrayPopover, hasUnread, knownAgents, parseTrayAction, pauseUntil, stampSince, type ConfigurationService, type SinceEntry, type TrayAction, type TrayPrEvent, type TrayRoute, type TraySession, type TrayState } from '@workhub/core'
import type { SlackSnapshot } from '../shared/chat-api'
import type { PullRequestWindowTab } from '../shared/codehost-api'
import type { TrayRendererState } from '../shared/tray-api'
import type { Locale } from '../renderer/i18n/translate'
import type { AgentUsageService } from './agent-usage'
import type { AutomationService } from './automations'
import type { CodeHostService } from './codehost'
import type { IpcRegistrar } from './ipc-guard'
import type { Notifier } from './notifier'
import type { SessionManager } from './session-manager'
import { TrayService } from './tray'
import { TrayPopover } from './tray-popover'
import { isLocale, trayText } from './tray-text'
import type { TrayToday } from './tray-today'
import type { UpdateService } from './updates'
import type { HealthWatcher } from './watchers'

/** Where "Check for updates" takes the user: General, pointing at its Updates group. */
const UPDATES_SETTINGS = 'general#updates'

const SESSION_STATES = new Set(['starting', 'ready', 'busy', 'stopped', 'error'])
const ATTENTION_KINDS = new Set(['error', 'needsAnswer', 'replied'])
function validTraySession(s: TraySession): boolean {
  return (
    !!s &&
    typeof s.id === 'string' &&
    typeof s.title === 'string' &&
    SESSION_STATES.has(s.state) &&
    (s.unseen === undefined || ATTENTION_KINDS.has(s.unseen)) &&
    (s.awaitingAnswer === undefined || typeof s.awaitingAnswer === 'boolean') &&
    (s.agentId === undefined || (typeof s.agentId === 'string' && s.agentId.length <= 100))
  )
}

export interface TrayControllerDeps {
  preload: string
  /** The icons' folder. */
  iconDir: string
  configuration: ConfigurationService
  codeHost: Pick<CodeHostService, 'cachedLists'>
  // Services built after the tray controller: read when the tray refreshes.
  sessions: () => Pick<SessionManager, 'list'>
  usage: () => Pick<AgentUsageService, 'current'>
  health: () => Pick<HealthWatcher, 'summary'>
  automations: () => Pick<AutomationService, 'snapshot'>
  notifier: () => Pick<Notifier, 'recent' | 'openRecent' | 'clearRecent'>
  today: () => TrayToday
  updates: () => Pick<UpdateService, 'check'>
  showMain: () => void
  loadPopover: (popover: BrowserWindow) => void
  openPullRequestWindow: (profileId: string | null, url: string, tab?: PullRequestWindowTab) => void
  openSettings: (section: unknown) => void
  navigate: (route: TrayRoute, section?: string) => void
  openLink: (profileId: string | null, url: string) => Promise<void>
  send: (channel: string, ...message: unknown[]) => void
  loadError: () => string | undefined
  configChanged: () => void
  scheduleMenu: () => void
  setBadgeCount: (sessions: TraySession[]) => void
}

export type TrayController = ReturnType<typeof createTrayController>

/** The menu bar / notification area icon (tray.ts), its popover and what they show that main does not keep elsewhere. */
export function createTrayController(deps: TrayControllerDeps) {
  const { configuration } = deps
  let trayService: TrayService | null = null
  /** The window a click on the icon opens (macOS, Windows); Linux keeps the native menu. */
  let trayPopover: TrayPopover | null = null
  /** Since when each session shows its state (the popover's times). */
  let sessionSince = new Map<string, SinceEntry>()
  let trayLocale: Locale = 'en'
  /** True once the renderer reported its language; until then the tray follows the system locale. */
  let trayLocaleFromRenderer = false
  /** The sessions with their unseen flags, as the renderer last reported them. */
  let rendererSessions: TraySession[] | null = null
  let lastSlack: SlackSnapshot | null = null
  const recentPrEvents: TrayPrEvent[] = []
  /** Options read synchronously (closing the window); refreshed on every options save and tray refresh. */
  let keepInTray = true
  const scheduleTray = () => trayService?.schedule()

  /** Everything the menu bar icon shows, read fresh. */
  async function trayState(): Promise<TrayState> {
    const config = await configuration.current()
    const options = appOptions(config)
    keepInTray = options.keepInTray
    const profileId = config.activeProfileId ?? null
    const listed = rendererSessions ?? deps.sessions().list().filter((v) => !v.readOnly).map((v) => ({ id: v.id, title: v.label, state: v.state, agentId: v.agentId }))
    const stamped = stampSince(sessionSince, listed, Date.now())
    sessionSince = stamped.since
    const sessionsNow = stamped.sessions
    const [lists, today] = await Promise.all([deps.codeHost.cachedLists(profileId).catch(() => null), deps.today().read(profileId)])
    const agentNames = new Map(knownAgents(config).map((a) => [a.id, a.name]))
    const slackOn = lastSlack && lastSlack.health !== 'off'
    const me = lastSlack?.me ?? ''
    const openThreads = lastSlack?.threads.filter((th) => !th.closed) ?? []
    return {
      appName: app.getName(),
      sessions: sessionsNow,
      usage: deps.usage().current().map((a) => ({ name: a.name || agentNames.get(a.agentId) || a.agentId, agentId: a.agentId, windows: a.windows, error: Boolean(a.error) })),
      pullRequests: lists && lists.state !== 'notConnected' ? { toReview: lists.toReview.length, mine: lists.mine.length } : null,
      prEvents: recentPrEvents,
      health: deps.health().summary(),
      slack: slackOn && lastSlack ? { health: lastSlack.health, open: openThreads.length, unread: openThreads.filter((th) => hasUnread(th, me)).length, error: lastSlack.lastError } : null,
      automations: deps
        .automations()
        .snapshot()
        .automations.filter((a) => a.definition.enabled && a.active)
        .map((a) => ({
          id: a.definition.id,
          name: a.definition.name,
          health: a.health,
          startedToday: a.startedToday,
          ...(a.waitReason ? { waitReason: a.waitReason.split('.')[0]! } : {}),
          ...(a.lastError ? { lastError: a.lastError } : {})
        })),
      notifications: deps.notifier().recent().map((n) => ({ id: n.id, title: n.title, at: n.at, ...(n.sessionId ? { sessionId: n.sessionId } : {}) })),
      calendar: today.calendar,
      planDueToday: today.planDueToday,
      popover: options.trayPopover,
      pausedUntil: options.notificationsPausedUntil,
      // WORKHUB_SHOW_UPDATE_MENU=1 shows the item in a dev run, to try where it leads (the check itself needs a packaged build).
      canCheckForUpdates: app.isPackaged || process.env['WORKHUB_SHOW_UPDATE_MENU'] === '1'
    }
  }

  async function performTrayAction(action: TrayAction): Promise<void> {
    switch (action.kind) {
      case 'open':
        return deps.showMain()
      case 'openSession':
        deps.showMain()
        return deps.send('notifications:open', action.id)
      case 'navigate':
        return deps.navigate(action.route)
      case 'openPullRequest':
        return deps.openPullRequestWindow(action.profileId || null, action.url)
      case 'openMeeting': {
        // Only a link the popover was given for that meeting is opened; without one, Plan shows it.
        const url = deps.today().joinUrl(action.id)
        if (url) return void deps.openLink((await configuration.current()).activeProfileId ?? null, url)
        return deps.navigate('plan')
      }
      case 'openSettings':
        return deps.openSettings(action.section)
      case 'openNotification':
        deps.notifier().openRecent(action.id)
        return
      case 'clearNotifications':
        deps.notifier().clearRecent()
        return
      case 'newSession':
        deps.showMain()
        return deps.send('tray:newSession')
      case 'pause':
      case 'resume': {
        if (deps.loadError()) return
        const until = action.kind === 'pause' ? pauseUntil(action.preset, new Date()) : 0
        const r = await configuration.saveOptions({ notificationsPausedUntil: until })
        if (r.ok) deps.configChanged()
        return scheduleTray()
      }
      case 'checkForUpdates':
        // Straight to the Updates group, highlighted, where the check's result shows.
        deps.navigate('settings', UPDATES_SETTINGS)
        void deps.updates().check()
        return
      case 'quit':
        return app.quit()
    }
  }

  /** The menu bar / notification area icon; a dev run is named "Workhub 2 Dev" there too. */
  function startTray(): void {
    // Linux (AppIndicator) sends no clicks, so it keeps the native menu only.
    const popover =
      process.platform === 'darwin' || process.platform === 'win32'
        ? new TrayPopover({
            platform: process.platform,
            preload: deps.preload,
            load: deps.loadPopover,
            refresh: () => void trayService?.refresh(),
            pinned: process.env['WORKHUB_TRAY_POPOVER_PIN'] === '1',
            dark: () => nativeTheme.shouldUseDarkColors
          })
        : null
    trayPopover = popover
    trayService = new TrayService({
      appName: app.getName(),
      platform: process.platform,
      iconDir: deps.iconDir,
      state: trayState,
      text: () => trayText(trayLocale),
      perform: (action) => void performTrayAction(action),
      activate: deps.showMain,
      logPath: process.env['WORKHUB_TRAY_LOG'],
      popover: popover ?? undefined,
      onState: (state) => popover?.setView(buildTrayPopover(state))
    })
    trayService.start()
    popover?.prepare()
    // WORKHUB_TRAY_POPOVER_PIN=1 opens the popover once the page is up and keeps it open (screenshots).
    if (popover && process.env['WORKHUB_TRAY_POPOVER_PIN'] === '1') setTimeout(() => popover.show(trayService?.bounds() ?? { x: 0, y: 0, width: 0, height: 0 }), 2500)
    // Usage, pull request lists and Health change on their own; the menu catches up once a minute.
    setInterval(scheduleTray, 60_000).unref?.()
  }

  /** Starts the icon; without a status area (some Linux desktops) closing the window then quits, as without the option. */
  function start(): void {
    try {
      startTray()
    } catch {
      trayService = null
      trayPopover?.destroy()
      trayPopover = null
    }
  }

  /** The renderer's report (`tray:state`) and the popover's own channels; actions are checked again here, field by field. */
  function registerIpc(ipc: IpcRegistrar): void {
    ipc.on('tray:state', (_e, state: TrayRendererState) => {
      if (isLocale(state?.locale) && state.locale !== trayLocale) {
        trayLocale = state.locale
        trayLocaleFromRenderer = true
        deps.scheduleMenu()
      }
      if (Array.isArray(state?.sessions)) rendererSessions = state.sessions.slice(0, 500).filter(validTraySession)
      scheduleTray()
      deps.setBadgeCount(rendererSessions ?? [])
    })
    ipc.handle('trayPopover:get', () => trayPopover?.currentView() ?? null)
    ipc.on('trayPopover:perform', (_e, raw: unknown) => {
      const action = parseTrayAction(raw)
      if (!action) return
      if (action.kind !== 'pause' && action.kind !== 'resume') trayPopover?.hide()
      void performTrayAction(action)
    })
    ipc.on('trayPopover:hide', (e) => {
      if (trayPopover?.owns(e.sender)) trayPopover.hide()
    })
  }

  return {
    schedule: scheduleTray,
    start,
    registerIpc,
    /** The language the tray and notifications are worded in. */
    locale: (): Locale => trayLocale,
    /** The first calendar check runs before the renderer reports its language: word it in the system's. */
    adoptSystemLocale: () => {
      if (!trayLocaleFromRenderer) {
        const system = app.getLocale().slice(0, 2)
        if (isLocale(system)) trayLocale = system
      }
    },
    keepInTray: () => keepInTray,
    setKeepInTray: (keep: boolean) => {
      keepInTray = keep
    },
    /** Whether the icon is up. */
    running: () => trayService !== null,
    popover: () => trayPopover,
    setSlack: (snap: SlackSnapshot) => {
      lastSlack = snap
    },
    notePrEvent: (event: TrayPrEvent) => {
      recentPrEvents.unshift(event)
      recentPrEvents.splice(10)
    }
  }
}
