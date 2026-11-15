/**
 * The Flow maps bridge: the stored maps (import, delete, alerts), the map window and what only the
 * main process can do for it (the clipboard, forwarding "Ask Claude" to the main window).
 */
import type { BrowserWindow } from 'electron'
import type { FlowMapImportResult, FlowMapSetAlertsResult } from '../shared/flow-maps-api'
import { deleteFlowMap, importFlowMapFiles, readFlowMapFiles, setFlowMapAlerts, type FlowMapRows } from './flow-maps'
import type { IpcRegistrar } from './ipc-guard'

export interface FlowMapsIpcDeps {
  maps: FlowMapRows
  /** Asks for JSON files; empty when cancelled. */
  pickFiles(): Promise<string[]>
  createWindow(hash: string, title: string): BrowserWindow
  mainWindow(): BrowserWindow | null
  /** Puts a PNG data URL on the clipboard; false when it is not an image. */
  writeImage(dataUrl: string): Promise<boolean>
}

/** The hash a map window is opened with; `parseFlowMapHash` in the renderer reads it back. */
export function flowMapWindowHash(profileId: string | null, environmentId: string, mapId: string): string {
  const q = new URLSearchParams({ profile: profileId ?? '', env: environmentId, id: mapId })
  return `#flow-map?${q.toString()}`
}

export function registerFlowMapsIpc(ipc: IpcRegistrar, deps: FlowMapsIpcDeps): void {
  const windows = new Map<string, BrowserWindow>()
  ipc.handle('flowMaps:import', async (): Promise<FlowMapImportResult[]> => importFlowMapFiles(deps.maps, await deps.pickFiles()))
  ipc.handle('flowMaps:remove', (_e, id: unknown) => (typeof id === 'string' ? deleteFlowMap(deps.maps, id) : false))
  ipc.handle('flowMaps:get', (_e, mapId: unknown) => (typeof mapId === 'string' ? (readFlowMapFiles(deps.maps).find((f) => f.map?.id === mapId)?.map ?? null) : null))
  ipc.handle('flowMaps:setAlerts', (_e, _profileId: unknown, mapId: unknown, alerts: unknown): FlowMapSetAlertsResult => {
    if (typeof mapId !== 'string') return { ok: false, errors: ['id: not a map id'] }
    if (alerts !== null && (typeof alerts !== 'object' || Array.isArray(alerts))) return { ok: false, errors: ['alerts: expected an object or null'] }
    // setFlowMapAlerts validates the whole map with the map schema before anything is written.
    return setFlowMapAlerts(deps.maps, mapId, alerts as Parameters<typeof setFlowMapAlerts>[2])
  })
  ipc.handle('flowMaps:copyImage', (_e, dataUrl: unknown) => (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,') && dataUrl.length < 50_000_000 ? deps.writeImage(dataUrl) : false))
  ipc.on('flowMaps:openWindow', (_e, profileId: unknown, environmentId: unknown, mapId: unknown) => {
    if (typeof environmentId !== 'string' || typeof mapId !== 'string') return
    const profile = typeof profileId === 'string' ? profileId : null
    const key = `${profile ?? ''}|${environmentId}|${mapId}`
    const open = windows.get(key)
    if (open && !open.isDestroyed()) {
      if (open.isMinimized()) open.restore()
      open.focus()
      return
    }
    const w = deps.createWindow(flowMapWindowHash(profile, environmentId, mapId), 'Flow map')
    windows.set(key, w)
    w.on('closed', () => windows.delete(key))
  })
  ipc.on('flowMaps:ask', (_e, draft: unknown, folder: unknown) => {
    if (typeof draft !== 'string' || !draft.trim()) return
    const main = deps.mainWindow()
    if (!main || main.isDestroyed()) return
    if (main.isMinimized()) main.restore()
    main.focus()
    main.webContents.send('flowMaps:askInMain', draft, typeof folder === 'string' && folder ? folder : undefined)
  })
}
