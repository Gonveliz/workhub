import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HEALTH_THRESHOLDS, emptySignals, makeSnapshot, type HealthEnvironment, type HealthSnapshot, type MetricAlert, type TrendStats } from '@workhub/core'
import type { HealthEnvironmentView } from '../src/shared/health-api'
import { boardServices, errorBars, favoriteServices, healthFavoriteKey, leadReason, primaryRow, quietBlocks, toggleKey } from '../src/renderer/lib/healthBoard'
import { ErrorBars } from '../src/renderer/screens/health/ErrorBars'
import { activeFilters, historyBand, pinnedAlertKey, sparklinePoints, splitPinned } from '../src/renderer/lib/metricAlerts'
import { parsePrefs } from '../src/renderer/lib/prefs'
import { HealthRowsProvider, type HealthRowActions } from '../src/renderer/screens/health/HealthRows'
import { ServiceBoard, SlowEndpoints } from '../src/renderer/screens/health/ServiceBoard'
import { LatencyRange, ServiceSheetPanel } from '../src/renderer/screens/health/ServiceSheet'
import { AlertCard } from '../src/renderer/screens/health/AlertCard'
import { Sparkline } from '../src/renderer/components/molecules/Sparkline'
import { TooltipProvider } from '../src/renderer/components/atoms'

const env: HealthEnvironment = {
  id: 'prod',
  name: 'Production',
  apmEnvironments: ['production'],
  k8sIndexSuffix: 'prod',
  hasKubeState: true,
  apm: { errors: 'logs-apm.error-*', traces: 'traces-apm-*', metrics: 'metrics-apm.internal-*' },
  kibanaUrl: '',
  thresholds: { ...DEFAULT_HEALTH_THRESHOLDS }
}

const stats = (recent: number, typicalDay: number, state: TrendStats['state']): TrendStats => ({ recent, typicalDay, streakDays: 3, streakTruncated: false, daysWithData: 8, state })

const view = (snapshot: HealthSnapshot): HealthEnvironmentView => ({
  id: env.id,
  name: env.name,
  snapshot,
  kibanaUrl: null,
  serviceUrls: {},
  errorUrls: {},
  podUrls: {},
  slowFlowHours: env.thresholds.slowFlowHours,
  errorWindowHours: env.thresholds.errorWindowHours,
  thresholds: env.thresholds,
  hasKubeState: env.hasKubeState,
  k8sIndexSuffix: env.k8sIndexSuffix
})

const read = (): HealthSnapshot => {
  const s = makeSnapshot(env, { ...emptySignals(), podVisibility: 'visible', fastFetchedAt: 1_000, trendFetchedAt: 1_000, slowFetchedAt: 1_000 })
  return {
    ...s,
    errorServices: [
      { service: 'orders-api', stats: stats(130, 40, 'worsening') },
      { service: 'catalog', stats: stats(6, 5, 'chronic') }
    ],
    silentServices: [{ service: 'notifier', lastSeen: 0, silentMinutes: 12, isReporting: false }],
    slow: [
      { service: 'orders-api', name: 'GET /orders', calls: 100, p50Ms: 100, p95Ms: 800, p99Ms: 900, failureRate: 0 },
      { service: 'orders-api', name: 'POST /orders', calls: 100, p50Ms: 200, p95Ms: 2300, p99Ms: 4000, failureRate: 0.01 },
      { service: 'search', name: 'GET /search', calls: 100, p50Ms: 90, p95Ms: 1400, p99Ms: 2000, failureRate: 0 }
    ],
    pods: [{ pod: 'catalog-7f9c5d-xk2lp', notReady: true, restarts: 3, recentRestarts: 3, backOff: true, kind: 'crashLoop' }]
  }
}

const alert = (over: Partial<MetricAlert> = {}): MetricAlert => ({
  key: 'k',
  kind: 'jump',
  severity: 'medium',
  status: 'new',
  firstSeenDay: '2026-11-18',
  lastSeenDay: '2026-11-19',
  metric: 'health.errors',
  subject: 'orders-api',
  segment: 'Production',
  source: 'health',
  lastValue: 130,
  baseline: 40,
  changePct: 225,
  history: [10, 12, 9, 11, 10, 13, 12, 40].map((value, i) => ({ day: `2026-11-${10 + i}`, value })),
  ...over
})

const actions: HealthRowActions = { profileId: 'work', environmentId: env.id, selecting: false, isSelected: () => false, toggle: () => {}, busyKey: null, investigate: () => {}, folderHelp: () => '' }
const withTips = (el: ReturnType<typeof createElement>) => createElement(TooltipProvider, null, el)
const withRows = (el: ReturnType<typeof createElement>, a: HealthRowActions = actions) => renderToStaticMarkup(withTips(createElement(HealthRowsProvider, { value: a }, el)))

describe('Health board services', () => {
  it('lists every service a signal names plus the favorites, worst first, with their figures', () => {
    const list = boardServices(view(read()), ['billing'], [alert(), alert({ key: 'r', status: 'resolved' }), alert({ key: 's', segment: 'Staging' })])
    expect(list.map((s) => [s.name, s.tone])).toEqual([
      ['orders-api', 'bad'],
      ['catalog', 'bad'],
      ['notifier', 'warn'],
      ['billing', 'ok'],
      ['search', 'ok']
    ])
    const orders = list.find((s) => s.name === 'orders-api')!
    expect(orders.cause).toBe('errors')
    expect(orders.slow.map((tx) => tx.p95Ms)).toEqual([2300, 800])
    // Only the open alert about this service in this environment counts.
    expect(orders.alerts).toBe(1)
    const catalog = list.find((s) => s.name === 'catalog')!
    expect(catalog.cause).toBe('pods')
    expect(catalog.pods).toHaveLength(1)
  })

  it('calls nothing healthy when errors were not read', () => {
    const s = read()
    const list = boardServices(view({ ...s, errorServices: [], blindSpots: [{ code: 'apmOff' }] }), [], [])
    expect(list.find((x) => x.name === 'search')?.tone).toBe('unknown')
  })

  it('investigates errors first, then a silent agent, then the slowest endpoint', () => {
    const list = boardServices(view(read()), [], [])
    expect(primaryRow(list.find((s) => s.name === 'orders-api')!)?.id).toBe('errors:orders-api')
    expect(primaryRow(list.find((s) => s.name === 'notifier')!)?.id).toBe('silent:notifier')
    expect(primaryRow(list.find((s) => s.name === 'search')!)?.id).toBe('flow:search|GET /search')
  })

  it('keeps favorites per profile', () => {
    const keys = toggleKey(toggleKey([], healthFavoriteKey('work', 'orders-api')), healthFavoriteKey('home', 'search'))
    expect(favoriteServices(keys, 'work')).toEqual(['orders-api'])
    expect(favoriteServices(toggleKey(keys, healthFavoriteKey('work', 'orders-api')), 'work')).toEqual([])
  })

  it('draws favorites as large cards first and the rest as small cards', () => {
    const v = view(read())
    const services = boardServices(v, ['orders-api'], [alert()])
    const html = withRows(createElement(ServiceBoard, { env: v, services, favorites: new Set(['orders-api']), onFavorite: () => {}, onlyFavorites: false, errorsRead: true }))
    expect(html.indexOf('data-testid="health-favorites"')).toBeLessThan(html.indexOf('data-testid="health-services"'))
    expect(html).toContain('errors · typical 40')
    expect(html).toContain('1 alert')
    expect(html).toContain('Remove orders-api from favorites')
    expect(html).toContain('Add search to favorites')
    expect(html.match(/data-testid="health-service-card"/g)).toHaveLength(4)
    const only = withRows(createElement(ServiceBoard, { env: v, services, favorites: new Set(['orders-api']), onFavorite: () => {}, onlyFavorites: true, errorsRead: true }))
    expect(only).not.toContain('data-testid="health-services"')
    expect(only.match(/data-testid="health-service-card"/g)).toHaveLength(1)
  })

  it('shows a picked card while selecting', () => {
    const v = view(read())
    const services = boardServices(v, [], [])
    const html = withRows(createElement(ServiceBoard, { env: v, services, favorites: new Set<string>(), onFavorite: () => {}, onlyFavorites: false, errorsRead: true }), { ...actions, selecting: true, isSelected: (id) => id === 'errors:orders-api' })
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
  })

  it('draws the slowest endpoints one per row on a shared latency scale', () => {
    const html = withRows(createElement(SlowEndpoints, { env: view(read()) }))
    expect(html).toContain('See all 3')
    expect(html.match(/data-testid="health-slow-row"/g)).toHaveLength(3)
    expect(html.match(/data-testid="latency-range"/g)).toHaveLength(3)
    expect(html).toContain('p50 200 ms · p95 <b class="font-semibold text-text">2.3 s</b> · p99 4.0 s')
    // The p99 tick of the endpoint with the largest p99 sits at the end of the shared scale.
    expect(html).toContain('left:100%')
    expect(html).toContain('1.0% failed')
  })

  it('charts errors per day: the complete days, then the rolling window', () => {
    expect(errorBars([3, 4, 5, 2], 9)).toEqual([3, 4, 5, 9])
    expect(errorBars(undefined, 0)).toEqual([])
    expect(errorBars(undefined, 7)).toEqual([7])
    const html = renderToStaticMarkup(createElement(ErrorBars, { daily: [3, 4, 5, 2], recent: 9, typicalDay: 4, hours: 24, tone: 'bad', height: 60, label: 'x', showTypical: true }))
    expect(html.match(/<rect/g)).toHaveLength(4)
    expect(html).toContain('fill-danger')
    expect(html).toContain('Last 24 h: 9 errors')
    expect(html).toContain('data-testid="error-bars-typical"')
    expect(html).toContain('typical 4')
    // A service without errors keeps an empty baseline.
    const empty = renderToStaticMarkup(createElement(ErrorBars, { recent: 0, typicalDay: 0, hours: 24, tone: 'ok', height: 28, label: 'x' }))
    expect(empty).toContain('<line')
    expect(empty).not.toContain('<rect')
  })

  it('leads a card with the reason for its color when it is not its errors', () => {
    const list = boardServices(view(read()), [], [])
    expect(leadReason(list.find((s) => s.name === 'catalog')!)).toMatchObject({ kind: 'pod' })
    expect(leadReason(list.find((s) => s.name === 'notifier')!)).toEqual({ kind: 'silent', minutes: 12 })
    expect(leadReason(list.find((s) => s.name === 'orders-api')!)).toBeNull()
    const v = view(read())
    const html = withRows(createElement(ServiceBoard, { env: v, services: list, favorites: new Set(['catalog']), onFavorite: () => {}, onlyFavorites: false, errorsRead: true }))
    expect(html).toContain('Crash-looping')
  })

  it('folds the quiet environment blocks into one line', () => {
    const s = read()
    expect(quietBlocks({ ...s, pods: [], events: [], silentServices: [], reportingServiceCount: 4 })).toEqual(['health.board.quiet.pods', 'health.board.quiet.events', 'health.board.quiet.reporting'])
    expect(quietBlocks({ ...s, podVisibility: 'missing', pods: [], events: [], silentServices: [], reportingServiceCount: 0 })).toEqual(['health.board.quiet.events'])
  })
})

describe('Service sheet', () => {
  const sheet = (over: Partial<Parameters<typeof ServiceSheetPanel>[0]> = {}) => {
    const v = view(read())
    const service = boardServices(v, [], [])[0]!
    return withRows(createElement(ServiceSheetPanel, { env: v, service, errorsRead: true, favorite: false, onFavorite: () => {}, onClose: () => {}, top: 46, width: 520, ...over }))
  }

  it('opens at the right at the remembered width, with a handle to drag and a button to widen it', () => {
    const html = sheet()
    expect(html).toContain('data-testid="health-service-sheet"')
    expect(html).toContain('width:520px')
    expect(html).toContain('top:46px')
    expect(html).toContain('aria-label="Resize the details"')
    expect(html).toContain('aria-label="Widen the details"')
    expect(html).toContain('aria-label="Close details"')
  })

  it('offers to shrink once it is as wide as it goes', () => {
    const html = sheet({ width: 900 })
    expect(html).toContain('width:900px')
    expect(html).toContain('aria-label="Back to the usual width"')
  })

  it('keeps a remembered width inside its limits', () => {
    expect(parsePrefs(JSON.stringify({ healthDetailWidth: 5000 })).healthDetailWidth).toBe(900)
    expect(parsePrefs(JSON.stringify({ healthDetailWidth: 10 })).healthDetailWidth).toBe(380)
    expect(parsePrefs('{}').healthDetailWidth).toBe(520)
  })

  it('shows the service once, its errors per day, and its blocks in order', () => {
    const html = sheet({ favorite: true })
    expect(html).toContain('aria-pressed="true"')
    expect(html.indexOf('data-testid="health-sheet-chart"')).toBeGreaterThan(html.indexOf('<header'))
    expect(html.indexOf('data-testid="health-sheet-infra"')).toBeGreaterThan(html.indexOf('data-testid="health-sheet-chart"'))
    expect(html).toContain('Errors per day')
    expect(html.split('aria-label="Investigate with Claude"').length - 1).toBe(1)
    expect(html).not.toContain('Investigate with Claude</button>')
    expect(sheet({ width: 700 })).toContain('Investigate with Claude</button>')
  })
})

describe('Latency range', () => {
  it('places p50, p95 and p99 on the scale it is given', () => {
    const tx = { service: 'orders-api', name: 'POST /orders', calls: 10, p50Ms: 100, p95Ms: 500, p99Ms: 1000, failureRate: 0 }
    const html = renderToStaticMarkup(createElement(LatencyRange, { tx, max: 1000 }))
    expect(html).toContain('left:10%')
    expect(html).toContain('left:100%')
    expect(html).toContain('aria-label="p50 100 ms, p95 500 ms, p99 1.0 s"')
  })
})

describe('Alert cards', () => {
  it('bands the values before the last and splits the pinned ones by severity', () => {
    expect(historyBand(alert().history)).toEqual([9, 13])
    expect(historyBand([{ value: 1 }, { value: 2 }])).toBeNull()
    const list = [alert({ key: 'a', severity: 'low' }), alert({ key: 'b', severity: 'high' }), alert({ key: 'c', severity: 'medium' })]
    const { pinned, rest } = splitPinned(list, (a) => a.key !== 'c')
    expect(pinned.map((a) => a.key)).toEqual(['b', 'a'])
    expect(rest.map((a) => a.key)).toEqual(['c'])
    expect(pinnedAlertKey('work', 'k')).not.toBe(pinnedAlertKey('home', 'k'))
    expect(activeFilters({ status: 'open', severity: 'all', kind: 'jump' })).toEqual(['status', 'kind'])
  })

  it('scales a line to a given domain', () => {
    expect(sparklinePoints([5, 5], 10, 10, 0, [0, 10])).toBe('0,5 10,5')
    expect(renderToStaticMarkup(createElement(Sparkline, { values: [1, 2, 3], label: 'x', band: [1, 2] }))).toContain('data-testid="sparkline-band"')
  })

  it('shows the change, the values, one Resolve and the rest in its menu', () => {
    const card = (large: boolean, over: Partial<MetricAlert> = {}) =>
      renderToStaticMarkup(withTips(createElement(AlertCard, { alert: alert(over), profileId: 'work', large, pinned: large, onPin: () => {}, busy: false, act: () => {}, inbox: true, sendToInbox: () => {} })))
    const small = card(false)
    expect(small).toContain('+225%')
    expect(small).toContain('130 vs 40')
    expect(small).toContain('Resolve')
    expect(small).not.toContain('To the inbox')
    expect(small).toContain('data-testid="metric-alert-menu"')
    expect(small).toContain('Pin ')
    const large = card(true)
    expect(large).toContain('To the inbox')
    expect(large).toContain('Unpin ')
    const resolved = card(false, { status: 'resolved' })
    expect(resolved).toContain('Reopen')
    expect(resolved).not.toContain('>Resolve<')
  })
})

describe('Health preferences', () => {
  it('reads favorites, pins and the alerts layout', () => {
    const p = parsePrefs(JSON.stringify({ favoriteHealthServices: ['a', 'a', 1, ''], pinnedMetricAlerts: ['k'], healthFavoritesOnly: true, alertsPinnedOnly: 'yes', alertsLayout: 'list' }))
    expect(p.favoriteHealthServices).toEqual(['a'])
    expect(p.pinnedMetricAlerts).toEqual(['k'])
    expect(p.healthFavoritesOnly).toBe(true)
    expect(p.alertsPinnedOnly).toBe(false)
    expect(p.alertsLayout).toBe('list')
    expect(parsePrefs(JSON.stringify({ alertsLayout: 'grid' })).alertsLayout).toBe('cards')
    expect(parsePrefs(null).favoriteHealthServices).toEqual([])
  })
})
