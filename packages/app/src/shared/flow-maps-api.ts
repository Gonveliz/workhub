import type { FlowMap, FlowMapAlerts } from '@workhub/core'

// Types of the Flow maps bridge (window.hub.flowMaps): the stored maps and the map window.
/**
 * One map read on import: `file` is the path picked; a file of several maps (an export) gives one
 * result per map, with its `name`. `replaced`: a map with that id was there and was overwritten.
 */
export type FlowMapImportResult = { file: string; name?: string; ok: true; id: string; replaced?: boolean } | { file: string; name?: string; ok: false; errors: string[] }

/** What an export wrote: the file and how many maps, or why nothing was written. */
export type FlowMapExportResult = { ok: true; file: string; count: number } | { ok: false; reason: 'canceled' | 'empty' | 'failed'; detail?: string }

/** The answer to `setAlerts`: the map written (`file` is `<id>.json`), or the problems that kept it from being written. */
export type FlowMapSetAlertsResult = { ok: true; file: string; id: string } | { ok: false; errors: string[] }

export interface FlowMapsApi {
  /** Asks for JSON files, validates each and stores the good ones under their id; one result per file picked. */
  importFiles(): Promise<FlowMapImportResult[]>
  /** Imports files dropped in the window, already read (`name` is shown in the results); same rules as `importFiles`. */
  importTexts(items: { name: string; text: string }[]): Promise<FlowMapImportResult[]>
  /** One stored map as it was validated (defaults filled); null when there is none with that id or it is invalid. */
  get(mapId: string): Promise<FlowMap | null>
  /**
   * Writes a map's limits (`alerts`; null removes them) into the stored map (Settings → Alerts). The
   * map is validated first, and the rest of its JSON is kept byte for byte. Maps are shared by every
   * profile; `profileId` says who asked.
   */
  setAlerts(profileId: string | null, mapId: string, alerts: FlowMapAlerts | null): Promise<FlowMapSetAlertsResult>
  /**
   * Saves maps to a JSON file the user picks: one id writes that map as it is stored (the import
   * format), several or none (every valid map) write one file with all of them, which import reads too.
   */
  exportMaps(ids?: string[]): Promise<FlowMapExportResult>
  /** Deletes a map by id. */
  remove(id: string): Promise<boolean>
  /** Opens a map in a window of its own. */
  openWindow(profileId: string | null, environmentId: string, mapId: string): void
  /** Puts a PNG (a data URL) on the clipboard. */
  copyImage(dataUrl: string): Promise<boolean>
  /** From a map window: asks the main window to draft a Claude session with this text (see `onAsk`). */
  ask(draft: string, folder?: string): void
  /** Main window only: a map window asked for a session. */
  onAsk(cb: (draft: string, folder: string | undefined) => void): () => void
}
