import type { SessionNotification, SessionView } from '../shared/api'

/** A session that still waits for the user, and since when (the oldest open request, or the console's prompt). */
export interface WaitingSession {
  id: string
  since: number
  /** The first open request's title or question, when the chat asked; empty for a console prompt. */
  title: string
}

/** The sessions whose chat has an open permission request or question, or whose console asked for one. */
export function waitingSessions(views: readonly SessionView[], now: number): WaitingSession[] {
  const out: WaitingSession[] = []
  for (const v of views) {
    if (v.state !== 'ready' && v.state !== 'busy') continue
    const pending = v.pendingPermissions ?? []
    if (pending.length) {
      const first = pending.reduce((a, b) => (b.at < a.at ? b : a))
      out.push({ id: v.id, since: first.at, title: first.questions?.[0]?.question ?? first.title })
    } else if (v.consoleAsking) {
      out.push({ id: v.id, since: v.consoleAskingSince ?? now, title: '' })
    }
  }
  return out
}

/**
 * Which waiting sessions are due a reminder: every `intervalMs` since the request (or since the
 * last reminder). `remindedAt` is updated for the sessions returned and forgotten for the ones
 * that no longer wait, so a new request later starts its own count. `intervalMs <= 0` turns
 * reminders off.
 */
export function dueReminders(waiting: readonly WaitingSession[], remindedAt: Map<string, number>, now: number, intervalMs: number): WaitingSession[] {
  const ids = new Set(waiting.map((w) => w.id))
  for (const id of [...remindedAt.keys()]) if (!ids.has(id)) remindedAt.delete(id)
  if (intervalMs <= 0) return []
  const due: WaitingSession[] = []
  for (const w of waiting) {
    const last = Math.max(w.since, remindedAt.get(w.id) ?? 0)
    if (now - last < intervalMs) continue
    remindedAt.set(w.id, now)
    due.push(w)
  }
  return due
}

export interface ReminderInput {
  views: readonly SessionView[]
  remindedAt: Map<string, number>
  now: number
  /** Minutes between reminders; 0 when they are off (or "Needs an answer" notifications are). */
  intervalMinutes: number
  /** The sessions the user is looking at (`viewedSessions`): no reminder, and their count starts again. */
  viewing: readonly string[]
  t: (key: string, params?: Record<string, string | number>) => string
}

/** The reminder notifications due now, worded in the tray's language; reviewer (read-only) sessions never remind. */
export function reminderNotifications({ views, remindedAt, now, intervalMinutes, viewing, t }: ReminderInput): SessionNotification[] {
  const waiting = waitingSessions(views, now)
  // A session on screen stays in the list (dropping it would forget its count) with its count
  // restarted now: leaving it gets a reminder only after a full interval.
  const seen = new Set(viewing)
  for (const w of waiting) if (seen.has(w.id)) remindedAt.set(w.id, now)
  const out: SessionNotification[] = []
  for (const w of dueReminders(waiting, remindedAt, now, intervalMinutes * 60_000)) {
    const view = views.find((v) => v.id === w.id)
    if (!view || view.readOnly) continue
    const minutes = Math.max(1, Math.round((now - w.since) / 60_000))
    const body = w.title ? `${t('notify.needsAnswerReminder', { minutes })}: ${w.title}` : t('notify.needsAnswerReminderConsole', { minutes })
    out.push({ title: view.name ?? view.agentTitle ?? view.label, body, sessionId: w.id, kind: 'needsAnswer' })
  }
  return out
}

/**
 * The sessions the user is looking at: the main window's session only while that window is
 * visible and focused (a hidden or background window is not looked at), and the session of a
 * focused separate session window.
 */
export function viewedSessions(main: { visible: boolean; focused: boolean; session: string | null }, focusedSessionWindow: string | null): string[] {
  const out: string[] = []
  if (main.visible && main.focused && main.session) out.push(main.session)
  if (focusedSessionWindow && !out.includes(focusedSessionWindow)) out.push(focusedSessionWindow)
  return out
}
