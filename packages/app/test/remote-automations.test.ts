import { describe, expect, it, vi } from 'vitest'
import { fitsFrame } from '@workhub/protocol'
import type { AutomationRun } from '@workhub/core'
import type { IpcRegistrar } from '../src/main/ipc-guard'
import { recordIpc, RemoteHub, type RemoteDevice } from '../src/main/remote'
import { REMOTE_INVOKES } from '../src/main/remote/allowlist'
import type { AutomationsSnapshot, AutomationStatus } from '../src/shared/chat-api'
import type { RemoteAutomation, RemoteCapability, RemotePage } from '../src/shared/remote-api'

function status(n: number, patch: Partial<AutomationStatus> = {}, enabled = true): AutomationStatus {
  return {
    definition: { id: `auto-${n}`, name: `Triage ${n}`, enabled, prompt: 'SECRET PROMPT '.repeat(200), folder: '/home/someone/acme', agentKey: 'claude' },
    health: enabled ? 'idle' : 'off',
    startedInWindow: 0,
    startedToday: 0,
    active: true,
    ...patch
  } as unknown as AutomationStatus
}

function run(n: number, outcome: AutomationRun['outcome'] = 'ok'): AutomationRun {
  return { id: `run-${n}`, automationId: `auto-${n}`, automationName: `Triage ${n}`, trigger: 'manual', queuedAt: 1000 + n, startedAt: 2000 + n, endedAt: 3000 + n, outcome, merged: 0 } as AutomationRun
}

function setup(caps: RemoteCapability[] = ['automations'], snapshot: AutomationsSnapshot = { automations: [status(1), status(2, {}, false)], runs: [run(1, 'error')] }) {
  const { ipc, handlers } = recordIpc({ handle: () => {}, on: () => {} } as IpcRegistrar)
  const runNow = vi.fn(async () => undefined)
  const stop = vi.fn(async () => undefined)
  const setEnabled = vi.fn(async () => ({ ok: true, config: { connections: [{ token: 'SECRET' }] } }))
  ipc.handle('automations:get', () => snapshot)
  ipc.handle('automations:runNow', runNow)
  ipc.handle('automations:stop', stop)
  ipc.handle('automations:setEnabled', setEnabled)
  const hub = new RemoteHub({ handlers, profileFolders: async () => [], startMode: async () => null, log: { warn: vi.fn() } })
  const events: [string, unknown[]][] = []
  const phone: RemoteDevice = { id: 'phone', capabilities: new Set(caps), emit: (c, a) => events.push([c, a]) }
  hub.attach(phone)
  return { hub, runNow, stop, setEnabled, events }
}

describe('remote automations', () => {
  it('lists them as short rows: state, last run and next run, never the prompt or folder', async () => {
    const snapshot: AutomationsSnapshot = { automations: [status(1, { nextIntervalAt: Date.now() + 60_000 }), status(2, {}, false)], runs: [run(1, 'error')] }
    const { hub } = setup(['automations'], snapshot)
    const page = (await hub.invoke('phone', 'remote:automations', [{}])) as RemotePage<RemoteAutomation>
    expect(page.total).toBe(2)
    expect(page.items[0]).toMatchObject({ id: 'auto-1', name: 'Triage 1', enabled: true, active: true, health: 'idle', lastRun: { at: 3001, outcome: 'error' } })
    expect(page.items[0]!.nextRunAt).toEqual(expect.any(Number))
    expect(page.items[1]).toMatchObject({ id: 'auto-2', enabled: false, health: 'off' })
    expect(page.items[1]!.lastRun).toBeUndefined()
    expect(JSON.stringify(page)).not.toMatch(/SECRET|someone|folder|prompt/)
  })

  it('pages the list and keeps every page inside one relay frame', async () => {
    const automations = Array.from({ length: 450 }, (_, i) => status(i))
    const { hub } = setup(['automations'], { automations, runs: [] })
    const ids: string[] = []
    let cursor: string | null = null
    do {
      const page = (await hub.invoke('phone', 'remote:automations', [cursor ? { limit: 100, cursor } : { limit: 100 }])) as RemotePage<RemoteAutomation>
      expect(page.items.length).toBeLessThanOrEqual(100)
      expect(fitsFrame({ t: 'result', id: 1, ok: true, value: page })).toBe(true)
      ids.push(...page.items.map((a) => a.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(ids).toEqual(automations.map((a) => a.definition.id))
  })

  it('refuses a malformed page request', async () => {
    const { hub } = setup()
    await expect(hub.invoke('phone', 'remote:automations', [{ limit: 0 }])).rejects.toThrow('limit is not valid')
    await expect(hub.invoke('phone', 'remote:automations', [{ cursor: 'nope!' }])).rejects.toThrow('cursor is not valid')
  })

  it('refuses a device without the automations capability on every channel', async () => {
    const { hub, runNow, stop, setEnabled } = setup(['sessions', 'plan'])
    await expect(hub.invoke('phone', 'remote:automations', [{}])).rejects.toThrow('not available remotely')
    await expect(hub.invoke('phone', 'automations:runNow', ['auto-1'])).rejects.toThrow('not available remotely')
    await expect(hub.invoke('phone', 'automations:stop', ['auto-1'])).rejects.toThrow('not available remotely')
    await expect(hub.invoke('phone', 'automations:setEnabled', ['auto-1', false])).rejects.toThrow('not available remotely')
    expect(runNow).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect(setEnabled).not.toHaveBeenCalled()
  })

  it('lists exactly these channels under the capability, and nothing that edits or removes an automation', () => {
    for (const channel of ['remote:automations', 'automations:runNow', 'automations:stop', 'automations:setEnabled']) expect(REMOTE_INVOKES[channel]).toBe('automations')
    for (const channel of ['automations:get', 'automations:save', 'automations:remove', 'automations:openSession']) expect(REMOTE_INVOKES[channel]).toBeUndefined()
  })

  it('runs and stops by a valid id, passing nothing else on', async () => {
    const { hub, runNow, stop } = setup()
    await hub.invoke('phone', 'automations:runNow', ['auto-1', 'extra'])
    expect(runNow).toHaveBeenCalledWith(expect.anything(), 'auto-1')
    await hub.invoke('phone', 'automations:stop', ['auto-2', 'extra'])
    expect(stop).toHaveBeenCalledWith(expect.anything(), 'auto-2')
  })

  it('refuses an id that is missing or not an id', async () => {
    const { hub, runNow, stop, setEnabled } = setup()
    for (const bad of [undefined, null, 5, '', 'a b', '../x', 'x'.repeat(201), { id: 'auto-1' }]) {
      await expect(hub.invoke('phone', 'automations:runNow', [bad])).rejects.toThrow('automation is not valid')
      await expect(hub.invoke('phone', 'automations:stop', [bad])).rejects.toThrow('automation is not valid')
      await expect(hub.invoke('phone', 'automations:setEnabled', [bad, false])).rejects.toThrow('automation is not valid')
    }
    expect(runNow).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect(setEnabled).not.toHaveBeenCalled()
  })

  it('never turns an automation on: only off is accepted', async () => {
    const { hub, setEnabled } = setup()
    for (const on of [true, undefined, 'false', 0, null]) await expect(hub.invoke('phone', 'automations:setEnabled', ['auto-2', on])).rejects.toThrow('turned on at the desktop')
    expect(setEnabled).not.toHaveBeenCalled()
    await expect(hub.invoke('phone', 'automations:setEnabled', ['auto-1', false])).resolves.toEqual({ ok: true })
    expect(setEnabled).toHaveBeenCalledWith(expect.anything(), 'auto-1', false)
  })

  it('runs only an automation that is on, and an unknown one not at all', async () => {
    const { hub, runNow } = setup()
    await expect(hub.invoke('phone', 'automations:runNow', ['auto-2'])).rejects.toThrow('only an automation that is on')
    await expect(hub.invoke('phone', 'automations:runNow', ['auto-9'])).rejects.toThrow('only an automation that is on')
    expect(runNow).not.toHaveBeenCalled()
  })

  it('counts a run now against the budget of calls that start an agent', async () => {
    const { hub } = setup()
    for (let i = 0; i < 10; i++) await hub.invoke('phone', 'automations:runNow', ['auto-1'])
    await expect(hub.invoke('phone', 'automations:runNow', ['auto-1'])).rejects.toThrow('too many new agent runs')
  })

  it('answers a switch with whether it worked, never the config the desktop returns', async () => {
    const { hub } = setup()
    const answer = await hub.invoke('phone', 'automations:setEnabled', ['auto-1', false])
    expect(JSON.stringify(answer)).not.toContain('SECRET')
  })

  it('sends a device only the fact that the automations changed, not their prompts', () => {
    const { hub, events } = setup()
    hub.tap('automations:changed', [{ automations: [status(1)], runs: [] }])
    expect(events).toEqual([['automations:changed', []]])
  })
})
