import { app, Notification, shell } from 'electron'
import type { SessionNotification } from '../../shared/api'
import type { IpcRegistrar } from '../ipc-guard'
import type { NotificationPermissionCheck } from '../notification-permission'
import { testNotification } from '../notification-test'

export interface NotificationsIpcDeps {
  showSessionNotification: (n: SessionNotification) => void
  notificationPermission: Pick<NotificationPermissionCheck, 'allowed' | 'observe'>
  showMain: () => void
}

/** Notifications the renderer words, and the system's notification permission (`notifications:*`, `systemNotifications:*`). */
export function registerNotificationsIpc(ipc: IpcRegistrar, deps: NotificationsIpcDeps): void {
  const { notificationPermission } = deps
  ipc.on('notifications:show', (_e, n: SessionNotification) => deps.showSessionNotification(n))
  ipc.handle('systemNotifications:status', async () => ({ supported: await notificationPermission.allowed() }))
  ipc.handle('systemNotifications:test', (_e, body: unknown) => {
    if (!Notification.isSupported()) return { outcome: 'failed', error: 'notifications are not supported here' }
    return testNotification(() => notificationPermission.observe(new Notification({ title: app.getName(), body: String(typeof body === 'string' ? body : '').slice(0, 200) })), deps.showMain)
  })
  ipc.on('systemNotifications:openSettings', () => {
    const target =
      process.platform === 'darwin' ? 'x-apple.systempreferences:com.apple.Notifications-Settings.extension' : process.platform === 'win32' ? 'ms-settings:notifications' : null
    if (target) void shell.openExternal(target)
  })
}
