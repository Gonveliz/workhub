import { BrowserWindow } from 'electron'
import type { AgentEvent } from '@workhub/core'
import type { ChatJournals } from './chat-journal'
import { broadcastToWindowsAndDevices } from './remote'
import type { RemoteHub } from './remote'
import type { SessionWindows } from './session-windows'
import type { SettingsWindow } from './settings-window'
import type { SessionEventTargets } from './terminal-routing'

/** What session and sub-agent windows follow too: the sessions' live state and what their screens show. */
const SHARED_CHANNELS = new Set(['session:event', 'session:changed', 'session:removed', 'session:replay', 'automations:prompted', 'automations:turnEnded', 'aiReview:changed', 'agentReview:changed', 'usage:changed', 'sessionRequests:changed'])

export interface BroadcastDeps {
  /** Every session's chat, so a window that loads later rebuilds it; chat messages go out numbered. */
  journal: ChatJournals
  /** The main window while it exists. */
  main: () => BrowserWindow | null
  sessionWindows: () => SessionWindows
  settingsWindow: () => SettingsWindow
  hub: Pick<RemoteHub, 'tap'>
}

export type Broadcast = ReturnType<typeof createBroadcast>

/** Every way the main process sends an event to the windows and paired devices. */
export function createBroadcast(deps: BroadcastDeps) {
  const { journal, hub } = deps
  /** An event for the main window, the Settings window, paired devices and, for shared channels, session windows. */
  const send = (channel: string, ...message: unknown[]) => {
    const args = journal.tap(channel, message)
    const win = deps.main()
    if (win) win.webContents.send(channel, ...args)
    if (SHARED_CHANNELS.has(channel)) deps.sessionWindows().broadcastShared(channel, args)
    deps.settingsWindow().send(channel, args)
    hub.tap(channel, args)
  }
  /** Every window (pull request, ticket and review windows too), and every paired device. */
  const toWindowsAndDevices = (channel: string, ...args: unknown[]) => broadcastToWindowsAndDevices(BrowserWindow.getAllWindows(), hub, channel, ...args)
  /** Every window, never a paired device: channels the phone does not follow. */
  const toWindows = (channel: string, ...args: unknown[]) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, ...args))
  /** Where `session:event` goes; terminal output only to the windows that can show it (see terminal-routing.ts). */
  const sessionEvents: SessionEventTargets = {
    everywhere: (ev: AgentEvent) => send('session:event', ev),
    main: (ev) => deps.main()?.webContents.send('session:event', ev),
    sessionWindow: (id, ev) => deps.sessionWindows().sendToSession(id, 'session:event', [ev]),
    devices: (ev) => hub.tap('session:event', [ev])
  }
  return { send, toWindowsAndDevices, toWindows, sessionEvents }
}
