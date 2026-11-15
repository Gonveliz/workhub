import { describe, expect, it } from 'vitest'
import { NO_CAPABILITIES, type SessionState } from '@workhub/core'
import { dueReminders, reminderNotifications, viewedSessions, waitingSessions } from '../src/main/permission-reminders'
import type { PendingPermission, SessionView } from '../src/shared/api'

const MIN = 60_000

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
    startedAt: 1,
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

const request = (requestId: string, at: number, over: Partial<PendingPermission> = {}): PendingPermission => ({ requestId, title: `Run ${requestId}?`, options: [], at, ...over })

describe('waitingSessions', () => {
  it('lists the sessions with an open request, dated by the oldest one, and the ones whose console asks', () => {
    const views = [
      view('a', 'busy', { pendingPermissions: [request('r2', 5_000), request('r1', 1_000, { questions: [{ question: 'Which branch?', options: [] }] })] }),
      view('b', 'ready', { consoleAsking: true, consoleAskingSince: 2_000, stateSince: 100 }),
      view('c', 'busy', { pendingPermissions: [] }),
      view('d', 'stopped', { pendingPermissions: [request('r9', 100)] }),
      view('e', 'starting', { consoleAsking: true, consoleAskingSince: 50 })
    ]
    expect(waitingSessions(views, 10_000)).toEqual([
      { id: 'a', since: 1_000, title: 'Which branch?' },
      { id: 'b', since: 2_000, title: '' }
    ])
  })
})

describe('dueReminders', () => {
  it('reminds every interval since the request, then since the last reminder', () => {
    const remindedAt = new Map<string, number>()
    const waiting = [{ id: 'a', since: 0, title: 'Run ls?' }]
    expect(dueReminders(waiting, remindedAt, 14 * MIN, 15 * MIN)).toEqual([])
    expect(dueReminders(waiting, remindedAt, 15 * MIN, 15 * MIN)).toEqual(waiting)
    expect(dueReminders(waiting, remindedAt, 20 * MIN, 15 * MIN)).toEqual([])
    expect(dueReminders(waiting, remindedAt, 30 * MIN, 15 * MIN)).toEqual(waiting)
  })

  it('forgets a session once it stops waiting, so its next request starts a new count', () => {
    const remindedAt = new Map<string, number>()
    const waiting = [{ id: 'a', since: 0, title: 'Run ls?' }]
    dueReminders(waiting, remindedAt, 15 * MIN, 15 * MIN)
    expect(remindedAt.has('a')).toBe(true)
    dueReminders([], remindedAt, 16 * MIN, 15 * MIN)
    expect(remindedAt.has('a')).toBe(false)
    // A new request at minute 20 is not due at minute 30 (its own count started at 20).
    expect(dueReminders([{ id: 'a', since: 20 * MIN, title: 'Run rm?' }], remindedAt, 30 * MIN, 15 * MIN)).toEqual([])
  })

  it('an interval of 0 turns reminders off', () => {
    const remindedAt = new Map<string, number>()
    expect(dueReminders([{ id: 'a', since: 0, title: 'Run ls?' }], remindedAt, 60 * MIN, 0)).toEqual([])
    expect(remindedAt.size).toBe(0)
  })
})

describe('reminderNotifications', () => {
  const t = (key: string, params?: Record<string, string | number>) => `${key}(${params?.minutes ?? ''})`
  const views = [
    view('chat', 'busy', { name: 'Fix login', pendingPermissions: [request('r1', 0)] }),
    view('console', 'ready', { agentTitle: 'Console run', consoleAsking: true, consoleAskingSince: 0 }),
    view('reviewer', 'busy', { readOnly: true, pendingPermissions: [request('r2', 0)] })
  ]

  it('words chat and console reminders, skips reviewer sessions and the one on screen', () => {
    const remindedAt = new Map<string, number>()
    const out = reminderNotifications({ views, remindedAt, now: 15 * MIN, intervalMinutes: 15, viewing: [], t })
    expect(out).toEqual([
      { title: 'Fix login', body: 'notify.needsAnswerReminder(15): Run r1?', sessionId: 'chat', kind: 'needsAnswer' },
      { title: 'Console run', body: 'notify.needsAnswerReminderConsole(15)', sessionId: 'console', kind: 'needsAnswer' }
    ])
    // Looking at the chat: no reminder for it, and its count starts again now.
    const again = new Map<string, number>()
    expect(reminderNotifications({ views, remindedAt: again, now: 15 * MIN, intervalMinutes: 15, viewing: ['chat'], t }).map((n) => n.sessionId)).toEqual(['console'])
    expect(again.get('chat')).toBe(15 * MIN)
  })

  it('just left the session on screen: no reminder until a full interval has passed', () => {
    const remindedAt = new Map<string, number>()
    const ids = (now: number, viewing: string[]) => reminderNotifications({ views, remindedAt, now, intervalMinutes: 15, viewing, t }).map((n) => n.sessionId)
    expect(ids(20 * MIN, ['chat', 'console'])).toEqual([])
    // Left both a minute later: the request is 21 minutes old, but they were just looked at.
    expect(ids(21 * MIN, [])).toEqual([])
    expect(ids(34 * MIN, [])).toEqual([])
    expect(ids(35 * MIN, [])).toEqual(['chat', 'console'])
  })

  it('a hidden or unfocused main window is not looking: the reminder fires', () => {
    const viewing = viewedSessions({ visible: false, focused: false, session: 'chat' }, null)
    expect(viewing).toEqual([])
    expect(viewedSessions({ visible: true, focused: false, session: 'chat' }, null)).toEqual([])
    expect(reminderNotifications({ views, remindedAt: new Map(), now: 15 * MIN, intervalMinutes: 15, viewing, t }).map((n) => n.sessionId)).toEqual(['chat', 'console'])
  })

  it('the main window visible and focused, or a focused session window, is looking', () => {
    expect(viewedSessions({ visible: true, focused: true, session: 'chat' }, null)).toEqual(['chat'])
    expect(viewedSessions({ visible: false, focused: false, session: 'chat' }, 'console')).toEqual(['console'])
    expect(viewedSessions({ visible: true, focused: true, session: 'chat' }, 'chat')).toEqual(['chat'])
    const viewing = viewedSessions({ visible: false, focused: false, session: null }, 'chat')
    expect(reminderNotifications({ views, remindedAt: new Map(), now: 15 * MIN, intervalMinutes: 15, viewing, t }).map((n) => n.sessionId)).toEqual(['console'])
  })

  it('an interval of 0 (reminders or the needs-answer switch off) sends nothing', () => {
    expect(reminderNotifications({ views, remindedAt: new Map(), now: 60 * MIN, intervalMinutes: 0, viewing: [], t })).toEqual([])
  })
})
