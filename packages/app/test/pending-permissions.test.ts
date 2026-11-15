import { beforeEach, describe, expect, it } from 'vitest'
import { NO_CAPABILITIES, type AgentEvent, type SessionState } from '@workhub/core'
import type { PendingPermission, SessionView } from '../src/shared/api'
import { ANSWERED_ELSEWHERE, awaitingAnswer, getSessions, markPermission, onAttention, onChanged, onEvent, reconcilePending, setViewing, type ChatItem, type SessionData } from '../src/renderer/store'
import { answerText, openRequests } from '../src/renderer/screens/sessions/PermissionCard'

let counter = 0
function view(id: string, state: SessionState, over: Partial<SessionView> = {}): SessionView {
  return {
    id,
    identity: `identity-${id}`,
    agentId: 'claude',
    accountId: null,
    profileId: null,
    cwd: '/tmp/demo',
    state,
    permissionMode: null,
    startedAt: ++counter,
    label: 'Claude',
    agentName: 'Claude',
    adapter: 'native',
    capabilities: NO_CAPABILITIES,
    screens: [],
    modes: ['app'],
    mode: 'app',
    shellRunning: false,
    controls: false,
    ...over
  }
}

const request = (requestId: string, at = 1_000): PendingPermission => ({ requestId, title: `Run ${requestId}?`, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }], at })
const permissions = (s: SessionData) => s.items.filter((i): i is Extract<ChatItem, { kind: 'permission' }> => i.kind === 'permission')

beforeEach(() => {
  setViewing(null)
  // Sessions from other tests stay in the store; each test uses its own id.
})

describe('reconcilePending', () => {
  const base = (items: ChatItem[] = []): SessionData => ({ view: view('x', 'busy'), items, monitor: {} })

  it('appends the requests the chat never saw, keeping their time', () => {
    const next = reconcilePending(base(), [request('r1', 123)])
    expect(permissions(next)).toMatchObject([{ requestId: 'r1', title: 'Run r1?', at: 123 }])
    expect(permissions(next)[0]!.answer).toBeUndefined()
    expect(next.awaiting).toBe(true)
  })

  it('an open item gone from main was answered elsewhere when main says so, else withdrawn', () => {
    const item = (): ChatItem => ({ id: 1, kind: 'permission', requestId: 'r1', title: 'Run r1?', options: [] })
    const answered = reconcilePending(base([item()]), [], ['r1'])
    expect(permissions(answered)[0]!.answer).toBe(ANSWERED_ELSEWHERE)
    expect(answered.awaiting).toBe(false)
    const withdrawn = reconcilePending(base([item()]), [], [])
    expect(permissions(withdrawn)[0]!.answer).toBe('—')
  })

  it('an answer marked here that main never got is reopened after the grace period', () => {
    const now = 100_000
    const local = (answeredAt: number): ChatItem => ({ id: 1, kind: 'permission', requestId: 'r1', title: 'Run r1?', options: [], answer: 'Allow', answeredAt })
    expect(permissions(reconcilePending(base([local(now - 2_000)]), [request('r1')], [], now))[0]!.answer).toBe('Allow')
    const reopened = reconcilePending(base([local(now - 11_000)]), [request('r1')], [], now)
    expect(permissions(reopened)[0]!.answer).toBeUndefined()
    expect(reopened.awaiting).toBe(true)
  })

  it('returns the same data when nothing changed, and leaves answered items alone', () => {
    const s = base([{ id: 1, kind: 'permission', requestId: 'r1', title: 'Run r1?', options: [], answer: 'Allow' }])
    expect(reconcilePending(s, [])).toBe(s)
    expect(reconcilePending(s, undefined)).toBe(s)
  })
})

describe('store: pending permissions follow the view', () => {
  it('a reopened window learns of the open request from the view and flags the session', () => {
    const id = 'pp-reopen'
    const kinds: string[] = []
    const off = onAttention((sid, kind) => sid === id && kinds.push(kind))
    onChanged(view(id, 'busy', { pendingPermissions: [request('r1')] }))
    const s = getSessions()[id]!
    expect(openRequests(s.items)).toHaveLength(1)
    expect(awaitingAnswer(s)).toBe(true)
    expect(kinds).toEqual(['needsAnswer'])
    off()
  })

  it('the event after the view adds no second item', () => {
    const id = 'pp-dedupe'
    onChanged(view(id, 'busy', { pendingPermissions: [request('r1')] }))
    const e: AgentEvent = { sessionId: id, type: 'permission', requestId: 'r1', title: 'Run r1?', options: [] }
    onEvent(e)
    expect(permissions(getSessions()[id]!)).toHaveLength(1)
  })

  it('a request the agent withdrew, or a stopped turn left, shows as withdrawn (main pushes the view first)', () => {
    const id = 'pp-withdrawn'
    onChanged(view(id, 'busy'))
    onEvent({ sessionId: id, type: 'permission', requestId: 'r1', title: 'Run r1?', options: [] })
    onChanged(view(id, 'busy', { pendingPermissions: [] }))
    onEvent({ sessionId: id, type: 'permissionCancelled', requestId: 'r1' })
    expect(permissions(getSessions()[id]!)[0]!.answer).toBe('—')
    onEvent({ sessionId: id, type: 'permission', requestId: 'r2', title: 'Run r2?', options: [] })
    onChanged(view(id, 'ready', { pendingPermissions: [] }))
    expect(permissions(getSessions()[id]!)[1]!.answer).toBe('—')
    expect(awaitingAnswer(getSessions()[id]!)).toBe(false)
  })

  it('a stopped session with requests still listed shows them withdrawn', () => {
    const id = 'pp-stopped'
    onChanged(view(id, 'busy', { pendingPermissions: [request('r1')] }))
    onChanged(view(id, 'stopped', { pendingPermissions: [request('r1')] }))
    expect(permissions(getSessions()[id]!)[0]!.answer).toBe('—')
    expect(awaitingAnswer(getSessions()[id]!)).toBe(false)
  })

  it('a request answered from the phone shows as answered elsewhere here', () => {
    const id = 'pp-phone'
    onChanged(view(id, 'busy'))
    onEvent({ sessionId: id, type: 'permission', requestId: 'r1', title: 'Run r1?', options: [] })
    onChanged(view(id, 'busy', { pendingPermissions: [], answeredPermissions: ['r1'] }))
    const item = permissions(getSessions()[id]!)[0]!
    expect(item.answer).toBe(ANSWERED_ELSEWHERE)
    expect(awaitingAnswer(getSessions()[id]!)).toBe(false)
  })

  it('an answer given here stays its own label when the view catches up', () => {
    const id = 'pp-local'
    onChanged(view(id, 'busy', { pendingPermissions: [request('r1')] }))
    markPermission(id, 'r1', 'Allow')
    onChanged(view(id, 'busy', { pendingPermissions: [] }))
    expect(permissions(getSessions()[id]!)[0]!.answer).toBe('Allow')
  })

  it('the console asking counts as waiting and flags the session once', () => {
    const id = 'pp-console'
    const kinds: string[] = []
    const off = onAttention((sid, kind) => sid === id && kinds.push(kind))
    onChanged(view(id, 'ready', { mode: 'console', modes: ['console'] }))
    onChanged(view(id, 'ready', { mode: 'console', modes: ['console'], consoleAsking: true }))
    expect(awaitingAnswer(getSessions()[id]!)).toBe(true)
    onChanged(view(id, 'ready', { mode: 'console', modes: ['console'], consoleAsking: true }))
    expect(kinds).toEqual(['needsAnswer'])
    onChanged(view(id, 'ready', { mode: 'console', modes: ['console'], consoleAsking: false }))
    expect(awaitingAnswer(getSessions()[id]!)).toBe(false)
    // A stopped console cannot be waiting, whatever the flag says.
    onChanged(view(id, 'stopped', { mode: 'console', modes: ['console'], consoleAsking: true }))
    expect(awaitingAnswer(getSessions()[id]!)).toBe(false)
    off()
  })
})

describe('answerText', () => {
  const t = (key: string, params?: Record<string, string | number>) => `${key}${params ? ` ${params.answer}` : ''}`
  it('words withdrawn, answered elsewhere and plain answers', () => {
    expect(answerText('—', t)).toBe('chat.permissionWithdrawn')
    expect(answerText(ANSWERED_ELSEWHERE, t)).toBe('chat.answeredElsewhere')
    expect(answerText('Allow', t)).toBe('chat.answered Allow')
  })
})
