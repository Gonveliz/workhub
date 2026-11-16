import { app, BrowserWindow, nativeTheme, session, type BrowserWindowConstructorOptions, type WebContents } from 'electron'
import { pathToFileURL } from 'node:url'
import type { PullRequestWindowTab } from '../shared/codehost-api'
import type { SetupPage } from '../shared/setup-api'
import { signInHash } from '../shared/sign-in-api'
import { TRAY_POPOVER_HASH } from '../shared/tray-api'
import type { ChromeColors } from './chrome-colors'
import { isTrustedRendererUrl, rendererDevServerUrl, type RendererOrigin } from './ipc-guard'
import type { Logger } from './log-file'
import { permissionAllowed } from './permissions'
import { ReloadGuard, watchRenderer } from './render-recovery'
import type { WindowBounds } from './session-windows'

/** Toolbar colors per theme; they match the renderer's --wh-bg and --wh-text tokens. */
const CHROME = {
  dark: { color: '#0e1014', symbolColor: '#e8eaef' },
  light: { color: '#f5f6f8', symbolColor: '#14171c' }
} as const
const TITLE_BAR_HEIGHT = 48

export interface AuxWindowSize {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

export const TICKET_WINDOW_SIZE: AuxWindowSize = { width: 820, height: 760, minWidth: 560, minHeight: 420 }
export const FILE_WINDOW_SIZE: AuxWindowSize = { width: 900, height: 760, minWidth: 420, minHeight: 320 }
export const REVIEW_LOOP_WINDOW_SIZE: AuxWindowSize = { width: 860, height: 820, minWidth: 480, minHeight: 400 }
export const SIGN_IN_WINDOW_SIZE: AuxWindowSize = { width: 760, height: 620, minWidth: 520, minHeight: 440 }
export const PLAN_ITEM_WINDOW_SIZE: AuxWindowSize = { width: 720, height: 780, minWidth: 460, minHeight: 400 }

const SETUP_HASH: Record<SetupPage, { hash: string; size: AuxWindowSize }> = {
  welcome: { hash: '#welcome', size: { width: 760, height: 640, minWidth: 620, minHeight: 520 } },
  check: { hash: '#setup', size: { width: 720, height: 680, minWidth: 560, minHeight: 440 } },
  help: { hash: '#howitworks', size: { width: 720, height: 680, minWidth: 560, minHeight: 440 } }
}

export interface WindowsDeps {
  /** The preload script every window gets. */
  preload: string
  /** The built renderer's index.html. */
  rendererFile: string
  /** A new main window was created (the app badge's overlay belongs to it). */
  mainCreated: () => void
  /** Whether closing the main window lets it close (quitting, or not kept in the menu bar). */
  allowMainClose: () => boolean
  /** The tray popover has no overlay, but its solid background follows the light or dark look. */
  syncPopoverTheme: () => void
  /** Every external link goes through the link service. */
  openLink: (url: string) => void
  log: Logger
}

export type Windows = ReturnType<typeof createWindows>

/** The main window, the secondary windows and the navigation and permission guards of every window. */
export function createWindows(deps: WindowsDeps) {
  const { rendererFile } = deps
  let win: BrowserWindow | null = null

  /** The renderer's own colors, once it reported them (a terminal theme applied to the app changes them). */
  let chromeOverride: ChromeColors | null = null

  function chromeColors(): ChromeColors {
    return chromeOverride ?? (nativeTheme.shouldUseDarkColors ? CHROME.dark : CHROME.light)
  }

  /**
   * Window chrome per platform: macOS keeps its traffic lights inset into the sidebar; Windows and
   * Linux draw their window controls as an overlay on the right of the toolbar.
   */
  function windowChrome(): BrowserWindowConstructorOptions {
    if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } }
    return { titleBarStyle: 'hidden', titleBarOverlay: { ...chromeColors(), height: TITLE_BAR_HEIGHT } }
  }

  /**
   * The overlay controls (Windows, Linux) of every window follow the theme: nativeTheme fires
   * `updated` on a light/dark change and the renderer reports its colors on every theme change.
   */
  function syncTitleBarOverlay(): void {
    if (process.platform === 'darwin') return
    // The tray popover has no overlay, but its solid background follows the light or dark look.
    deps.syncPopoverTheme()
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      try {
        w.setTitleBarOverlay({ ...chromeColors(), height: TITLE_BAR_HEIGHT })
      } catch {
        // A window without the overlay (the tray popover, the file viewer) throws; nothing to sync there.
      }
    }
  }

  /** The dev server's address; always undefined in a packaged app, whatever its environment holds. */
  function devServerUrl(): string | undefined {
    return rendererDevServerUrl(process.env, app.isPackaged)
  }
  /** The only pages allowed to talk to the main process. */
  const rendererOrigin: RendererOrigin = { fileUrl: pathToFileURL(rendererFile).href, devServerUrl: devServerUrl() }

  /** A secondary window (a pull request, a ticket) on the same renderer, routed by its hash. */
  function createAuxWindow(hash: string, title: string, size: AuxWindowSize = TICKET_WINDOW_SIZE, bounds?: WindowBounds): BrowserWindow {
    const aux = new BrowserWindow({
      ...size,
      ...(bounds ?? {}),
      title,
      backgroundColor: chromeColors().color,
      ...windowChrome(),
      webPreferences: { preload: deps.preload, contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    // Links inside the app never navigate or open windows of their own.
    aux.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    if (devServerUrl()) void aux.loadURL(devServerUrl() + hash)
    else void aux.loadFile(rendererFile, { hash: hash.replace(/^#/, '') })
    return aux
  }

  function createWindow(): void {
    win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 900,
      minHeight: 560,
      title: 'Workhub 2',
      backgroundColor: chromeColors().color,
      ...windowChrome(),
      webPreferences: {
        preload: deps.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    // Navigation and new-window guards for every window: see guardWebContents below.
    if (devServerUrl()) void win.loadURL(devServerUrl()!)
    else void win.loadFile(rendererFile)
    deps.mainCreated()
    // "Keep running in the menu bar": closing hides the window; sessions, watchers and notifications go on.
    win.on('close', (event) => {
      if (deps.allowMainClose()) return
      event.preventDefault()
      win?.hide()
    })
  }

  /** Brings the main window up (it may be hidden in the menu bar) and the app to the front. */
  function showMain(): void {
    if (!win || win.isDestroyed()) createWindow()
    const w = win!
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
    if (process.platform === 'darwin') app.focus({ steal: true })
  }

  /** The renderer's popover route (main.tsx), in the dev server or the built files. */
  function loadPopover(popover: BrowserWindow): void {
    if (devServerUrl()) void popover.loadURL(devServerUrl() + TRAY_POPOVER_HASH)
    else void popover.loadFile(rendererFile, { hash: TRAY_POPOVER_HASH.slice(1) })
  }

  /** Setup windows (welcome, setup check, how Workhub works): one of each at a time. */
  const setupWindows = new Map<SetupPage, BrowserWindow>()

  function openSetupWindow(page: SetupPage): void {
    const open = setupWindows.get(page)
    if (open && !open.isDestroyed()) {
      if (open.isMinimized()) open.restore()
      open.focus()
      return
    }
    const { hash, size } = SETUP_HASH[page]
    const created = createAuxWindow(hash, 'Workhub 2', size)
    setupWindows.set(page, created)
    created.on('closed', () => setupWindows.delete(page))
  }

  /** One window per sign-in flow (sign-in.ts); closing it stops the flow's command. */
  const signInWindows = new Map<string, BrowserWindow>()

  function openSignInWindow(id: string, closed: () => void): void {
    const open = signInWindows.get(id)
    if (open && !open.isDestroyed()) {
      if (open.isMinimized()) open.restore()
      open.focus()
      return
    }
    const created = createAuxWindow(signInHash(id), 'Workhub 2', SIGN_IN_WINDOW_SIZE)
    signInWindows.set(id, created)
    created.on('closed', () => {
      signInWindows.delete(id)
      closed()
    })
  }

  /** One window per pull request; opening an open one brings it to the front. */
  const prWindows = new Map<string, BrowserWindow>()

  function openPullRequestWindow(profileId: string | null, url: string, tab?: PullRequestWindowTab): void {
    const open = prWindows.get(url)
    if (open && !open.isDestroyed()) {
      if (open.isMinimized()) open.restore()
      open.focus()
      if (tab) open.webContents.send('codeHost:showTab', tab)
      return
    }
    const hash = `#pr?profile=${encodeURIComponent(profileId ?? '')}&url=${encodeURIComponent(url)}${tab ? `&tab=${tab}` : ''}`
    // Wide by default: the conversation sits beside the description and the diff gets the full width.
    const prWin = createAuxWindow(hash, 'Pull request', { width: 1280, height: 860, minWidth: 720, minHeight: 480 })
    prWindows.set(url, prWin)
    prWin.on('closed', () => prWindows.delete(url))
  }

  /** One review window per session; opening an open one brings it to the front. */
  const reviewWindows = new Map<string, BrowserWindow>()

  function openLocalReviewWindow(sessionId: string, reload = false): void {
    const open = reviewWindows.get(sessionId)
    if (open && !open.isDestroyed()) {
      if (open.isMinimized()) open.restore()
      // Drafts live in the main process, so a reload only refreshes the diff.
      if (reload) open.webContents.reload()
      open.focus()
      return
    }
    const reviewWin = createAuxWindow(`#review?session=${encodeURIComponent(sessionId)}`, 'Workhub 2', { width: 1280, height: 820, minWidth: 900, minHeight: 560 })
    reviewWindows.set(sessionId, reviewWin)
    reviewWin.on('closed', () => reviewWindows.delete(sessionId))
  }

  /**
   * Every window and webview the app ever creates stays on the app's renderer: navigations and
   * redirects away from it are refused (web links go to the default browser instead), new windows
   * are denied, and <webview> tags never attach. A window that rendered untrusted Markdown (a pull
   * request, a ticket) can then never turn into a remote page that still holds `window.hub`.
   */
  function guardWebContents(): void {
    const reloadGuard = new ReloadGuard()
    app.on('web-contents-created', (_event, contents: WebContents) => {
      // Every BrowserWindow (main, auxiliary, popover) passes through here: one place for crash recovery.
      watchRenderer(contents, deps.log, reloadGuard)
      contents.on('will-navigate', (event, url) => {
        if (url === contents.getURL()) return
        event.preventDefault()
        deps.openLink(url)
      })
      contents.on('will-redirect', (event, url) => {
        if (!isTrustedRendererUrl(url, rendererOrigin)) event.preventDefault()
      })
      contents.on('will-attach-webview', (event) => event.preventDefault())
      // Links in agent replies open in the default browser, never inside the app.
      contents.setWindowOpenHandler(({ url }) => {
        deps.openLink(url)
        return { action: 'deny' }
      })
    })
  }

  /** Web permission requests and checks are denied by default (see permissions.ts). */
  function denyWebPermissions(): void {
    const trusted = (url: string | null) => isTrustedRendererUrl(url, rendererOrigin)
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(permissionAllowed(permission, details.requestingUrl || contents.getURL(), trusted))
    )
    session.defaultSession.setPermissionCheckHandler((contents, permission) => permissionAllowed(permission, contents?.getURL(), trusted))
  }

  return {
    /** The main window as last created, destroyed or not (null before the first one). */
    main: (): BrowserWindow | null => win,
    /** The main window while it exists. */
    liveMain: (): BrowserWindow | null => (win && !win.isDestroyed() ? win : null),
    rendererOrigin,
    chromeColors,
    setChromeOverride: (colors: ChromeColors | null) => {
      chromeOverride = colors
    },
    syncTitleBarOverlay,
    createAuxWindow,
    createWindow,
    showMain,
    loadPopover,
    openSetupWindow,
    setupWindow: (page: SetupPage) => setupWindows.get(page),
    openSignInWindow,
    openPullRequestWindow,
    openLocalReviewWindow,
    guardWebContents,
    denyWebPermissions
  }
}
