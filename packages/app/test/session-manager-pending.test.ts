import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyConfig, NO_CAPABILITIES, type AgentEvent, type AgentEventListener, type AgentRuntime, type ConfigurationService, type StartSessionRequest } from '@workhub/core'
import { SessionManager } from '../src/main/session-manager'
import type { SessionView } from '../src/shared/api'

function harness() {
  let listener: AgentEventListener = () => {}
  const answered: string[] = []
  const runtime: AgentRuntime = {
    adapter: 'native',
    capabilities: () => ({ ...NO_CAPABILITIES, appMode: true }),
    start: async (r: StartSessionRequest) => ({ agentName: 'Claude Code', permissionMode: null, agentSessionId: r.agentSessionId }),
    prompt: async () => ({ stopReason: 'end_turn' }),
    cancel: async () => {},
    stop: async () => {},
    stopAll: async () => {},
    respondPermission: (_id, requestId) => answered.push(requestId),
    subscribe: (l) => {
      listener = l
      return () => {}
    }
  }
  const changed: SessionView[] = []
  const manager = new SessionManager({
    config: { current: async () => emptyConfig(), replaceSessionIdentity: async () => undefined } as unknown as ConfigurationService,
    runtimes: { native: runtime },
    terminal: runtime,
    transcripts: [],
    history: {},
    emitEvent: () => {},
    emitChanged: (s) => changed.push(s),
    emitReplay: () => {},
    pollMs: 60_000
  })
  return { manager, changed, answered, emit: (e: AgentEvent) => listener(e) }
}

describe('SessionManager: open permission requests live in the view', () => {
  it('adds a request on its event, drops it on the answer or its cancellation, and clears all when the turn ends', async () => {
    const { manager, changed, answered, emit } = harness()
    const v = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api' })
    expect(changed.at(-1)!.pendingPermissions).toEqual([])
    emit({ sessionId: v.id, type: 'state', state: 'busy' })
    emit({ sessionId: v.id, type: 'permission', requestId: 'r1', title: 'Run ls?', options: [], detail: 'ls -la' })
    emit({ sessionId: v.id, type: 'permission', requestId: 'r2', title: 'Which one?', options: [], questions: [{ question: 'Which one?', options: [] }] })
    const pending = changed.at(-1)!.pendingPermissions!
    expect(pending.map((p) => p.requestId)).toEqual(['r1', 'r2'])
    expect(pending[0]).toMatchObject({ title: 'Run ls?', detail: 'ls -la' })
    expect(pending[1]!.questions).toHaveLength(1)
    expect(typeof pending[0]!.at).toBe('number')

    manager.respondPermission(v.id, 'r1', 'allow')
    expect(answered).toEqual(['r1'])
    expect(changed.at(-1)!.pendingPermissions!.map((p) => p.requestId)).toEqual(['r2'])

    emit({ sessionId: v.id, type: 'permissionCancelled', requestId: 'r2' })
    expect(changed.at(-1)!.pendingPermissions).toEqual([])

    emit({ sessionId: v.id, type: 'permission', requestId: 'r3', title: 'Run rm?', options: [] })
    expect(changed.at(-1)!.pendingPermissions).toHaveLength(1)
    emit({ sessionId: v.id, type: 'state', state: 'ready' })
    expect(changed.at(-1)!.pendingPermissions).toEqual([])
  })

  it('an answer given through Workhub is listed, so chats can tell it from a withdrawn request', async () => {
    const { manager, changed, emit } = harness()
    const v = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api' })
    emit({ sessionId: v.id, type: 'permission', requestId: 'r1', title: 'Run ls?', options: [], detail: 'x'.repeat(3000) })
    expect(changed.at(-1)!.pendingPermissions![0]!.detail).toHaveLength(2001)
    manager.respondPermission(v.id, 'r1', 'allow')
    expect(changed.at(-1)!.answeredPermissions).toEqual(['r1'])
    emit({ sessionId: v.id, type: 'permission', requestId: 'r2', title: 'Run rm?', options: [] })
    emit({ sessionId: v.id, type: 'permissionCancelled', requestId: 'r2' })
    expect(changed.at(-1)!.answeredPermissions).toEqual(['r1'])
  })

  it("the console's permission prompt sets consoleAsking (with its time) until Enter is typed or the console stops", async () => {
    const { manager, changed, emit } = harness()
    const v = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api', mode: 'console' })
    const console = `${v.id}:console`
    emit({ sessionId: console, type: 'state', state: 'ready' })
    const before = Date.now()
    emit({ sessionId: console, type: 'output', data: '\x1b]0;✳ Claude Code\x07\x1b]777;notify;Claude Code;Claude needs your permission to use Bash\x07' })
    expect(changed.at(-1)!.consoleAsking).toBe(true)
    expect(changed.at(-1)!.consoleAskingSince).toBeGreaterThanOrEqual(before)
    // Moving through the options, or xterm's own focus report, is not an answer.
    const n = changed.length
    manager.write(console, '\x1b[B')
    manager.write(console, '\x1b[I')
    expect(changed.length).toBe(n)
    manager.write(console, '\r')
    expect(changed.at(-1)).toMatchObject({ consoleAsking: false })
    expect(changed.at(-1)!.consoleAskingSince).toBeUndefined()
    emit({ sessionId: console, type: 'output', data: '\x1b]9;Claude has a question\x07' })
    expect(changed.at(-1)!.consoleAsking).toBe(true)
    emit({ sessionId: console, type: 'state', state: 'stopped' })
    expect(changed.at(-1)).toMatchObject({ state: 'stopped', consoleAsking: false })
  })

  it('answering an unknown request changes nothing', async () => {
    const { manager, changed } = harness()
    const v = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api' })
    const before = changed.length
    manager.respondPermission(v.id, 'nope', 'allow')
    expect(changed.length).toBe(before)
  })
})

describe('SessionManager: transcript polling', () => {
  function polling() {
    let listener: AgentEventListener = () => {}
    const runtime: AgentRuntime = {
      adapter: 'native',
      capabilities: () => ({ ...NO_CAPABILITIES, appMode: true }),
      start: async (r: StartSessionRequest) => ({ agentName: 'Claude Code', permissionMode: null, agentSessionId: r.agentSessionId }),
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
    const reads: string[] = []
    const forgotten: string[] = []
    const reader = {
      id: 'claude',
      read: async (q: { agentSessionId: string }) => {
        reads.push(q.agentSessionId)
        return null
      },
      exists: async () => true,
      forget: (id: string) => forgotten.push(id)
    }
    const manager = new SessionManager({
      config: { current: async () => emptyConfig(), replaceSessionIdentity: async () => undefined } as unknown as ConfigurationService,
      runtimes: { native: runtime },
      terminal: runtime,
      transcripts: [reader],
      history: {},
      emitEvent: () => {},
      emitChanged: () => {},
      emitReplay: () => {},
      pollMs: 10
    })
    return { manager, reads, forgotten, emit: (e: AgentEvent) => listener(e) }
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('reads a stopped session once more, then leaves it alone until it starts again, and forgets it when removed', async () => {
    const { manager, reads, forgotten, emit } = polling()
    const v = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api' })
    await wait(50)
    expect(reads.length).toBeGreaterThan(0)

    emit({ sessionId: v.id, type: 'state', state: 'stopped' })
    await wait(50)
    const afterStop = reads.length
    await wait(80)
    expect(reads.length).toBe(afterStop)

    emit({ sessionId: v.id, type: 'state', state: 'starting' })
    await wait(50)
    expect(reads.length).toBeGreaterThan(afterStop)

    emit({ sessionId: v.id, type: 'state', state: 'stopped' })
    await wait(50)
    const again = reads.length
    await wait(80)
    expect(reads.length).toBe(again)

    expect(manager.remove(v.id)).toBe(true)
    expect(forgotten).toEqual([v.agentSessionId])
  })
})

describe('SessionManager: stuck-session watchdog', () => {
  afterEach(() => vi.useRealTimers())
  const MIN = 60_000

  it('flags a working session whose agent went silent, clears it on the next event, and Keep waiting restarts the count', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const { manager, changed, emit } = harness()
    const v = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api' })
    emit({ sessionId: v.id, type: 'state', state: 'busy' })
    await vi.advanceTimersByTimeAsync(9 * MIN)
    expect(changed.at(-1)!.stalledSince).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(changed.at(-1)!.stalledSince).toBeGreaterThan(0)

    emit({ sessionId: v.id, type: 'message', role: 'agent', text: 'still here' })
    expect(changed.at(-1)!.stalledSince).toBeUndefined()

    await vi.advanceTimersByTimeAsync(11 * MIN)
    expect(changed.at(-1)!.stalledSince).toBeGreaterThan(0)
    manager.keepWaiting(v.id)
    expect(changed.at(-1)!.stalledSince).toBeUndefined()
    await vi.advanceTimersByTimeAsync(9 * MIN)
    expect(changed.at(-1)!.stalledSince).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(changed.at(-1)!.stalledSince).toBeGreaterThan(0)

    // The turn ends: nothing is stuck any more.
    emit({ sessionId: v.id, type: 'state', state: 'ready' })
    expect(changed.at(-1)!.stalledSince).toBeUndefined()
    await manager.stopAll()
  })

  it('never flags a session that waits on a permission request', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const { manager, changed, emit } = harness()
    const v = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api' })
    emit({ sessionId: v.id, type: 'state', state: 'busy' })
    emit({ sessionId: v.id, type: 'permission', requestId: 'r1', title: 'Run ls?', options: [] })
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(changed.every((c) => c.stalledSince === undefined)).toBe(true)
    await manager.stopAll()
  })
})
