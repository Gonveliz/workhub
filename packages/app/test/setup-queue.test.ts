import { describe, expect, it } from 'vitest'
import type { InstallerId } from '@workhub/core'
import type { InstallQueueSnapshot } from '../src/shared/setup-api'
import type { InstallOptions, InstallResult } from '../src/main/setup-install'
import { InstallQueue } from '../src/main/setup-queue'

/** An installer whose installs end when the test says so. */
function controlled() {
  const order: InstallerId[] = []
  const pending = new Map<InstallerId, { finish: (r: InstallResult) => void; options: InstallOptions }>()
  const install = (id: InstallerId, options: InstallOptions) =>
    new Promise<InstallResult>((finish) => {
      order.push(id)
      pending.set(id, { finish, options })
      options.signal?.addEventListener('abort', () => finish({ ok: false, output: '', reason: 'canceled' }))
    })
  return { order, pending, install }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('InstallQueue', () => {
  it('runs the installs one after another, in order, with a line each', async () => {
    const c = controlled()
    const seen: InstallQueueSnapshot[] = []
    let afterEach = 0
    const queue = new InstallQueue({ install: c.install, emit: (s) => seen.push(s), afterEach: async () => void afterEach++ })
    const done = queue.start(['node', 'opencode', 'not-an-installer'])!
    await tick()
    expect(c.order).toEqual(['node'])
    expect(queue.start(['git'])).toBeNull()
    c.pending.get('node')!.options.onProgress?.({ phase: 'downloading', received: 10, total: 100 })
    expect(queue.snapshot().items[0]).toMatchObject({ installer: 'node', state: 'downloading', received: 10, total: 100 })
    c.pending.get('node')!.finish({ ok: true, output: '' })
    await tick()
    expect(c.order).toEqual(['node', 'opencode'])
    c.pending.get('opencode')!.finish({ ok: false, output: 'npm error', reason: 'npm' })
    const end = await done
    expect(end).toEqual({ running: false, items: [{ installer: 'node', state: 'done', received: 10, total: 100 }, { installer: 'opencode', state: 'failed', reason: 'npm', detail: 'npm error' }] })
    expect(afterEach).toBe(2)
    expect(seen.at(-1)?.running).toBe(false)
  })

  it('cancel stops the current install and the ones not started', async () => {
    const c = controlled()
    const queue = new InstallQueue({ install: c.install, emit: () => undefined })
    const done = queue.start(['node', 'git', 'github'])!
    await tick()
    queue.cancel()
    const end = await done
    expect(c.order).toEqual(['node'])
    expect(end.items.map((i) => i.state)).toEqual(['canceled', 'canceled', 'canceled'])
  })

  it('tries one failed line again, and only a failed or canceled one', async () => {
    const c = controlled()
    const queue = new InstallQueue({ install: c.install, emit: () => undefined })
    const first = queue.start(['git', 'github'])!
    await tick()
    c.pending.get('git')!.finish({ ok: false, output: '', reason: 'offline' })
    await tick()
    c.pending.get('github')!.finish({ ok: true, output: '' })
    await first
    expect(queue.retry('github')).toBeNull()
    const again = queue.retry('git')!
    await tick()
    expect(queue.snapshot().items[0]).toEqual({ installer: 'git', state: 'installing' })
    c.pending.get('git')!.finish({ ok: true, output: '' })
    expect((await again).items.map((i) => i.state)).toEqual(['done', 'done'])
    expect(c.order).toEqual(['git', 'github', 'git'])
  })
})
