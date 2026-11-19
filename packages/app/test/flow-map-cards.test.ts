import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { flowCoverage, parseFlowMap, rankFlowParts, type FlowMap, type FlowMapReading } from '@workhub/core'
import { flowMapDigest, flowMapStanding, flowPartStanding, flowPartTones, splitFlowFavorites, toggleFlowFavorite } from '../src/renderer/lib/flowMapCards'
import { parsePrefs } from '../src/renderer/lib/prefs'
import { FlowMapList } from '../src/renderer/screens/flowMaps/FlowMapList'
import { FlowMiniMap } from '../src/renderer/screens/flowMaps/FlowMiniMap'
import { PartsTab } from '../src/renderer/screens/flowMaps/FlowMapView'
import { FlowSummaryTiles, PartDetail, StandingLegend } from '../src/renderer/screens/flowMaps/FlowSplitParts'

const map = (parseFlowMap(JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'docs', 'examples', 'flow-maps', 'checkout.json'), 'utf8'))) as { ok: true; map: FlowMap }).map
const noop = () => {}
const hours = [
  { at: 0, count: 10, p50Ms: 100, p95Ms: 300 },
  { at: 3_600_000, count: 0, p50Ms: 0, p95Ms: 0 },
  { at: 7_200_000, count: 20, p50Ms: 200, p95Ms: 900 }
]
const reading: FlowMapReading = {
  at: 1,
  windowHours: 24,
  nodes: { bff: { count: 30, p50Ms: 150, p95Ms: 800, errorRate: 0.025, hourly: hours }, orders: { count: 28, p50Ms: 90, p95Ms: 400, hourly: hours } },
  edges: {},
  stages: {},
  errors: {}
}

describe('the numbers of a map card', () => {
  it('are those of the node that starts the flow, with its p95 hour by hour', () => {
    expect(flowMapDigest(map, reading)).toEqual({ calls: 30, p95Ms: 800, errorRate: 0.025, hourly: [300, 0, 900] })
  })

  it('leaves the failure share out when the provider reads no outcomes', () => {
    const plain: FlowMapReading = { ...reading, nodes: { bff: { count: 30, p50Ms: 150, p95Ms: 800, hourly: hours } } }
    expect(flowMapDigest(map, plain)).toEqual({ calls: 30, p95Ms: 800, hourly: [300, 0, 900] })
  })

  it('are missing without a reading, and when the entry had no calls', () => {
    expect(flowMapDigest(map, undefined)).toBeNull()
    expect(flowMapDigest(map, { ...reading, nodes: {} })).toBeNull()
    expect(flowMapDigest(map, { ...reading, nodes: { bff: { count: 0, p50Ms: 0, p95Ms: 0, hourly: [] } } })).toBeNull()
  })
})

describe('starred maps', () => {
  const maps = [
    { id: 'refunds', name: 'Refunds' },
    { id: 'checkout', name: 'Checkout' },
    { id: 'signup', name: 'Signup' }
  ]

  it('stars a map last and unstars a starred one', () => {
    expect(toggleFlowFavorite(['checkout'], 'refunds')).toEqual(['checkout', 'refunds'])
    expect(toggleFlowFavorite(['checkout', 'refunds'], 'checkout')).toEqual(['refunds'])
  })

  it('lists the starred maps by name apart from the rest, ignoring ids that name no map', () => {
    const { starred, rest } = splitFlowFavorites(maps, ['refunds', 'gone', 'checkout'])
    expect(starred.map((m) => m.id)).toEqual(['checkout', 'refunds'])
    expect(rest.map((m) => m.id)).toEqual(['signup'])
  })

  it('are remembered as a short list of ids', () => {
    expect(parsePrefs(JSON.stringify({ favoriteFlowMaps: ['checkout', 'checkout', 3, ''] })).favoriteFlowMaps).toEqual(['checkout'])
    expect(parsePrefs(null).favoriteFlowMaps).toEqual([])
  })

  it('remember that only the starred maps were being shown', () => {
    expect(parsePrefs(JSON.stringify({ flowMapsFavoritesOnly: true })).flowMapsFavoritesOnly).toBe(true)
    expect(parsePrefs(JSON.stringify({ flowMapsFavoritesOnly: 'yes' })).flowMapsFavoritesOnly).toBe(false)
    expect(parsePrefs(null).flowMapsFavoritesOnly).toBe(false)
  })
})

describe('the map cards', () => {
  const maps = [
    { id: 'checkout', name: 'Checkout', group: 'Payments', file: 'checkout.json', nodes: 6, edges: 6 },
    { id: 'refunds', name: 'Refunds', group: 'Payments', file: 'refunds.json', nodes: 3, edges: 2 },
    { id: 'signup', name: 'Signup', group: 'Growth', file: 'signup.json', nodes: 4, edges: 3 }
  ]
  const list = (props: Partial<Parameters<typeof FlowMapList>[0]> = {}) =>
    renderToStaticMarkup(createElement(FlowMapList, { maps, states: { checkout: 'alert', refunds: 'ok' }, opened: 'checkout', query: '', onQuery: noop, onOpen: noop, ...props }))

  it('lists the starred maps first under Favorites and leaves them out of their heading', () => {
    const html = list({ favorites: ['refunds'], onFavorite: noop })
    expect(html.indexOf('Favorites')).toBeLessThan(html.indexOf('Growth'))
    expect((html.match(/>Refunds</g) ?? []).length).toBe(1)
    expect((html.match(/data-testid="flow-map-star"/g) ?? []).length).toBe(3)
    expect(html).toContain('aria-label="Remove Refunds from Favorites"')
    expect(html).toContain('aria-label="Add Checkout to Favorites"')
  })

  it('has no Favorites heading while nothing is starred, and no star when starring is not offered', () => {
    expect(list({ onFavorite: noop })).not.toContain('flow-map-favorites')
    expect(list()).not.toContain('flow-map-star')
  })

  it('draws the flow and its numbers on the card once they are in', () => {
    const html = list({ details: { checkout: { map, digest: flowMapDigest(map, reading), over: new Set(['nodes:payments']), standing: { tone: 'warn', label: 'slow' } }, refunds: { map, digest: null } } })
    expect((html.match(/data-testid="flow-mini-map"/g) ?? []).length).toBe(2)
    expect(html).toContain('800 ms')
    expect(html).toContain('2.5 %')
    expect(html).toContain('aria-label="p95 of Checkout hour by hour, last stored day"')
    expect(html).toContain('No stored numbers yet')
    // The card says how the flow stands as a word once it has numbers; a map without them keeps its dot.
    expect((html.match(/data-testid="flow-standing"/g) ?? []).length).toBe(1)
    expect(html).toContain('>Slow<')
    // Signup has nothing yet: its name and state only.
    expect((html.match(/data-testid="flow-map-numbers"/g) ?? []).length).toBe(1)
  })

  it('lists only the starred maps when asked, and says so when there are none', () => {
    const only = list({ favorites: ['refunds'], onFavorite: noop, onlyFavorites: true })
    expect(only).toContain('>Refunds<')
    expect(only).not.toContain('>Checkout<')
    expect(list({ onFavorite: noop, onlyFavorites: true })).toContain('flow-map-no-favorites')
  })

  it('keeps a starred map in Favorites while searching, and hides the ones that do not match', () => {
    const html = list({ favorites: ['refunds', 'checkout'], onFavorite: noop, query: 'refu' })
    expect(html).toContain('>Refunds<')
    expect(html).not.toContain('>Checkout<')
    expect(html).not.toContain('Growth')
  })
})

describe('the small picture of a map', () => {
  it('draws every node and hop, a part over its limits in red', () => {
    const html = renderToStaticMarkup(createElement(FlowMiniMap, { map, over: new Set(['nodes:payments']) }))
    expect((html.match(/<rect /g) ?? []).length).toBe(map.nodes.length)
    expect((html.match(/<path /g) ?? []).length).toBe(map.edges.length)
    expect((html.match(/data-over=""/g) ?? []).length).toBe(1)
    expect(html).toContain('aria-hidden="true"')
  })
})

describe('how a flow stands', () => {
  const weekly = { count: 200, p50Ms: 100, p95Ms: 300 }
  const usual: FlowMapReading = { ...reading, nodes: { bff: { count: 30, p50Ms: 150, p95Ms: 320, errorRate: 0.01, hourly: hours, weekly: { ...weekly, errorRate: 0.01 } } } }
  // The example file sets limits; a copy without them shows what the seven-day usual alone says.
  const { alerts: _alerts, ...free } = map

  it('is normal when every part is close to its seven-day usual, and nothing without numbers', () => {
    expect(flowMapStanding(free, usual)).toEqual({ tone: 'ok', label: 'normal' })
    expect(flowMapStanding(map, undefined)).toBeNull()
    expect(flowMapStanding(map, { ...reading, nodes: {} })).toBeNull()
  })

  it('is slow when a part runs over 1.2 times its usual, and failing when it fails two points more', () => {
    const slow: FlowMapReading = { ...usual, nodes: { bff: { ...usual.nodes['bff']!, p95Ms: 900 } } }
    expect(flowMapStanding(free, slow)).toEqual({ tone: 'warn', label: 'slow' })
    expect(flowPartTones(free, slow).get('nodes:bff')).toBe('warn')
    const failing: FlowMapReading = { ...usual, nodes: { bff: { ...usual.nodes['bff']!, errorRate: 0.08 } } }
    expect(flowMapStanding(free, failing)).toEqual({ tone: 'warn', label: 'errors' })
  })

  it('is over the limit when a part breaks one of the map\'s limits', () => {
    const limited: FlowMap = { ...map, alerts: { ...map.alerts!, p95Ms: 500, errorRate: 0.05, minCalls: 1, parts: {} } }
    const slow: FlowMapReading = { ...usual, nodes: { bff: { ...usual.nodes['bff']!, p95Ms: 900 } } }
    expect(flowMapStanding(limited, slow)).toEqual({ tone: 'bad', label: 'overLimit' })
    expect(flowPartTones(limited, slow).get('nodes:bff')).toBe('bad')
    const failing: FlowMapReading = { ...usual, nodes: { bff: { ...usual.nodes['bff']!, errorRate: 0.2, failed: 6 } } }
    expect(flowMapStanding(limited, failing)).toEqual({ tone: 'bad', label: 'errors' })
  })
})

describe('the flow\'s own numbers as tiles', () => {
  it('shows the entry\'s p95 against its usual, its calls, its failure share and the slowest part', () => {
    const r: FlowMapReading = { ...reading, nodes: { ...reading.nodes, bff: { ...reading.nodes['bff']!, perMinute: 2.4, weekly: { count: 200, p50Ms: 100, p95Ms: 400 } } } }
    const html = renderToStaticMarkup(createElement(FlowSummaryTiles, { map, reading: r, ranks: rankFlowParts(map, r), standing: flowMapStanding(map, r), onPick: noop }))
    expect(html).toContain('Flow p95')
    expect(html).toContain('800 ms')
    expect(html).toContain('×2.0 against 7 d')
    expect(html).toContain('2.4 per minute')
    expect(html).toContain('2.5 %')
    expect(html).toContain('limit 5.0 %')
    expect(html).toContain('Slowest part')
    expect(html).toContain('shop-bff')
  })
})

describe('how one part stands, and why', () => {
  const weekly = { count: 400, p50Ms: 600, p95Ms: 1700, errorRate: 0.012 }
  const hop = { count: 300, p50Ms: 650, p95Ms: 1700, errorRate: 0.04, failed: 12, hourly: hours, weekly }
  const { alerts: _alerts, ...free } = map
  const at = (timing: typeof hop): FlowMapReading => ({ ...reading, nodes: { ...reading.nodes, orders: timing } })
  const part = { of: 'nodes' as const, key: 'orders' }

  it('says a part fails more than usual, not that it is slow, when only its failures grew', () => {
    expect(flowPartStanding(free, at(hop), part)).toEqual({ tone: 'warn', label: 'errors', reason: { kind: 'moreErrors', value: 0.04, usual: 0.012 } })
  })

  it('says a part is slower than usual with both numbers and the ratio', () => {
    const s = flowPartStanding(free, at({ ...hop, errorRate: 0.012, p95Ms: 2550 }), part)
    expect(s).toMatchObject({ tone: 'warn', label: 'slow', reason: { kind: 'slower', value: 2550, usual: 1700 } })
    expect(s?.reason.kind === 'slower' && s.reason.ratio).toBeCloseTo(1.5)
  })

  it('names the limit a part breaks, the failure limit first', () => {
    // The example file limits orders to a p95 of 1500 ms and every part to 5 % of failures.
    expect(flowPartStanding(map, at({ ...hop, errorRate: 0.012 }), part)).toEqual({ tone: 'bad', label: 'overLimit', reason: { kind: 'overP95', value: 1700, limit: 1500 } })
    expect(flowPartStanding(map, at({ ...hop, errorRate: 0.2, failed: 60 }), part)).toMatchObject({ tone: 'bad', label: 'errors', reason: { kind: 'overErrors', limit: 0.05 } })
  })

  it('is fine close to its usual, and nothing without calls', () => {
    expect(flowPartStanding(free, at({ ...hop, errorRate: 0.012 }), part)).toEqual({ tone: 'ok', label: 'normal', reason: { kind: 'fine' } })
    expect(flowPartStanding(free, reading, { of: 'nodes', key: 'acquirer' })).toBeNull()
    expect(flowPartStanding(free, undefined, part)).toBeNull()
  })
})

describe('what a row of the parts table opens', () => {
  const weekly = { count: 400, p50Ms: 600, p95Ms: 1700, errorRate: 0.012 }
  const rich: FlowMapReading = { ...reading, nodes: { ...reading.nodes, orders: { count: 300, p50Ms: 650, p95Ms: 1700, p99Ms: 2200, errorRate: 0.04, failed: 12, perMinute: 1.5, hourly: hours, weekly, codes: [{ code: 'HTTP 2xx', count: 288 }, { code: 'HTTP 5xx', count: 12 }] } } }
  const { alerts: _alerts, ...free } = map
  const detail = (props: Partial<Parameters<typeof PartDetail>[0]> = {}) => renderToStaticMarkup(createElement(PartDetail, { map: free, reading: rich, trace: null, part: { of: 'nodes', key: 'orders' }, onInvestigate: noop, ...props }))

  it('says in a sentence how the part stands and why, with the numbers it compares', () => {
    const html = detail()
    expect(html).toContain('>Errors<')
    expect(html).not.toContain('>Slow<')
    expect(html).toContain('Failing more than usual: 4.0 % of its calls fail now, against 1.2 % over the last seven days.')
  })

  it('draws the hours as a chart, how the calls ended and the limits, without repeating the row\'s numbers', () => {
    const html = detail({ onExecutions: noop })
    for (const id of ['flow-part-chart', 'flow-part-codes', 'flow-part-limits', 'flow-chart-usual']) expect(html).toContain(`data-testid="${id}"`)
    expect(html).toContain('p95 per hour')
    expect(html).toContain('Calls per hour')
    expect(html).toContain('its seven-day usual, 1.7 s')
    // What the table's row leaves out is said here.
    expect(html).toContain('p99 2.2 s · 1.5 per minute')
    expect(html).toContain('HTTP 5xx')
    expect(html).toContain('Investigate')
    expect(html).toContain('Executions')
    // The name and the numbers are the row's: the detail carries neither.
    expect(html).not.toContain('orders')
    expect(html).not.toContain('650 ms')
    // No limit on this copy of the map: the chart draws none and the footer says so.
    expect(html).not.toContain('flow-chart-limit')
    expect(html).toContain('none set')
  })

  it('marks the p95 limit on the chart and the limit that is broken', () => {
    const html = detail({ map })
    expect(html).toContain('data-testid="flow-chart-limit"')
    expect(html).toContain('Over its p95 limit: 1.7 s, and the limit is 1.5 s.')
    expect(html).toContain('>Over limit<')
  })

  it('says why a part has no numbers, with no chart', () => {
    const html = detail({ part: { of: 'nodes', key: 'acquirer' } })
    expect(html).toContain('This part has no measure')
    expect(html).not.toContain('flow-part-chart')
    expect(html).not.toContain('flow-part-limits')
  })
})

describe('the parts table as the place for coverage and limits', () => {
  const table = (props: Partial<Parameters<typeof PartsTab>[0]> = {}) =>
    renderToStaticMarkup(createElement(PartsTab, { map, reading, ranks: rankFlowParts(map, reading), coverage: flowCoverage(map, reading), picked: null, onPick: noop, tones: flowPartTones(map, reading), detail: () => 'detail', ...props }))

  it('offers the filters with how many parts each one keeps, and the map\'s limits with a way to adjust them', () => {
    const html = table({ onAdjust: noop })
    const filters = html.slice(html.indexOf('data-testid="flow-parts-filters"'), html.indexOf('data-testid="flow-parts"'))
    for (const label of ['All', 'With problems', 'Over a limit', 'Not measured', 'No data']) expect(filters).toContain(label)
    expect((filters.match(/aria-pressed="true"/g) ?? []).length).toBe(1)
    // The example file limits every part to a p95 of 3 s and 5 % of failures.
    expect(html).toContain('Map limits: p95 ≤ 3.0 s · failures ≤ 5 %')
    expect(html).toContain('>adjust<')
  })

  it('says a map has no limits, with a way to set them', () => {
    const { alerts: _alerts, ...free } = map
    const html = table({ map: free, tones: flowPartTones(free, reading), onAdjust: noop })
    expect(html).toContain('This map has no limits')
    expect(html).toContain('>set them<')
  })

  it('shows each part\'s limits in its row, the broken one in red, and leaves p99, calls per minute and the previous window to the opened row', () => {
    const slow: FlowMapReading = { ...reading, nodes: { ...reading.nodes, orders: { ...reading.nodes['orders']!, p95Ms: 1700 } } }
    const html = table({ reading: slow, ranks: rankFlowParts(map, slow), coverage: flowCoverage(map, slow), tones: flowPartTones(map, slow) })
    expect(html).toContain('Limits (p95 · failures)')
    expect(html).toContain('≤ 1.5 s · ≤ 5 % · exceeded')
    expect(html).toContain('≤ 3.0 s · ≤ 5 %')
    for (const gone of ['>p99<', '>/min<', '>vs prev<']) expect(html).not.toContain(gone)
    // Without rows that open (the map's own window) the table keeps every column and has no filters.
    const classic = table({ detail: undefined })
    for (const kept of ['>p99<', '>/min<', '>vs prev<']) expect(classic).toContain(kept)
    expect(classic).not.toContain('flow-parts-filters')
    expect(classic).not.toContain('Limits (p95')
  })
})

describe('the key to the diagram', () => {
  it('draws the marks next to what they mean, in three short groups', () => {
    const html = renderToStaticMarkup(createElement(StandingLegend))
    for (const text of ['How a part stands', 'What a node shows', 'The arrows', 'Over one of its limits', 'The label is the hop&#x27;s p50']) expect(html).toContain(text)
    expect((html.match(/<section/g) ?? []).length).toBe(3)
  })

  it('stacks in one column inside a popover', () => {
    expect(renderToStaticMarkup(createElement(StandingLegend, { compact: true }))).not.toContain('md:grid-cols-3')
    expect(renderToStaticMarkup(createElement(StandingLegend))).toContain('md:grid-cols-3')
  })
})

describe('the parts table', () => {
  const table = (props: Partial<Parameters<typeof PartsTab>[0]> = {}) =>
    renderToStaticMarkup(createElement(PartsTab, { map, reading, ranks: rankFlowParts(map, reading), coverage: flowCoverage(map, reading), picked: null, onPick: noop, ...props }))

  it('folds the parts nobody measures into one row, and unfolds them when one is picked', () => {
    const html = table()
    expect(html).toContain('data-testid="flow-parts-unmeasured"')
    expect(html).toMatch(/\d+ parts without a measure · show/)
    expect(html).not.toContain('>Acquirer<')
    expect(table({ picked: { of: 'nodes', key: 'acquirer' } })).toContain('Hide the parts without a measure')
  })

  it('opens the picked row and shows its detail under it, only when a detail is given', () => {
    const html = table({ picked: { of: 'nodes', key: 'bff' }, detail: (part) => `detail of ${part.key}` })
    expect(html).toContain('data-testid="flow-part-open"')
    expect(html).toContain('detail of bff')
    expect((html.match(/aria-expanded="true"/g) ?? []).length).toBe(1)
    expect(html.indexOf('detail of bff')).toBeGreaterThan(html.indexOf('shop-bff'))
    // Without a detail the rows only pick (the map's own window keeps its drawer).
    const plain = table({ picked: { of: 'nodes', key: 'bff' } })
    expect(plain).not.toContain('flow-part-open')
    expect(plain).not.toContain('aria-expanded="true"')
    // Nothing picked: nothing open.
    expect(table({ detail: () => 'x' })).not.toContain('flow-part-open')
  })

  it('draws each part\'s share of the flow\'s time as a bar and lets every numeric column sort', () => {
    const html = table({ tones: flowPartTones(map, reading) })
    expect(html).toMatch(/style="width:\d+%"/)
    expect((html.match(/<th[^>]*><button/g) ?? []).length).toBe(9)
    expect(html).toContain('aria-sort="descending"')
  })
})
