import { describe, expect, it } from 'vitest'
import { emptyConfig, NO_CAPABILITIES, type AgentRuntime, type ConfigurationService, type StartSessionRequest, type TranscriptReader } from '@workhub/core'
import { SessionManager } from '../src/main/session-manager'

function harness(hasTranscript: boolean, failStarts = 0) {
  const started: StartSessionRequest[] = []
  const stopped: string[] = []
  const runtime: AgentRuntime = {
    adapter: 'native',
    capabilities: () => ({ ...NO_CAPABILITIES, appMode: true }),
    start: async (r: StartSessionRequest) => {
      started.push(r)
      if (started.length <= failStarts) throw new Error('This session is in use by another client.')
      return { agentName: 'Claude Code', permissionMode: null, agentSessionId: r.agentSessionId }
    },
    prompt: async () => ({ stopReason: 'end_turn' }),
    cancel: async () => {},
    stop: async (id: string) => void stopped.push(id),
    stopAll: async () => {},
    respondPermission: () => {},
    subscribe: () => () => {}
  }
  const terminal: AgentRuntime = { ...runtime, stop: async (id: string) => void stopped.push(id) }
  const reader = { id: 'claude', exists: async () => hasTranscript, read: async () => null, forget: () => {} } as unknown as TranscriptReader
  const manager = new SessionManager({
    config: { current: async () => emptyConfig(), replaceSessionIdentity: async () => undefined } as unknown as ConfigurationService,
    runtimes: { native: runtime },
    terminal,
    transcripts: [reader],
    history: {},
    emitEvent: () => {},
    emitChanged: () => {},
    emitReplay: () => {},
    pollMs: 60_000
  })
  return { manager, started, stopped }
}

const settle = () => new Promise((r) => setTimeout(r, 20))

describe('SessionManager: closing and removing stop the terminals', () => {
  it('close() of a session whose agent already exited stops its shell and console', async () => {
    const { manager, stopped } = harness(true)
    const v = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api' })
    await manager.stop(v.id)
    stopped.length = 0
    await manager.close(v.id)
    await settle()
    expect(stopped).toEqual(expect.arrayContaining([`${v.id}:shell`, `${v.id}:console`]))
    expect(manager.list()).toEqual([])
  })

  it('remove() stops them too', async () => {
    const { manager, stopped } = harness(true)
    const v = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api' })
    await manager.stop(v.id)
    stopped.length = 0
    expect(manager.remove(v.id)).toBe(true)
    await settle()
    expect(stopped).toEqual(expect.arrayContaining([`${v.id}:shell`, `${v.id}:console`]))
  })
})

describe('SessionManager: reopening a kept session', () => {
  it('resumes when its transcript exists', async () => {
    const { manager, started } = harness(true)
    await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api', resumeAgentSessionId: 'agent-1' })
    await settle()
    expect(started[0]).toMatchObject({ agentSessionId: 'agent-1', resume: true })
  })

  it('starts fresh with the same session id when it has no transcript', async () => {
    const { manager, started } = harness(false)
    await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api', resumeAgentSessionId: 'agent-1' })
    await settle()
    expect(started[0]).toMatchObject({ agentSessionId: 'agent-1', resume: false })
  })

  it('replaces the copy whose resume failed instead of keeping both', async () => {
    const { manager, started } = harness(true, 1)
    const failed = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api', resumeAgentSessionId: 'agent-1' })
    await settle()
    expect(manager.list().find((v) => v.id === failed.id)?.state).toBe('error')
    const retried = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api', resumeAgentSessionId: 'agent-1' })
    await settle()
    expect(started).toHaveLength(2)
    expect(manager.list().map((v) => v.id)).toEqual([retried.id])
  })
})
