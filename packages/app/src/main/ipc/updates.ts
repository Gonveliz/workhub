import type { IpcRegistrar } from '../ipc-guard'
import type { QuitGuard } from '../quit-guard'
import type { UpdatePromptState } from '../update-prompt'
import type { UpdateService } from '../updates'

export interface UpdatesIpcDeps {
  updates: UpdateService
  quitGuard: Pick<QuitGuard, 'request' | 'pending' | 'cancelPending'>
  saveUpdatePrompt: (patch: UpdatePromptState) => void
}

/** App updates and the quit that may wait for busy sessions (`updates:*`, `quit:*`). */
export function registerUpdatesIpc(ipc: IpcRegistrar, deps: UpdatesIpcDeps): void {
  const { updates, quitGuard } = deps
  ipc.handle('updates:status', () => updates.status())
  ipc.handle('updates:check', () => updates.check())
  ipc.handle('updates:install', () => updates.install())
  ipc.handle('updates:restart', () => quitGuard.request('restart', () => updates.restart()))
  ipc.handle('quit:pending', () => quitGuard.pending)
  ipc.handle('quit:cancelPending', () => quitGuard.cancelPending())
  ipc.handle('updates:skip', (_e, version: unknown) => {
    if (typeof version === 'string' && version) deps.saveUpdatePrompt({ skippedVersion: version })
  })
}
