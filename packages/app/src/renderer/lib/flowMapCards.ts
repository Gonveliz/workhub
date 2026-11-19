import { breaches, flowColumns, flowEntry, flowMeasures, flowThresholds, rankFlowDeviations, type FlowMap, type FlowMapReading, type FlowNode, type FlowPartDeviation, type FlowPartRef, type FlowTiming } from '@workhub/core'
import type { FlowMapSummary } from '@shared/health-api'

/** What a map's card says about the flow as a whole: the numbers of its entry and its p95 hour by hour. */
export interface FlowMapDigest {
  calls: number
  p95Ms: number
  /** Share of failed calls, when the provider reads outcomes. */
  errorRate?: number
  /** The entry's p95 per hour in milliseconds, oldest first (0 for an hour without calls). */
  hourly: number[]
}

/** The node that starts the flow: the file's `entry` when a node measures it, else the leftmost node measured as a transaction. */
export function flowEntryNode(map: FlowMap): FlowNode | undefined {
  const entry = flowEntry(map)
  const columns = flowColumns(map)
  const measured = map.nodes.filter((n) => n.measure?.type === 'apm.transaction').sort((a, b) => (columns[a.id] ?? 0) - (columns[b.id] ?? 0))
  return measured.find((n) => n.measure?.type === 'apm.transaction' && entry && n.measure.service === entry.service && n.measure.transaction === entry.transaction) ?? measured[0]
}

/** The numbers of the node that starts the flow, when it had calls in the window. */
export function flowEntryTiming(map: FlowMap, reading: FlowMapReading | undefined): FlowTiming | undefined {
  const start = flowEntryNode(map)
  const timing = start && reading ? reading.nodes[start.id] : undefined
  return timing && timing.count > 0 ? timing : undefined
}

/**
 * The flow's own numbers: those of the node that starts it (the file's `entry` when a node measures
 * it, else the leftmost node measured as a transaction). Null without a reading or without calls.
 */
export function flowMapDigest(map: FlowMap, reading: FlowMapReading | undefined): FlowMapDigest | null {
  const timing = flowEntryTiming(map, reading)
  if (!timing) return null
  return { calls: timing.count, p95Ms: timing.p95Ms, ...(timing.errorRate !== undefined ? { errorRate: timing.errorRate } : {}), hourly: timing.hourly.map((h) => (h.count > 0 ? h.p95Ms : 0)) }
}

/** The deviations worth naming: slower than 1.2 times the 7-day usual, or failing two points more. */
export function notableDeviations(map: FlowMap, reading: FlowMapReading): FlowPartDeviation[] {
  return rankFlowDeviations(map, reading, 'weekly').filter((d) => d.ratio > 1.2 || d.errorDelta > 0.02)
}

/** How a part stands: fine, off its own seven-day usual, or over one of its limits. */
export type FlowTone = 'ok' | 'warn' | 'bad'

/** How a flow or a part stands, and the word for it: failing, over a limit, slower than usual, or normal. */
export interface FlowStanding {
  tone: FlowTone
  label: 'errors' | 'overLimit' | 'slow' | 'normal'
}

/** Why a part stands as it does, with the numbers that say so (shares between 0 and 1, times in milliseconds). */
export type FlowPartReason =
  | { kind: 'overErrors'; value: number; limit: number }
  | { kind: 'overP95'; value: number; limit: number }
  | { kind: 'overSlowShare'; value: number; limit: number; overMs: number }
  | { kind: 'moreErrors'; value: number; usual: number }
  | { kind: 'slower'; value: number; usual: number; ratio: number }
  | { kind: 'fine' }

export interface FlowPartStanding extends FlowStanding {
  reason: FlowPartReason
}

/**
 * How one part stands over the reading's window and why: over its failure limit, over another of
 * its limits, failing two points more than its seven-day usual, over 1.2 times slower than it, or
 * fine. Null for a part without calls, so nothing unmeasured is called fine.
 */
export function flowPartStanding(map: FlowMap, reading: FlowMapReading | undefined, part: FlowPartRef): FlowPartStanding | null {
  const timing = reading?.[part.of][part.key]
  if (!timing || timing.count === 0) return null
  const hits = breaches(timing, flowThresholds(map, part))
  const errors = hits.find((h) => h.kind === 'flowErrors')
  if (errors) return { tone: 'bad', label: 'errors', reason: { kind: 'overErrors', value: errors.value, limit: errors.threshold } }
  const slow = hits.find((h) => h.kind === 'flowSlow')
  if (slow) return { tone: 'bad', label: 'overLimit', reason: { kind: 'overP95', value: slow.value, limit: slow.threshold } }
  const share = hits.find((h) => h.kind === 'flowSlowShare')
  if (share) return { tone: 'bad', label: 'overLimit', reason: { kind: 'overSlowShare', value: share.value, limit: share.threshold, overMs: share.overMs ?? 0 } }
  const usual = timing.weekly
  if (usual && usual.count > 0) {
    if (timing.errorRate !== undefined && usual.errorRate !== undefined && timing.errorRate - usual.errorRate > 0.02) return { tone: 'warn', label: 'errors', reason: { kind: 'moreErrors', value: timing.errorRate, usual: usual.errorRate } }
    if (usual.p95Ms > 0 && timing.p95Ms / usual.p95Ms > 1.2) return { tone: 'warn', label: 'slow', reason: { kind: 'slower', value: timing.p95Ms, usual: usual.p95Ms, ratio: timing.p95Ms / usual.p95Ms } }
  }
  return { tone: 'ok', label: 'normal', reason: { kind: 'fine' } }
}

/** Every measured part with calls and how it stands, keyed `<of>:<key>` (`nodes:orders`). */
export function flowPartTones(map: FlowMap, reading: FlowMapReading | undefined): Map<string, FlowTone> {
  const out = new Map<string, FlowTone>()
  for (const m of flowMeasures(map)) {
    const standing = flowPartStanding(map, reading, m)
    if (standing) out.set(`${m.of}:${m.key}`, standing.tone)
  }
  return out
}

/**
 * The worst of the flow's parts over the reading's window: a part over its failure limit, a part
 * over another limit, a part failing more than its usual, a part slower than its usual, or none.
 * Null without numbers, so nothing is called normal that was never measured.
 */
export function flowMapStanding(map: FlowMap, reading: FlowMapReading | undefined): FlowStanding | null {
  if (!reading) return null
  const hits = flowMeasures(map).flatMap((m) => {
    const timing = reading[m.of][m.key]
    return timing ? breaches(timing, flowThresholds(map, m)) : []
  })
  if (hits.some((h) => h.kind === 'flowErrors')) return { tone: 'bad', label: 'errors' }
  if (hits.length > 0) return { tone: 'bad', label: 'overLimit' }
  const off = notableDeviations(map, reading)
  if (off.some((d) => d.errorDelta > 0.02)) return { tone: 'warn', label: 'errors' }
  if (off.length > 0) return { tone: 'warn', label: 'slow' }
  return flowMeasures(map).some((m) => (reading[m.of][m.key]?.count ?? 0) > 0) ? { tone: 'ok', label: 'normal' } : null
}

/** Stars or unstars a map: a starred id is removed, a new one goes last. */
export function toggleFlowFavorite(favorites: readonly string[], id: string): string[] {
  return favorites.includes(id) ? favorites.filter((f) => f !== id) : [...favorites, id]
}

/** The starred maps (by name) apart from the rest; an id that names no listed map is ignored. */
export function splitFlowFavorites<T extends Pick<FlowMapSummary, 'id' | 'name'>>(maps: readonly T[], favorites: readonly string[]): { starred: T[]; rest: T[] } {
  const ids = new Set(favorites)
  return { starred: maps.filter((m) => ids.has(m.id)).sort((a, b) => a.name.localeCompare(b.name)), rest: maps.filter((m) => !ids.has(m.id)) }
}
