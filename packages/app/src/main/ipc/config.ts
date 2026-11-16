import { resolveEffectiveAgents, type ConfigurationService, type Result, type SecretStore, type WorkhubConfig } from '@workhub/core'
import type { ConfigSnapshot } from '../../shared/api'
import type { IpcRegistrar } from '../ipc-guard'
import { saveAccountEnv, saveProfileEnv, storedAccountEnvNames, storedProfileEnvNames } from '../profile-env'

type Guard = <A extends unknown[]>(fn: (...args: A) => Promise<Result<WorkhubConfig>>) => (e: unknown, ...args: A) => Promise<Result<WorkhubConfig>>

export interface ConfigIpcDeps {
  configuration: ConfigurationService
  secrets: SecretStore
  snapshot: () => Promise<ConfigSnapshot>
  reloadConfig: () => Promise<ConfigSnapshot>
  /** Refuses writes while the config file could not be read. */
  guarded: Guard
  /** Tells every window, and every paired device, that the config changed. */
  configChanged: () => void
  refreshUsage: () => void
  refreshOptionsCache: () => void
}

/** The config file and the secrets kept beside it (`config:*`, `profileEnv:*`, `accountEnv:*`). */
export function registerConfigIpc(ipc: IpcRegistrar, deps: ConfigIpcDeps): void {
  const { configuration, secrets, guarded, configChanged } = deps
  ipc.handle('config:get', () => deps.snapshot())
  ipc.handle('config:reload', () => deps.reloadConfig())
  ipc.handle('config:saveConnection', guarded((c, s) => configuration.saveConnection(c, s)))
  ipc.handle('config:deleteConnection', guarded((id: string) => configuration.deleteConnection(id)))
  ipc.handle('config:saveAccount', guarded((a) => configuration.saveAccount(a)))
  ipc.handle('config:deleteAccount', guarded((id: string) => configuration.deleteAccount(id)))
  ipc.handle(
    'config:saveProfile',
    guarded(async (p) => {
      const r = await configuration.saveProfile(p)
      // A profile saved in the welcome window shows up in the main window too.
      if (r.ok) configChanged()
      return r
    })
  )
  ipc.handle(
    'config:deleteProfile',
    guarded(async (id: string) => {
      const names = (await configuration.current()).profiles.find((p) => p.id === id)?.envNames ?? []
      const r = await configuration.deleteProfile(id)
      if (r.ok && names.length) await saveProfileEnv(id, {}, names, secrets)
      return r
    })
  )
  ipc.handle('config:setActiveProfile', guarded((id: string) => configuration.setActiveProfile(id)))
  ipc.handle('config:effectiveAgents', async (_e, profileId: string | null) =>
    resolveEffectiveAgents(await configuration.current(), profileId)
  )
  ipc.handle(
    'config:saveOptions',
    guarded(async (o) => {
      const r = await configuration.saveOptions(o)
      if (r.ok) {
        deps.refreshUsage()
        deps.refreshOptionsCache()
      }
      return r
    })
  )
  ipc.handle('config:saveSessionGroups', guarded((g) => configuration.saveSessionGroups(g)))
  ipc.handle('profileEnv:stored', async (_e, profileId: string) => {
    const config = await configuration.current()
    return storedProfileEnvNames(config.profiles.find((p) => p.id === profileId), secrets)
  })
  ipc.handle('profileEnv:save', async (_e, profileId: string, values: Record<string, string>, removed: string[]) => {
    if (typeof profileId !== 'string' || !values || typeof values !== 'object' || !Array.isArray(removed)) return
    const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === 'string'))
    await saveProfileEnv(profileId, clean, removed.filter((n) => typeof n === 'string'), secrets)
  })
  ipc.handle('accountEnv:stored', async (_e, accountId: string) => {
    const config = await configuration.current()
    return storedAccountEnvNames(config.accounts.find((a) => a.id === accountId), secrets)
  })
  ipc.handle('accountEnv:save', async (_e, accountId: string, values: Record<string, string>, removed: string[]) => {
    if (typeof accountId !== 'string' || !values || typeof values !== 'object' || !Array.isArray(removed)) return
    const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === 'string'))
    await saveAccountEnv(accountId, clean, removed.filter((n) => typeof n === 'string'), secrets)
  })
}
