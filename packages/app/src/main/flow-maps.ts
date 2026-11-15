/**
 * The flow maps: one row per map in the data folder's database (`flow_maps`), written from
 * Settings → Flow maps (import) or by an agent (the `workhub-flow-map` skill posts them to the
 * control endpoint). They are read on every ask, so a saved map shows up on the next refresh.
 */
import { readFileSync } from 'node:fs'
import { parseFlowMap, setJsonField, type FlowMap, type FlowMapAlerts } from '@workhub/core'
import type { FlowMapSummary } from '../shared/health-api'
import type { FlowMapImportResult } from '../shared/flow-maps-api'

/** Where the maps are kept: `SqliteFlowMaps` in the app, any in-memory table in tests. */
export interface FlowMapRows {
  list(): { id: string; json: string }[]
  get(id: string): string | null
  put(id: string, json: string): void
  remove(id: string): boolean
}

export interface FlowMapFile {
  /** The map's name as a file (`<id>.json`): what the lists and the Claude draft show. */
  file: string
  map?: FlowMap
  error?: string
}

const fileOf = (id: string): string => `${id}.json`

/** Every stored map, parsed; a bad one is listed with its error so the screen can say so. */
export function readFlowMapFiles(rows: FlowMapRows): FlowMapFile[] {
  let all: { id: string; json: string }[]
  try {
    all = rows.list()
  } catch {
    return []
  }
  return all.map(({ id, json }) => {
    const file = fileOf(id)
    try {
      const parsed = parseFlowMap(JSON.parse(json))
      return parsed.ok ? { file, map: parsed.map } : { file, error: parsed.errors.slice(0, 5).join('; ') }
    } catch (e) {
      return { file, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

export function flowMapSummaries(files: FlowMapFile[]): FlowMapSummary[] {
  return files.map((f) =>
    f.map
      ? { id: f.map.id, name: f.map.name, file: f.file, ...(f.map.description ? { description: f.map.description } : {}), ...(f.map.group ? { group: f.map.group } : {}), ...(f.map.environmentId ? { environmentId: f.map.environmentId } : {}), nodes: f.map.nodes.length, edges: f.map.edges.length }
      : { id: f.file.split(/[\\/]/).pop()!.replace(/\.json$/, ''), name: f.file.split(/[\\/]/).pop()!, file: f.file, nodes: 0, edges: 0, error: f.error ?? 'unreadable' }
  )
}

export type SaveFlowMapResult = { ok: true; file: string; id: string } | { ok: false; errors: string[] }

/** The `alerts` stored with a map as they are in its JSON, or undefined (no map, no field, not JSON). */
function storedAlerts(rows: FlowMapRows, id: string): unknown {
  try {
    const text = rows.get(id)
    if (text === null) return undefined
    const raw = JSON.parse(text) as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>)['alerts'] : undefined
  } catch {
    return undefined
  }
}

/**
 * Validates and stores a map under its id; an existing map with the id is replaced. `keepAlerts`
 * (the control endpoint): a posted map without `alerts` keeps the limits the stored map has, so an
 * agent that redraws a map does not drop the limits set in Settings → Alerts.
 */
export function saveFlowMap(rows: FlowMapRows, input: unknown, options: { keepAlerts?: boolean } = {}): SaveFlowMapResult {
  let candidate = input
  if (options.keepAlerts && input && typeof input === 'object' && !Array.isArray(input) && !('alerts' in input)) {
    const id = (input as Record<string, unknown>)['id']
    const kept = typeof id === 'string' && SAFE_ID.test(id) && !id.includes('..') ? storedAlerts(rows, id) : undefined
    if (kept !== undefined) candidate = { ...input, alerts: kept }
  }
  let parsed = parseFlowMap(candidate)
  // Limits that no longer fit the redrawn map (a part removed) are dropped rather than refusing the map.
  if (!parsed.ok && candidate !== input) parsed = parseFlowMap(input)
  if (!parsed.ok) return parsed
  rows.put(parsed.map.id, JSON.stringify(parsed.map, null, 2) + '\n')
  return { ok: true, file: fileOf(parsed.map.id), id: parsed.map.id }
}

/**
 * Writes a map's `alerts` (null removes them). The new map is validated like any map (a part that
 * does not exist or has no measure is refused), and the rest of the stored JSON stays as it was.
 */
export function setFlowMapAlerts(rows: FlowMapRows, mapId: string, alerts: FlowMapAlerts | null): SaveFlowMapResult {
  if (typeof mapId !== 'string' || !SAFE_ID.test(mapId) || mapId.includes('..')) return { ok: false, errors: ['id: not a map id'] }
  const text = rows.get(mapId)
  if (text === null) return { ok: false, errors: ['This flow map no longer exists'] }
  let raw: Record<string, unknown>
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, errors: ['(root): not a JSON object'] }
    raw = parsed as Record<string, unknown>
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)] }
  }
  const next: Record<string, unknown> = { ...raw }
  if (alerts === null) delete next['alerts']
  else next['alerts'] = alerts
  const parsed = parseFlowMap(next)
  if (!parsed.ok) return parsed
  // What is written is what was validated (unknown keys stripped, defaults filled), so the row never holds what the app would not read.
  const value = alerts === null ? undefined : parsed.map.alerts
  let out: string
  try {
    out = setJsonField(text, 'alerts', value)
    if (JSON.stringify(JSON.parse(out)['alerts']) !== JSON.stringify(value)) throw new Error('mismatch')
  } catch {
    out = JSON.stringify(value === undefined ? (({ alerts: _drop, ...rest }) => rest)(raw) : { ...raw, alerts: value }, null, 2) + '\n'
  }
  rows.put(mapId, out)
  return { ok: true, file: fileOf(parsed.map.id), id: parsed.map.id }
}

const SAFE_ID = /^[a-z0-9][a-z0-9-_.]*$/i

/**
 * Deletes a map by id; false when there is no such map. Any stored id can be deleted (an invalid
 * map imported from a file name keeps that name); a path-like id never matches a row.
 */
export function deleteFlowMap(rows: FlowMapRows, id: string): boolean {
  if (typeof id !== 'string' || !id || /[\\/]/.test(id) || id.includes('..')) return false
  try {
    return rows.get(id) !== null && rows.remove(id)
  } catch {
    return false
  }
}

/** Reads each file as a map and stores the valid ones; a file that does not parse is reported, the rest still import. */
export function importFlowMapFiles(rows: FlowMapRows, files: readonly string[]): FlowMapImportResult[] {
  return files.map((file): FlowMapImportResult => {
    let input: unknown
    try {
      input = JSON.parse(readFileSync(file, 'utf8'))
    } catch (e) {
      return { file, ok: false, errors: [e instanceof Error ? e.message : String(e)] }
    }
    const r = saveFlowMap(rows, input)
    return r.ok ? { file, ok: true, id: r.id } : { file, ok: false, errors: r.errors }
  })
}
