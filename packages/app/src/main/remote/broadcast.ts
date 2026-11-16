// An event for every window of the desktop and every paired device. Sending to the windows alone
// is the mistake this exists to prevent: a channel in the remote allowlist then never reaches a phone.
import type { RemoteHub } from './dispatcher'

interface WindowLike {
  isDestroyed(): boolean
  webContents: { send(channel: string, ...args: unknown[]): void }
}

export function broadcastToWindowsAndDevices(windows: readonly WindowLike[], hub: Pick<RemoteHub, 'tap'>, channel: string, ...args: unknown[]): void {
  for (const w of windows) if (!w.isDestroyed()) w.webContents.send(channel, ...args)
  hub.tap(channel, args)
}
