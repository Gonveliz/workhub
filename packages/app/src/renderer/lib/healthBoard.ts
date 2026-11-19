import { flowKey, itemId, workloadName, type HealthItemId, type MetricAlert, type HealthSnapshot, type PodIssue, type ServiceErrorCount, type ServiceReporting, type SlowTransaction } from '@workhub/core'
import type { HealthEnvironmentView } from '@shared/health-api'
import type { Tone } from '../components/atoms'
import type { MessageKey } from '../i18n/translate'
import type { HealthRow } from './healthInvestigate'

/**
 * The Environments board of the Health screen: one card per service the environment's signals
 * name (errors, silent agents, slow endpoints, pods that need attention), plus the services the
 * user starred. Everything on a card comes from the snapshot already read; nothing is estimated.
 */

/** How a service stands: `bad` new or worsening errors or broken pods, `warn` ongoing errors, a silent agent or restarts, `unknown` errors were not read. */
export type ServiceTone = 'ok' | 'warn' | 'bad' | 'unknown'

export interface BoardService {
  name: string
  /** Its errors in the window; undefined when the service had none (or errors were not read). */
  errors?: ServiceErrorCount
  /** Its APM agent stopped reporting. */
  silent?: ServiceReporting
  /** Its slow endpoints, slowest p95 first. */
  slow: SlowTransaction[]
  /** Its pods that need attention, matched by workload name. */
  pods: PodIssue[]
  /** Open metric alerts about it in this environment. */
  alerts: number
  tone: ServiceTone
  /** Why the tone is `bad`: errors, or pods. */
  cause?: 'errors' | 'pods'
}

export const SERVICE_TONE: Record<ServiceTone, Tone> = { ok: 'success', warn: 'warning', bad: 'danger', unknown: 'neutral' }
/** The text color of a service's figures. */
export const SERVICE_TEXT: Record<ServiceTone, string> = { ok: 'text-success', warn: 'text-warning', bad: 'text-danger', unknown: 'text-muted' }

export function serviceLabel(s: Pick<BoardService, 'tone' | 'cause'>): MessageKey {
  if (s.tone === 'bad') return s.cause === 'pods' ? 'health.board.state.pods' : 'health.board.state.bad'
  return s.tone === 'warn' ? 'health.board.state.warn' : s.tone === 'unknown' ? 'health.board.state.unknown' : 'health.board.state.ok'
}

/** A starred service: per profile, the same name in every environment. */
export const healthFavoriteKey = (profileId: string, service: string): string => `${profileId}\u0000${service}`

/** The starred services of a profile, from the stored keys. */
export function favoriteServices(keys: readonly string[], profileId: string): string[] {
  const prefix = `${profileId}\u0000`
  return keys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
}

/** Adds the key when missing, removes it when there. */
export function toggleKey(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]
}

const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Whether the environment's errors were read at all: without them no service is called healthy. */
export function errorsRead(env: HealthEnvironmentView): boolean {
  const s = env.snapshot
  return s.state !== 'unreachable' && !s.blindSpots.some((b) => b.code === 'apmOff' || b.code === 'errorsOff' || b.code === 'notReadYet' || (b.code === 'unread' && b.signal === 'errors'))
}

const TONE_ORDER: Record<ServiceTone, number> = { bad: 0, warn: 1, unknown: 2, ok: 3 }

/**
 * The services of an environment for the board, worst first, then the most errors, then by name.
 * `favorites` are listed even when no signal names them today; `alerts` are the profile's metric
 * alerts, counted per service when open and about this environment.
 */
export function boardServices(env: HealthEnvironmentView, favorites: readonly string[], alerts: readonly MetricAlert[]): BoardService[] {
  const s = env.snapshot
  const names = new Set<string>([...s.errorServices.map((e) => e.service), ...s.silentServices.map((x) => x.service), ...s.slow.map((tx) => tx.service), ...favorites])
  const read = errorsRead(env)
  const out = [...names].map((name): BoardService => {
    const errors = s.errorServices.find((e) => e.service === name)
    const silent = s.silentServices.find((x) => x.service === name)
    const slow = s.slow.filter((tx) => tx.service === name).sort((a, b) => b.p95Ms - a.p95Ms)
    const pods = s.pods.filter((p) => fold(workloadName(p.pod)) === fold(name))
    const open = alerts.filter((a) => a.status !== 'resolved' && a.source === 'health' && a.subject === name && a.segment === env.name).length
    const errorsBad = errors?.stats.state === 'new' || errors?.stats.state === 'worsening'
    const podsBad = pods.some((p) => p.kind !== 'restarting')
    const tone: ServiceTone = errorsBad || podsBad ? 'bad' : silent || pods.length > 0 || errors?.stats.state === 'ongoing' ? 'warn' : read ? 'ok' : 'unknown'
    return { name, errors, silent, slow, pods, alerts: open, tone, ...(tone === 'bad' ? { cause: errorsBad ? 'errors' : 'pods' } : {}) }
  })
  return out.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || (b.errors?.stats.recent ?? 0) - (a.errors?.stats.recent ?? 0) || a.name.localeCompare(b.name))
}

/** The row a card investigates and selects: its errors, else its silent agent, else its slowest endpoint. Null when there is nothing to look at. */
export function primaryRow(s: BoardService): { id: HealthItemId; row: HealthRow } | null {
  if (s.errors) return { id: itemId('errors', s.name), row: { kind: 'errors', entry: s.errors } }
  if (s.silent) return { id: itemId('silent', s.name), row: { kind: 'silent', service: s.silent } }
  const tx = s.slow[0]
  if (tx) return { id: itemId('flow', flowKey(tx)), row: { kind: 'flow', tx } }
  return null
}

/**
 * The bars of a service's errors chart: the complete days of its daily series, then the rolling
 * window's count in place of today's partial day. No series and no errors: no bars (a baseline).
 */
export function errorBars(daily: readonly number[] | undefined, recent: number): number[] {
  if (!daily || daily.length === 0) return recent > 0 ? [recent] : []
  return [...daily.slice(0, -1), recent]
}

/**
 * What explains a service's color when its errors do not: its worst pod, or its silent agent.
 * Null when the errors are the reason (or nothing is wrong).
 */
export function leadReason(s: Pick<BoardService, 'tone' | 'cause' | 'pods' | 'silent' | 'errors'>): { kind: 'pod'; pod: PodIssue } | { kind: 'silent'; minutes: number } | null {
  const worstPod = [...s.pods].sort((a, b) => POD_ORDER[a.kind] - POD_ORDER[b.kind])[0]
  if (s.tone === 'bad' && s.cause === 'pods' && worstPod) return { kind: 'pod', pod: worstPod }
  if (s.tone === 'warn' && s.errors?.stats.state !== 'ongoing') {
    if (s.silent) return { kind: 'silent', minutes: s.silent.silentMinutes }
    if (worstPod) return { kind: 'pod', pod: worstPod }
  }
  return null
}

const POD_ORDER: Record<PodIssue['kind'], number> = { crashLoop: 0, notReady: 1, restarting: 2 }

/**
 * The environment blocks that were read and have nothing to show, as the phrases of the muted line
 * under the verdict: pods (visible, none needs attention), Kubernetes warnings (none) and APM
 * agents (read, none silent). A block that could not be read is not called quiet.
 */
export function quietBlocks(s: Pick<HealthSnapshot, 'podVisibility' | 'pods' | 'events' | 'silentServices' | 'reportingServiceCount' | 'blindSpots'>): MessageKey[] {
  const unread = (signal: string) => s.blindSpots.some((b) => b.code === 'unread' && b.signal === signal)
  const out: MessageKey[] = []
  if (s.podVisibility === 'visible' && s.pods.length === 0 && !unread('pods')) out.push('health.board.quiet.pods')
  if (s.events.length === 0 && !unread('events')) out.push('health.board.quiet.events')
  if (s.reportingServiceCount > 0 && s.silentServices.length === 0 && !unread('reporting')) out.push('health.board.quiet.reporting')
  return out
}
