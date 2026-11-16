import { BrowserWindow, dialog, nativeTheme } from 'electron'
import { homedir } from 'node:os'
import type { ConfigurationService } from '@workhub/core'
import type { ThemePreference } from '../../shared/api'
import { chromeColorsFrom, type ChromeColors } from '../chrome-colors'
import { rendererReporter } from '../diagnostics'
import type { IpcRegistrar } from '../ipc-guard'
import { listChromeProfiles } from '../link-system'
import type { Logger } from '../log-file'
import { profileWorkspaces } from '../workspaces'

export interface HubIpcDeps {
  log: Logger
  /** The main window as last created (a report from it is labelled `main`). */
  mainWindow: () => BrowserWindow | null
  revealLogs: () => void
  exportDiagnostics: () => Promise<unknown>
  setChromeOverride: (colors: ChromeColors | null) => void
  syncTitleBarOverlay: () => void
  configuration: ConfigurationService
  openLink: (url: string, profileId: string | null) => Promise<void>
}

/** The app shell's channels: diagnostics, theme, folders and external links (`diag:*`, `hub:*`, `links:*`). */
export function registerHubIpc(ipc: IpcRegistrar, deps: HubIpcDeps): void {
  const { configuration } = deps
  const report = rendererReporter(deps.log)
  ipc.on('diag:report', (e, r: unknown) => report(e.sender === deps.mainWindow()?.webContents ? 'main' : 'aux', r))
  ipc.on('diag:revealLogs', deps.revealLogs)
  ipc.handle('diag:export', deps.exportDiagnostics)
  ipc.on('hub:setTheme', (_e, theme: ThemePreference, chrome?: unknown) => {
    if (theme === 'system' || theme === 'light' || theme === 'dark') nativeTheme.themeSource = theme
    // The same light/dark with another palette fires no `updated`: sync here as well.
    if (chrome !== undefined) deps.setChromeOverride(chromeColorsFrom(chrome))
    deps.syncTitleBarOverlay()
  })
  nativeTheme.on('updated', deps.syncTitleBarOverlay)
  ipc.handle('hub:defaultCwd', () => homedir())
  ipc.handle('hub:pickFolder', async (e) => {
    // The picker sits on the window that asked (Settings has a window of its own), not always on the main one.
    const owner = BrowserWindow.fromWebContents(e.sender) ?? deps.mainWindow()!
    const r = await dialog.showOpenDialog(owner, { properties: ['openDirectory', 'createDirectory'], defaultPath: homedir() })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  // Only the folders the profile lists (and their children) are read: never a path the renderer names.
  ipc.handle('hub:profileFolders', async (_e, profileId: unknown) => {
    const config = await configuration.current()
    const profile = typeof profileId === 'string' ? config.profiles.find((p) => p.id === profileId) : undefined
    return profile ? profileWorkspaces(profile, homedir()) : []
  })
  ipc.on('hub:openExternal', (_e, url: unknown, profileId: unknown) => {
    if (typeof url === 'string') void deps.openLink(url, typeof profileId === 'string' ? profileId : null)
  })
  ipc.handle('links:chromeProfiles', (_e, app: unknown) => listChromeProfiles(typeof app === 'string' ? app : undefined))
}
