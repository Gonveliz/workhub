import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  emptyConfig,
  NO_CAPABILITIES,
  type AgentAdapterKind,
  type AgentEvent,
  type AgentEventListener,
  type AgentRuntime,
  type ConfigurationService,
  type SessionHistorySource,
  type StartSessionRequest,
  type TranscriptReader
} from '@workhub/core'
import type { GitRunner } from '@workhub/adapters/git-review'
import type { ExecutionServices } from '@workhub/adapters/host'
import { HostRegistry, localHost, originUrl, type HostTarget } from '../src/main/hosts'
import { SessionManager, type SessionServices } from '../src/main/session-manager'

/** A runtime that records what it was asked and lets the test emit events. */
class FakeRuntime implements AgentRuntime {
  started: StartSessionRequest[] = []
  prompts: string[] = []
  writes: [string, string][] = []
  stoppedAll = 0
  private listeners = new Set<AgentEventListener>()
  constructor(readonly adapter: AgentAdapterKind) {}
  capabilities() {
    return { ...NO_CAPABILITIES, appMode: true }
  }
  async start(r: StartSessionRequest) {
    this.started.push(r)
    this.emit({ sessionId: r.sessionId, type: 'state', state: 'ready' })
    return { agentName: 'Fake', permissionMode: null, agentSessionId: r.agentSessionId }
  }
  async prompt(_id: string, text: string) {
    this.prompts.push(text)
    return { stopReason: 'end_turn' }
  }
  async cancel() {}
  async stop() {}
  async stopAll() {
    this.stoppedAll++
  }
  respondPermission() {}
  write(id: string, data: string) {
    this.writes.push([id, data])
  }
  resize() {}
  subscribe(l: AgentEventListener) {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  emit(e: AgentEvent) {
    for (const l of this.listeners) l(e)
  }
}

function services(said: string): SessionServices & { native: FakeRuntime; terminal: FakeRuntime; claude: SessionHistorySource; transcript: TranscriptReader } {
  const native = new FakeRuntime('native')
  const terminal = new FakeRuntime('terminal')
  const claude: SessionHistorySource = { list: async () => [], messages: vi.fn(async () => [{ kind: 'user' as const, text: said }]) }
  const transcript: TranscriptReader = { id: 'claude', read: vi.fn(async () => null), exists: vi.fn(async () => true), forget: () => {} }
  return { runtimes: { native }, terminal, transcripts: [transcript], history: { claude }, native, claude, transcript }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function setup(hostFor?: (target: HostTarget) => SessionServices) {
  const local = services('on this computer')
  const events: AgentEvent[] = []
  const manager = new SessionManager({
    config: { current: async () => emptyConfig(), replaceSessionIdentity: async () => undefined } as unknown as ConfigurationService,
    ...local,
    ...(hostFor ? { hostFor } : {}),
    emitEvent: (e) => events.push(e),
    emitChanged: () => {},
    emitReplay: () => {},
    pollMs: 60_000
  })
  return { manager, local, events }
}

describe('SessionManager: services per host', () => {
  it('runs every session on the services it was given when no host resolver is set', async () => {
    const { manager, local } = setup()
    const view = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api' })
    await flush()
    await manager.prompt(view.id, 'hello')
    expect(local.native.started).toHaveLength(1)
    expect(local.native.prompts).toEqual(['hello'])
    expect(manager.list()[0]!.state).toBe('ready')
  })

  it('starts, prompts, reads history and transcripts and writes terminals on the host the resolver picks', async () => {
    const remote = services('on the other host')
    const asked: HostTarget[] = []
    const { manager, local, events } = setup((target) => {
      asked.push(target)
      return target.profileId === 'elsewhere' ? remote : local
    })
    const here = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api' })
    const there = await manager.start({ profileId: 'elsewhere', agentKey: 'claude', cwd: '/w/acme/web', resumeAgentSessionId: 'abc' })
    await flush()
    expect(asked).toEqual([{ profileId: null }, { profileId: 'elsewhere' }])
    expect(local.native.started.map((r) => r.sessionId)).toEqual([here.id])
    expect(remote.native.started.map((r) => r.sessionId)).toEqual([there.id])
    // The other host's runtime is subscribed: its events reach the session.
    expect(events.some((e) => e.sessionId === there.id && e.type === 'state')).toBe(true)
    expect(manager.list().find((v) => v.id === there.id)!.state).toBe('ready')

    await manager.prompt(there.id, 'over there')
    expect(remote.native.prompts).toEqual(['over there'])
    expect(local.native.prompts).toEqual([])

    expect(await manager.history(there.id)).toEqual([{ kind: 'user', text: 'on the other host' }])
    expect(remote.transcript.exists).toHaveBeenCalled()
    expect(local.transcript.exists).not.toHaveBeenCalled()

    manager.write(`${there.id}:shell`, 'ls\r')
    manager.write(`${here.id}:shell`, 'pwd\r')
    expect(remote.terminal.writes).toEqual([[`${there.id}:shell`, 'ls\r']])
    expect(local.terminal.writes).toEqual([[`${here.id}:shell`, 'pwd\r']])

    await manager.stopAll()
    expect([local.native.stoppedAll, local.terminal.stoppedAll, remote.native.stoppedAll, remote.terminal.stoppedAll]).toEqual([1, 1, 1, 1])
  })
})

describe('HostRegistry', () => {
  const execution = {} as ExecutionServices

  it('resolves every profile to the local host for now', () => {
    const hosts = new HostRegistry(localHost(execution))
    hosts.register({ ...localHost(execution), id: 'wsl:dev' })
    expect(hosts.hostFor({ profileId: 'any' })).toBe(hosts.local)
    expect(hosts.hostFor({ profileId: null }).id).toBe('local')
    expect(hosts.get('wsl:dev')?.id).toBe('wsl:dev')
  })

  it('keeps the local host fixed', () => {
    const hosts = new HostRegistry(localHost(execution))
    expect(() => hosts.register(localHost(execution))).toThrow()
    expect(() => new HostRegistry({ ...localHost(execution), id: 'other' })).toThrow()
  })
})

describe('the local host folder facade', () => {
  it("runs the composition's git and looks at this computer's disk", async () => {
    const git: GitRunner = vi.fn(async () => ({ ok: true, stdout: 'x', stderr: '' }))
    const host = localHost({ git } as unknown as ExecutionServices)
    await host.git('/w/acme', ['status'])
    expect(git).toHaveBeenCalledWith('/w/acme', ['status'])
    const dir = mkdtempSync(join(tmpdir(), 'workhub-host-'))
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'hello')
    expect(await host.exists(file)).toBe(true)
    expect(await host.exists(join(dir, 'missing'))).toBe(false)
    expect(await host.stat(file)).toMatchObject({ size: 5, isFile: true, isDirectory: false })
    expect(await host.stat(dir)).toMatchObject({ isFile: false, isDirectory: true })
    expect(await host.stat(join(dir, 'missing'))).toBeNull()
  })

  it("reads a folder's origin through the host's git", async () => {
    const git: GitRunner = vi.fn(async (cwd: string) => (cwd === '/w/acme' ? { ok: true, stdout: 'git@github.com:acme/api.git\n', stderr: '' } : { ok: false, stdout: '', stderr: 'not a git repository' }))
    expect(await originUrl(git, '/w/acme')).toBe('git@github.com:acme/api.git')
    expect(await originUrl(git, '/w/notes')).toBeNull()
    expect(git).toHaveBeenCalledWith('/w/acme', ['remote', 'get-url', 'origin'], { timeoutMs: 10_000 })
  })
})
