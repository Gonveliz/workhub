import { describe, expect, it, vi } from 'vitest'
import { busyCounts, isBusy, QuitGuard, QuitWhenIdle, type BusyView, type QuitChoice, type QuitIntent } from '../src/main/quit-guard'
import { SendGate } from '../src/main/send-gate'

const none = { working: 0, queued: 0, permissions: 0 }

describe('what counts as busy', () => {
  it('counts working sessions, queued prompts and open requests', () => {
    const views: BusyView[] = [
      { state: 'busy' },
      { state: 'busy', pendingPermissions: [{}, {}] },
      { state: 'ready', pendingPermissions: [{}] },
      { state: 'ready', consoleAsking: true },
      { state: 'ready' }
    ]
    expect(busyCounts(views, 3)).toEqual({ working: 2, queued: 3, permissions: 4 })
  })

  it('ignores idle, starting, stopped and failed sessions', () => {
    const counts = busyCounts([{ state: 'ready' }, { state: 'starting' }, { state: 'stopped', pendingPermissions: [{}] }, { state: 'error', consoleAsking: true }], 0)
    expect(counts).toEqual(none)
    expect(isBusy(counts)).toBe(false)
  })

  it('is busy for any one of the three', () => {
    expect(isBusy({ ...none, working: 1 })).toBe(true)
    expect(isBusy({ ...none, queued: 1 })).toBe(true)
    expect(isBusy({ ...none, permissions: 1 })).toBe(true)
  })

  it('counts the prompts a send gate holds behind the running one', async () => {
    const gate = new SendGate()
    let release: () => void = () => {}
    const first = gate.run('a', () => new Promise<void>((r) => (release = r)))
    const second = gate.run('a', async () => undefined, 'k')
    const other = gate.run('b', () => new Promise<void>(() => {}))
    other.catch(() => undefined)
    expect(gate.waitingCount()).toBe(1)
    release()
    await Promise.all([first, second])
    expect(gate.waitingCount()).toBe(0)
  })
})

describe('quit when idle', () => {
  const busy = { ...none, working: 1 }

  it('does nothing until armed', () => {
    const idle = new QuitWhenIdle(1000)
    expect(idle.observe(none, 0)).toBe('none')
    expect(idle.pending).toBeNull()
  })

  it('waits while busy, then quits once nothing was busy for the settle time', () => {
    const idle = new QuitWhenIdle(1000)
    idle.arm('quit')
    expect(idle.observe(busy, 0)).toBe('wait')
    expect(idle.observe(none, 500)).toBe('wait')
    expect(idle.observe(none, 1400)).toBe('wait')
    expect(idle.observe(none, 1500)).toBe('quit')
    expect(idle.pending).toBeNull()
    expect(idle.observe(none, 2500)).toBe('none')
  })

  it('a new prompt postpones it: the settle time starts over', () => {
    const idle = new QuitWhenIdle(1000)
    idle.arm('restart')
    expect(idle.observe(none, 0)).toBe('wait')
    expect(idle.observe({ ...none, queued: 1 }, 900)).toBe('wait')
    expect(idle.observe(none, 1000)).toBe('wait')
    expect(idle.observe(none, 1900)).toBe('wait')
    expect(idle.observe(none, 2000)).toBe('quit')
  })

  it('can be cancelled', () => {
    const idle = new QuitWhenIdle(0)
    idle.arm('quit')
    idle.cancel()
    expect(idle.observe(none, 5000)).toBe('none')
  })

  it('keeps the intent it was armed with', () => {
    const idle = new QuitWhenIdle(0)
    idle.arm('restart')
    expect(idle.pending).toBe('restart')
  })
})

/** A guard with a fake clock; `tick` is driven by the test. */
function setup(initial: { views: BusyView[]; queued?: number }, choice: QuitChoice = 'cancel') {
  const state = { views: initial.views, queued: initial.queued ?? 0, now: 0 }
  const published: (QuitIntent | null)[] = []
  const confirm = vi.fn(async () => choice)
  const cancelled = vi.fn()
  const stopTimer = vi.fn()
  const guard = new QuitGuard({
    views: () => state.views,
    queuedPrompts: () => state.queued,
    confirm,
    publish: (p) => published.push(p),
    cancelled,
    now: () => state.now,
    setTimer: () => stopTimer
  })
  return { guard, state, published, confirm, cancelled, stopTimer }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe('the quit guard', () => {
  it('lets a quit through when nothing is busy', () => {
    const { guard, confirm } = setup({ views: [{ state: 'ready' }] })
    expect(guard.intercept(() => undefined)).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('asks when a session works, and stops the quit', async () => {
    const { guard, confirm, cancelled } = setup({ views: [{ state: 'busy' }] })
    expect(guard.intercept(() => undefined)).toBe(true)
    await flush()
    expect(confirm).toHaveBeenCalledWith({ working: 1, queued: 0, permissions: 0 }, 'quit')
    expect(cancelled).toHaveBeenCalled()
  })

  it('asks for queued prompts and open requests too', () => {
    expect(setup({ views: [], queued: 2 }).guard.intercept(() => undefined)).toBe(true)
    expect(setup({ views: [{ state: 'ready', pendingPermissions: [{}] }] }).guard.intercept(() => undefined)).toBe(true)
  })

  it('quits anyway: runs the quit and lets the next before-quit through', async () => {
    const { guard } = setup({ views: [{ state: 'busy' }] }, 'now')
    const quit = vi.fn()
    expect(guard.intercept(quit)).toBe(true)
    await flush()
    expect(quit).toHaveBeenCalledTimes(1)
    expect(guard.intercept(quit)).toBe(false)
  })

  it('does not ask when the preference is off', () => {
    const { guard, confirm } = setup({ views: [{ state: 'busy' }] })
    guard.setEnabled(false)
    expect(guard.intercept(() => undefined)).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('never blocks a system shutdown, and drops a wait in progress', async () => {
    const { guard, state, published } = setup({ views: [{ state: 'busy' }] }, 'whenIdle')
    guard.intercept(() => undefined)
    await flush()
    expect(guard.pending).toBe('quit')
    guard.systemShutdown()
    expect(guard.pending).toBeNull()
    expect(published).toEqual(['quit', null])
    state.views = [{ state: 'busy' }]
    expect(guard.intercept(() => undefined)).toBe(false)
  })

  it('waits for idle, shows it, and quits once the sessions settle', async () => {
    const { guard, state, published } = setup({ views: [{ state: 'busy' }] }, 'whenIdle')
    const quit = vi.fn()
    expect(guard.intercept(quit)).toBe(true)
    await flush()
    expect(published).toEqual(['quit'])
    state.now = 1000
    guard.tick()
    expect(quit).not.toHaveBeenCalled()
    state.views = [{ state: 'ready' }]
    state.now = 2000
    guard.tick()
    state.now = 4000
    guard.tick()
    expect(quit).not.toHaveBeenCalled()
    state.now = 5100
    guard.tick()
    expect(quit).toHaveBeenCalledTimes(1)
    expect(published).toEqual(['quit', null])
    expect(guard.intercept(quit)).toBe(false)
  })

  it('a prompt that arrives while waiting postpones the quit', async () => {
    const { guard, state } = setup({ views: [{ state: 'busy' }] }, 'whenIdle')
    const quit = vi.fn()
    guard.intercept(quit)
    await flush()
    state.views = [{ state: 'ready' }]
    state.now = 1000
    guard.tick()
    state.queued = 1
    state.now = 3900
    guard.tick()
    state.queued = 0
    state.now = 4000
    guard.tick()
    state.now = 6900
    guard.tick()
    expect(quit).not.toHaveBeenCalled()
    state.now = 7100
    guard.tick()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('a wait can be cancelled and the app stays open', async () => {
    const { guard, state, published, stopTimer } = setup({ views: [{ state: 'busy' }] }, 'whenIdle')
    const quit = vi.fn()
    guard.intercept(quit)
    await flush()
    guard.cancelPending()
    expect(published).toEqual(['quit', null])
    expect(stopTimer).toHaveBeenCalled()
    state.views = []
    state.now = 99_000
    guard.tick()
    expect(quit).not.toHaveBeenCalled()
  })

  it('restarting for an update asks the same way, and keeps its intent', async () => {
    const { guard, confirm, state, published } = setup({ views: [{ state: 'busy' }] }, 'whenIdle')
    const restart = vi.fn()
    guard.request('restart', restart)
    await flush()
    expect(confirm).toHaveBeenCalledWith(expect.anything(), 'restart')
    expect(published).toEqual(['restart'])
    state.views = []
    state.now = 10_000
    guard.tick()
    state.now = 14_000
    guard.tick()
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('restarts at once when nothing is busy', () => {
    const { guard } = setup({ views: [] })
    const restart = vi.fn()
    guard.request('restart', restart)
    expect(restart).toHaveBeenCalledTimes(1)
  })
})
