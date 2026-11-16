import { isManagedToolId, type InstallPlanEntry, type ManagedFailure, type ManagedToolId } from '@workhub/core'
import type { IpcRegistrar } from './ipc-guard'
import type { InstallResult } from './setup-install'
import type { InstallQueueSnapshot, ManagedToolView } from '../shared/setup-api'

export interface SetupInstallIpcDeps {
  /** Installs from the installer table; the renderer only names the installer. */
  install: (installer: unknown) => Promise<InstallResult>
  /** What the installs of these ids download, from where and how large, in the order they run. */
  plan?: (ids: unknown[]) => Promise<InstallPlanEntry[]>
  /** Starts "Install what is missing" (the plan's ids); false while one runs. */
  installMany?: (ids: unknown[]) => Promise<boolean>
  /** Runs one failed or canceled line again; false while one runs. */
  retry?: (id: unknown) => boolean
  cancel?: () => void
  state?: () => InstallQueueSnapshot
  /** The tools folder: what is in it, and removing one. */
  tools?: {
    folder: () => string
    list: () => Promise<ManagedToolView[]>
    remove: (id: ManagedToolId) => Promise<{ ok: true } | { ok: false; reason: ManagedFailure; detail: string }>
  }
}

const idList = (value: unknown): unknown[] => (Array.isArray(value) ? value.slice(0, 20) : [])

export function registerSetupInstallIpc(ipc: IpcRegistrar, deps: SetupInstallIpcDeps): void {
  ipc.handle('setup:install', (_e, installer: unknown) => deps.install(installer))
  if (deps.plan) {
    const plan = deps.plan
    ipc.handle('setup:installPlan', (_e, ids: unknown) => plan(idList(ids)))
  }
  if (deps.installMany && deps.state) {
    const { installMany, state } = deps
    // Resolves once started, with the first state: progress comes as `setup:installProgress` events.
    ipc.handle('setup:installMany', async (_e, ids: unknown) => {
      await installMany(idList(ids))
      return state()
    })
    ipc.handle('setup:installState', () => state())
  }
  if (deps.retry && deps.state) {
    const { retry, state } = deps
    ipc.handle('setup:retryInstall', (_e, id: unknown) => (retry(id), state()))
  }
  if (deps.cancel) {
    const cancel = deps.cancel
    ipc.on('setup:cancelInstalls', () => cancel())
  }
  if (deps.tools) {
    const tools = deps.tools
    ipc.handle('tools:list', async () => ({ folder: tools.folder(), tools: await tools.list() }))
    ipc.handle('tools:remove', (_e, id: unknown) => (isManagedToolId(id) ? tools.remove(id) : Promise.resolve({ ok: false as const, reason: 'failed' as const, detail: 'Unknown tool.' })))
  }
}
