import { describe, expect, it } from 'vitest'
import { emptyConfig, NO_CAPABILITIES, type AgentEvent, type AgentEventListener, type AgentRuntime, type ConfigurationService } from '@workhub/core'
import { SessionManager } from '../src/main/session-manager'

function harness(startError?: string) {
  let listener: AgentEventListener = () => {}
  const runtime: AgentRuntime = {
    adapter: 'native',
    capabilities: () => ({ ...NO_CAPABILITIES, appMode: true }),
    start: async (r) => {
      if (startError) {
        // As the Claude runtime does: the failure goes out as a state event, then the start rejects.
        listener({ sessionId: r.sessionId, type: 'state', state: 'error', error: startError })
        throw new Error(startError)
      }
      return { agentName: 'Claude Code', permissionMode: null, agentSessionId: r.agentSessionId }
    },
    prompt: async () => ({ stopReason: 'end_turn' }),
    cancel: async () => {},
    stop: async () => {},
    stopAll: async () => {},
    respondPermission: () => {},
    subscribe: (l) => {
      listener = l
      return () => {}
    }
  }
  const logged: string[] = []
  const manager = new SessionManager({
    config: { current: async () => emptyConfig(), replaceSessionIdentity: async () => undefined } as unknown as ConfigurationService,
    runtimes: { native: runtime },
    terminal: runtime,
    transcripts: [],
    history: {},
    emitEvent: () => {},
    emitChanged: () => {},
    emitReplay: () => {},
    pollMs: 60_000,
    log: (m) => logged.push(m)
  })
  return { manager, logged, emit: (e: AgentEvent) => listener(e) }
}

describe('SessionManager: failures reach the main log', () => {
  it('logs a start failure once, with the error text (the agent stderr tail)', async () => {
    const { manager, logged } = harness('the Claude bridge exited during start (code 2):\nError: cannot find module acme-sdk')
    await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api' }).catch(() => {})
    await new Promise((r) => setTimeout(r, 20))
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatch(/failed to start: the Claude bridge exited during start \(code 2\):\nError: cannot find module acme-sdk$/)
  })

  it('logs an unexpected exit of a running session', async () => {
    const { manager, logged, emit } = harness()
    const v = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api' })
    emit({ sessionId: v.id, type: 'state', state: 'ready' })
    emit({ sessionId: v.id, type: 'state', state: 'error', error: 'Claude exited (code 3):\nacme: login expired' })
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('ended unexpectedly: Claude exited (code 3):\nacme: login expired')
  })
})
