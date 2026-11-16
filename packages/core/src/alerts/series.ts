import { addDays, isDay, localDay } from './days'
import type { MetricCoverage, MetricCoverageScope, MetricSample, MetricSeries, MetricSeriesStore } from './types'

/** Days of history kept per series. */
export const SERIES_RETENTION_DAYS = 45

export function seriesKey(s: Pick<MetricSample, 'source' | 'metric' | 'subject' | 'segment'>): string {
  return `${s.source}|${s.metric}|${s.subject}|${s.segment ?? ''}`
}

const validSample = (s: MetricSample, today: string): boolean =>
  typeof s.metric === 'string' && s.metric.length > 0 && typeof s.subject === 'string' && s.subject.length > 0 && typeof s.source === 'string' && s.source.length > 0 && isDay(s.day) && s.day <= today && Number.isFinite(s.value) && s.value >= 0

/**
 * Merges samples into the per-key daily series: the last sample of a day wins, days older than
 * `SERIES_RETENTION_DAYS` are dropped, and so are series left with no day. Bad samples (no key,
 * a malformed or future day, a negative or non-finite value) are ignored. Returns a new store.
 */
export function mergeSamples(store: MetricSeriesStore, samples: readonly MetricSample[], now: number): MetricSeriesStore {
  const today = localDay(now)
  const cutoff = addDays(today, -(SERIES_RETENTION_DAYS - 1))
  const next: MetricSeriesStore = { ...store }
  const touched = new Set<string>()
  for (const s of samples) {
    if (!validSample(s, today) || s.day < cutoff) continue
    const key = seriesKey(s)
    const current: MetricSeries = touched.has(key) ? next[key]! : next[key] ? { ...next[key]!, points: [...next[key]!.points] } : { key, source: s.source, metric: s.metric, subject: s.subject, ...(s.segment ? { segment: s.segment } : {}), points: [] }
    touched.add(key)
    const point = { day: s.day, value: s.value, ...(s.base !== undefined && Number.isFinite(s.base) ? { base: s.base } : {}) }
    const at = current.points.findIndex((p) => p.day === s.day)
    if (at >= 0) current.points[at] = point
    else current.points.push(point)
    current.lastSampleAt = Math.max(current.lastSampleAt ?? 0, s.at ?? now)
    if (s.link) current.link = s.link
    next[key] = current
  }
  for (const [key, series] of Object.entries(next)) {
    const points = series.points.filter((p) => p.day >= cutoff).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    if (points.length === 0) delete next[key]
    else if (touched.has(key) || points.length !== series.points.length) next[key] = { ...series, points }
  }
  return next
}

export function coverageKey(s: Pick<MetricCoverageScope, 'source' | 'metric' | 'segment'>): string {
  return `${s.source}|${s.metric ?? ''}|${s.segment ?? ''}`
}

/** A source that does not say what it read: each day it has a sample counts as read for the whole source. */
export function coverageOfSamples(samples: readonly MetricSample[]): MetricCoverageScope[] {
  return samples.map((s) => ({ source: s.source, day: s.day }))
}

/**
 * Adds the days read to the coverage. Days older than `SERIES_RETENTION_DAYS`, malformed or future
 * days are dropped, and so are scopes left with no day. Returns a new coverage.
 */
export function mergeCoverage(coverage: MetricCoverage, scopes: readonly MetricCoverageScope[], now: number): MetricCoverage {
  const today = localDay(now)
  const cutoff = addDays(today, -(SERIES_RETENTION_DAYS - 1))
  const days = new Map<string, Set<string>>(Object.entries(coverage).map(([k, v]) => [k, new Set(v)]))
  for (const s of scopes) {
    if (typeof s.source !== 'string' || s.source.length === 0 || !isDay(s.day) || s.day > today) continue
    const key = coverageKey(s)
    const set = days.get(key) ?? new Set<string>()
    set.add(s.day)
    days.set(key, set)
  }
  const next: MetricCoverage = {}
  for (const [key, set] of days) {
    const kept = [...set].filter((d) => isDay(d) && d >= cutoff && d <= today).sort()
    if (kept.length > 0) next[key] = kept
  }
  return next
}

/**
 * The coverage of a store saved before coverage was recorded: a day on which any series of a
 * source has a point counts as read for that source; the other days stay unknown.
 */
export function coverageFromSeries(store: MetricSeriesStore): MetricCoverage {
  const days = new Map<string, Set<string>>()
  for (const s of Object.values(store)) {
    const key = coverageKey({ source: s.source })
    const set = days.get(key) ?? new Set<string>()
    for (const p of s.points) set.add(p.day)
    days.set(key, set)
  }
  const out: MetricCoverage = {}
  for (const [key, set] of days) if (set.size > 0) out[key] = [...set].sort()
  return out
}

/** The days on which a series' source was read for it (any scope that includes the series). */
export function coveredDays(coverage: MetricCoverage, series: Pick<MetricSeries, 'source' | 'metric' | 'segment'>): Set<string> {
  const keys = [
    coverageKey({ source: series.source }),
    coverageKey({ source: series.source, metric: series.metric }),
    coverageKey({ source: series.source, segment: series.segment }),
    coverageKey({ source: series.source, metric: series.metric, segment: series.segment })
  ]
  const out = new Set<string>()
  for (const k of new Set(keys)) for (const d of coverage[k] ?? []) out.add(d)
  return out
}
