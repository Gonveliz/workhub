import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { parseFlowMap, type FlowMap, type FlowTrace, type FlowTraceLog, type FlowTraceSummary } from '@workhub/core'
import { TooltipProvider } from '../src/renderer/components/atoms'
import { axisTicks, ExecutionList, TraceDetail } from '../src/renderer/screens/flowMaps/TracesPanel'

const map = (parseFlowMap(JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'docs', 'examples', 'flow-maps', 'checkout.json'), 'utf8'))) as { ok: true; map: FlowMap }).map
const noop = () => {}
const at = Date.UTC(2026, 0, 5, 12, 0, 0)

describe('the executions as rows', () => {
  const traces: FlowTraceSummary[] = [
    { traceId: 'a1', at, durationMs: 900, outcome: 'success' },
    { traceId: 'b2', at: at - 60_000, durationMs: 1800, outcome: 'failure' },
    { traceId: 'c3', at: at - 120_000, durationMs: 1600, outcome: 'success' }
  ]
  const list = (props: Partial<Parameters<typeof ExecutionList>[0]> = {}) => renderToStaticMarkup(createElement(ExecutionList, { traces, selectedId: null, onSelect: noop, detail: () => 'the detail', ...props }))

  it('draws each duration as a bar against the slowest, red when it failed and amber past the flow\'s p95', () => {
    const html = list({ usualMs: 1400 })
    expect((html.match(/data-testid="flow-execution-mark"/g) ?? []).length).toBe(3)
    expect(html).toContain('width:50%')
    expect(html).toContain('width:100%')
    expect((html.match(/bg-danger/g) ?? []).length).toBeGreaterThanOrEqual(1)
    expect((html.match(/bg-warning/g) ?? []).length).toBe(1)
    expect(html).toContain('>failed<')
    expect(html).toContain('1.8 s')
    // Nothing selected: nothing open.
    expect(html).not.toContain('flow-execution-open')
    expect(html).not.toContain('aria-expanded="true"')
  })

  it('has no mark and no amber without the flow\'s p95', () => {
    const html = list()
    expect(html).not.toContain('flow-execution-mark')
    expect(html).not.toContain('bg-warning')
  })

  it('opens the selected row and shows the detail under it', () => {
    const html = list({ selectedId: 'b2' })
    expect((html.match(/data-testid="flow-execution-open"/g) ?? []).length).toBe(1)
    expect((html.match(/aria-expanded="true"/g) ?? []).length).toBe(1)
    expect(html.indexOf('the detail')).toBeGreaterThan(html.indexOf('1.8 s'))
    expect(html.indexOf('the detail')).toBeLessThan(html.indexOf('1.6 s'))
  })
})

describe('the marks of the time axis', () => {
  it('are round steps up to the end', () => {
    expect(axisTicks(1900)).toEqual([0, 500, 1000, 1500])
    expect(axisTicks(2000)).toEqual([0, 500, 1000, 1500, 2000])
    expect(axisTicks(320)).toEqual([0, 100, 200, 300])
    expect(axisTicks(0)).toEqual([0])
  })
})

describe('one execution, opened', () => {
  const trace: FlowTrace = {
    traceId: 'trace-b2',
    at,
    durationMs: 1900,
    outcome: 'failure',
    hops: {
      bff: { key: 'bff', of: 'nodes', startMs: 0, durationMs: 1900, count: 1, failed: false },
      'bff->orders': { key: 'bff->orders', of: 'edges', startMs: 0, durationMs: 160, count: 1, failed: false },
      orders: { key: 'orders', of: 'nodes', startMs: 880, durationMs: 310, count: 2, failed: true }
    },
    missing: ['payments'],
    unmapped: [{ event: 'span', service: 'shop-bff', name: 'SELECT', destination: 'postgresql', startMs: 1800, durationMs: 35, count: 1 }]
  }
  const logs: FlowTraceLog[] = [
    { at: at + 20, service: 'shop-bff', level: 'info', message: 'Checkout request received', source: 'logs' },
    { at: at + 640, service: 'orders', message: 'The operation has timed out', type: 'TimeoutException', source: 'apm.error' },
    { at: at + 700, service: 'shop-bff', level: 'warn', message: 'Falling back to the cached quote', source: 'logs' }
  ]
  const detail = (props: Partial<Parameters<typeof TraceDetail>[0]> = {}) =>
    renderToStaticMarkup(createElement(TooltipProvider, null, createElement(TraceDetail, { map, trace, logs: { ok: true, logs }, loadingLogs: false, picked: null, onPick: noop, ...props })))

  it('says first where it failed, when and with what error', () => {
    expect(detail()).toContain('Failed in orders at 0.64 s: “The operation has timed out”.')
    expect(detail({ logs: { ok: true, logs: [] } })).toContain('It failed, and no error was logged for it.')
  })

  it('says which part took longest when it went well, leaving out the one that spans it all', () => {
    const ok = detail({ trace: { ...trace, outcome: 'success', hops: { ...trace.hops, orders: { ...trace.hops['orders']!, failed: false } } }, logs: { ok: true, logs: [] } })
    expect(ok).toContain('Took 1.9 s; the longest part was orders, 310 ms.')
  })

  it('draws the parts over a time axis with the log lines marked on it, the failed part in red', () => {
    const html = detail()
    expect(html).toContain('data-testid="flow-trace-axis"')
    for (const tick of ['500 ms', '1.0 s', '1.5 s']) expect(html).toContain(`>${tick}<`)
    expect((html.match(/<li /g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect((html.match(/data-failed=""/g) ?? []).length).toBe(1)
    expect(html).toContain('310 ms ×2')
    const marks = html.slice(html.indexOf('data-testid="flow-trace-marks"'), html.indexOf('data-testid="flow-trace-waterfall"'))
    expect((marks.match(/<span title=/g) ?? []).length).toBe(3)
    expect((marks.match(/bg-danger/g) ?? []).length).toBe(1)
    expect(marks).toContain('+0.64 s · orders · The operation has timed out')
  })

  it('lists the logs with the error set apart, and what it did outside the map or never touched', () => {
    const html = detail()
    expect(html).toContain('data-testid="flow-trace-logs"')
    expect(html).toContain('Outside the map:')
    expect(html).toContain('shop-bff → postgresql')
    expect(html).toContain('Not touched: payments')
  })

  it('offers to investigate and to see it on the map only when it can', () => {
    expect(detail()).not.toContain('See on the map')
    const html = detail({ onAsk: noop, onShowOnMap: noop })
    expect(html).toContain('Investigate')
    expect(html).toContain('See on the map')
    expect(html).toContain('trace-b2')
  })
})
