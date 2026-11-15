import { describe, expect, it } from 'vitest'
import type { SubagentSummary } from '@workhub/core'
import { RemoteActivityLog } from '../src/main/remote/activity'

const sub = (id: string, extra: Partial<SubagentSummary> = {}): SubagentSummary => ({ id, status: 'running', type: 'general-purpose', description: `Explore ${id}`, ...extra })

describe('RemoteActivityLog', () => {
  it('keeps the latest sub-agents and background tasks of each session from its monitor updates', () => {
    const log = new RemoteActivityLog()
    expect(log.of('s1')).toEqual({ subagents: [], backgroundTasks: [] })
    log.onEvent({ sessionId: 's1', type: 'monitor', snapshot: { subagents: [sub('a')] } })
    log.onEvent({ sessionId: 's1', type: 'monitor', snapshot: { backgroundTasks: [{ id: 't', kind: 'shell', description: 'Wait for CI checks', since: 5 }] } })
    // An update without either leaves both as they were.
    log.onEvent({ sessionId: 's1', type: 'monitor', snapshot: { activeTimeMs: 10 } })
    expect(log.of('s1').subagents.map((s) => s.id)).toEqual(['a'])
    expect(log.of('s1').backgroundTasks).toEqual([{ id: 't', kind: 'shell', description: 'Wait for CI checks', since: 5 }])
    // Tasks are replaced whole: an empty list means none runs.
    log.onEvent({ sessionId: 's1', type: 'monitor', snapshot: { backgroundTasks: [] } })
    expect(log.of('s1').backgroundTasks).toEqual([])
    expect(log.of('s2').subagents).toEqual([])
    log.forget('s1')
    expect(log.of('s1').subagents).toEqual([])
  })

  it('sends a device what the phone draws: no model, tokens or cost, and long text cut', () => {
    const log = new RemoteActivityLog()
    log.onEvent({
      sessionId: 's1',
      type: 'monitor',
      snapshot: { subagents: [sub('a', { model: 'big-model', tokens: { input: 1, output: 2 } as SubagentSummary['tokens'], cost: { amount: 1, currency: 'USD' }, lastStep: 'y'.repeat(5000) })] }
    })
    const [a] = log.of('s1').subagents
    expect(a).not.toHaveProperty('model')
    expect(a).not.toHaveProperty('tokens')
    expect(a).not.toHaveProperty('cost')
    expect(a!.lastStep!.length).toBeLessThanOrEqual(300)
    expect(a).toMatchObject({ id: 'a', status: 'running', type: 'general-purpose', description: 'Explore a' })
  })

  it('ignores every other event', () => {
    const log = new RemoteActivityLog()
    log.onEvent({ sessionId: 's1', type: 'agentText', text: 'hi' } as never)
    expect(log.of('s1')).toEqual({ subagents: [], backgroundTasks: [] })
  })
})
