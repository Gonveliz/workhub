import type { BrowserWindow } from 'electron'
import type { ConfigurationService } from '@workhub/core'
import type { SetupPage } from '../../shared/setup-api'
import { registerAgentToolsIpc, type AgentToolsService } from '../agent-tools'
import type { IpcRegistrar } from '../ipc-guard'
import { settingsSectionArg, type SettingsWindow } from '../settings-window'
import { registerSetupInstallIpc, type SetupInstallIpcDeps } from '../setup-ipc'
import type { SetupService } from '../setup-service'

export interface SetupIpcDeps {
  setup: Pick<SetupService, 'run'>
  /** One install (a row's Install), "Install what is missing" and the tools folder (setup-ipc.ts). */
  installs: SetupInstallIpcDeps
  agentTools: AgentToolsService
  openSetupWindow: (page: SetupPage) => void
  setupWindow: (page: SetupPage) => BrowserWindow | undefined
  settingsWindow: Pick<SettingsWindow, 'open' | 'setDirty' | 'close'>
  configuration: ConfigurationService
  loadError: () => string | undefined
  configChanged: () => void
  /** The home and Documents folders (the welcome's default folder). */
  folders: () => { home: string; documents: string }
}

/** The setup checklist and its installs, the setup windows and the Settings window (`setup:*`, `settings:*`, `agentTools:*`). */
export function registerSetupIpc(ipc: IpcRegistrar, deps: SetupIpcDeps): void {
  const { settingsWindow } = deps
  ipc.handle('setup:run', () => deps.setup.run())
  registerSetupInstallIpc(ipc, deps.installs)
  registerAgentToolsIpc(ipc, deps.agentTools)
  ipc.on('setup:openWindow', (_e, page: SetupPage) => {
    if (page === 'welcome' || page === 'check' || page === 'help') deps.openSetupWindow(page)
  })
  // A setup window's fix button (or a link inside Settings) asks for a Settings tab.
  ipc.on('setup:openSettings', (_e, tab: unknown) => {
    if (typeof tab === 'string') settingsWindow.open(settingsSectionArg(tab))
  })
  ipc.on('settings:open', (_e, section: unknown) => settingsWindow.open(settingsSectionArg(section)))
  ipc.on('settings:setDirty', (e, dirty: unknown) => settingsWindow.setDirty(e.sender.id, dirty === true))
  ipc.on('settings:close', (e) => settingsWindow.close(e.sender.id))
  ipc.handle('setup:folders', () => deps.folders())
  ipc.handle('setup:completeWelcome', async () => {
    if (!deps.loadError()) await deps.configuration.saveOptions({ welcomeDone: true })
    deps.configChanged()
    deps.setupWindow('welcome')?.close()
  })
}
