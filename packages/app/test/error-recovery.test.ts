import { describe, expect, it } from 'vitest'
import { MAX_RELOADS, RELOAD_WINDOW_MS, ReloadGuard, shouldReload } from '../src/main/render-recovery'
import { boundaryCaught, boundaryReport, boundaryReset, toError } from '../src/renderer/lib/errorBoundary'

describe('ReloadGuard', () => {
  it('allows three reloads a minute per window, then refuses', () => {
    let now = 1_000
    const guard = new ReloadGuard(() => now)
    for (let i = 0; i < MAX_RELOADS; i++) expect(guard.allow(1)).toBe(true)
    expect(guard.allow(1)).toBe(false)
    expect(guard.allow(2)).toBe(true)
    now += RELOAD_WINDOW_MS
    expect(guard.allow(1)).toBe(true)
  })

  it('forgets a closed window', () => {
    const guard = new ReloadGuard(() => 5)
    for (let i = 0; i < MAX_RELOADS; i++) guard.allow(1)
    guard.forget(1)
    expect(guard.allow(1)).toBe(true)
  })

  it('does not reload after a clean exit or a kill', () => {
    expect(['clean-exit', 'killed'].map(shouldReload)).toEqual([false, false])
    expect(['crashed', 'oom', 'launch-failed', 'integrity-failure'].every(shouldReload)).toBe(true)
  })
})

describe('error boundary state', () => {
  it('keeps the caught error and clears it on Try again', () => {
    const state = boundaryCaught(new TypeError('bad tool card'))
    expect(state.error?.message).toBe('bad tool card')
    expect(boundaryReset().error).toBeNull()
  })

  it('turns a thrown non-error into an Error', () => {
    expect(toError('oops').message).toBe('oops')
    expect(toError(42).message).toBe('Unknown error')
  })

  it('reports where it happened as an error report', () => {
    const report = boundaryReport(new RangeError('x'), 'session')
    expect(report).toEqual({ kind: 'error', message: 'session: RangeError: x' })
  })
})
