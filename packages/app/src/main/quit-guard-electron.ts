import { app, BrowserWindow, dialog, powerMonitor } from 'electron'
import type { TrayText } from '@workhub/core'
import { QuitGuard, type BusyCounts, type BusyView, type QuitChoice, type QuitIntent } from './quit-guard'

export interface QuitGuardWiring {
  views: () => readonly BusyView[]
  queuedPrompts: () => number
  /** The tray's words (the renderer's dictionaries, in the language the window reports). */
  text: () => TrayText
  publish: (pending: QuitIntent | null) => void
  showMain: () => void
}

/** The dialog's lines naming what is in progress. */
export function busyLines(counts: BusyCounts, tn: TrayText['tn']): string[] {
  return [
    ...(counts.working ? [tn('quit.working', counts.working)] : []),
    ...(counts.queued ? [tn('quit.queued', counts.queued)] : []),
    ...(counts.permissions ? [tn('quit.permissions', counts.permissions)] : [])
  ]
}

/** The quit guard on Electron: the native dialog, and the signals that mean the system is shutting down. */
export function createQuitGuard(wiring: QuitGuardWiring): QuitGuard {
  const guard = new QuitGuard({
    views: wiring.views,
    queuedPrompts: wiring.queuedPrompts,
    publish: wiring.publish,
    cancelled: () => {
      // A quit that came from closing the last window leaves the app without one: bring it back.
      if (BrowserWindow.getAllWindows().every((w) => w.isDestroyed() || !w.isVisible())) wiring.showMain()
    },
    confirm: async (counts, intent): Promise<QuitChoice> => {
      const { t, tn } = wiring.text()
      const restart = intent === 'restart'
      const options = {
        type: 'warning' as const,
        title: t('quit.title'),
        message: t('quit.title'),
        detail: `${busyLines(counts, tn).join('\n')}\n\n${t(restart ? 'quit.detailRestart' : 'quit.detail')}`,
        buttons: [t(restart ? 'quit.restartAnyway' : 'quit.anyway'), t(restart ? 'quit.restartWhenIdle' : 'quit.whenIdle'), t('quit.cancel')],
        defaultId: 1,
        cancelId: 2,
        noLink: true
      }
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible())
      const { response } = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))
      return response === 0 ? 'now' : response === 1 ? 'whenIdle' : 'cancel'
    }
  })
  return guard
}

/** Hooks the system's shutdown signals; after `ready`. A shutdown never waits for a session or asks. */
export function watchSystemShutdown(guard: QuitGuard): void {
  // macOS and Linux: the system is about to restart or power off.
  powerMonitor.on('shutdown', () => guard.systemShutdown())
  // Windows: the user session is ending (log off, shutdown).
  app.on('browser-window-created', (_event, created) => created.on('session-end', () => guard.systemShutdown()))
}
