// Answering a permission request from a phone's notification. A pushed notification about a
// waiting request carries a one-time ticket made for that device and that request; the phone's
// service worker sends it back with the answer, sealed to the desktop and signed with the
// device's key, over a short relay connection of its own (it has no channel). The desktop applies
// the answer only when every check here holds.
import { rejectOption } from '@workhub/core'
import { parsePermissionAnswer, PUSH_MAX_AGE_MS, randomBytes, toBase64Url, verifyPermissionAnswer, type NotificationAnswer, type PermissionAnswerRefusal, type PublicIdentity, type PushAsk } from '@workhub/protocol'
import type { PendingPermission } from '../../shared/api'

/** Tickets kept at once; the oldest go first (a ticket lives ten minutes anyway). */
export const MAX_PERMISSION_TICKETS = 200

interface Ticket {
  deviceId: string
  session: string
  request: string
  answers: readonly NotificationAnswer[]
  expiresAt: number
}

/**
 * What a notification may offer for a request. Never "Allow": the permission request model does
 * not say which requests are dangerous (a command that deletes, a push), so allowing stays in the
 * app, where the person sees the whole request. "Deny" needs a reject option, and a question with
 * choices is answered in the chat.
 */
export function notificationAnswers(request: PendingPermission): NotificationAnswer[] {
  if (request.questions?.length) return []
  return rejectOption(request.options) ? ['deny'] : []
}

export type TicketVerdict = { ok: true; session: string; request: string; optionId: string; ticket: string } | { ok: false; reason: PermissionAnswerRefusal; ticket?: string }

export class PermissionTickets {
  private readonly open = new Map<string, Ticket>()

  /**
   * The ask a push to `deviceId` carries for a session's waiting request, or null when the
   * notification cannot answer it: none or several requests wait (the notification names one;
   * which of several would be a guess), or nothing may be answered from outside the app.
   */
  issue(deviceId: string, sessionId: string, pending: readonly PendingPermission[], at: number): Omit<PushAsk, 'sig'> | null {
    if (pending.length !== 1) return null
    const request = pending[0]!
    const answers = notificationAnswers(request)
    if (answers.length === 0) return null
    this.prune(at)
    const ticket = toBase64Url(randomBytes(32))
    this.open.set(ticket, { deviceId, session: sessionId, request: request.requestId, answers, expiresAt: at + PUSH_MAX_AGE_MS })
    while (this.open.size > MAX_PERMISSION_TICKETS) this.open.delete(this.open.keys().next().value!)
    return { session: sessionId, request: request.requestId, ticket, answers }
  }

  /**
   * Checks an answer a device sent: it parses and is signed by that device for this desktop, its
   * ticket was made for that device and request and is neither used nor older than a push may be,
   * the answer was offered, and the request still waits. A ticket is used by the first answer
   * that names it, whatever the outcome, so a replay finds nothing.
   */
  redeem(desktopId: string, device: { id: string; public: PublicIdentity }, value: unknown, now: number, pendingOf: (sessionId: string) => readonly PendingPermission[]): TicketVerdict {
    const answer = parsePermissionAnswer(value)
    if (!answer) return { ok: false, reason: 'refused' }
    // The signature first (checked at the answer's own time), so a forged answer cannot use up a ticket; then its age.
    if (answer.device !== device.id || answer.desktop !== desktopId || !verifyPermissionAnswer(answer, device.public, answer.ts)) return { ok: false, reason: 'refused', ticket: answer.ticket }
    if (Math.abs(now - answer.ts) > PUSH_MAX_AGE_MS) return { ok: false, reason: 'expired', ticket: answer.ticket }
    const ticket = this.open.get(answer.ticket)
    // Another device's ticket is not touched: it stays usable by the device it was made for.
    if (ticket && ticket.deviceId !== device.id) return { ok: false, reason: 'refused', ticket: answer.ticket }
    this.open.delete(answer.ticket)
    if (!ticket || ticket.expiresAt < now) return { ok: false, reason: 'expired', ticket: answer.ticket }
    if (ticket.session !== answer.session || ticket.request !== answer.request || !ticket.answers.includes(answer.answer)) return { ok: false, reason: 'refused', ticket: answer.ticket }
    const request = pendingOf(answer.session).find((p) => p.requestId === answer.request)
    if (!request) return { ok: false, reason: 'gone', ticket: answer.ticket }
    // Read again from the request as it waits now, not from what the ticket was made with.
    if (!notificationAnswers(request).includes(answer.answer)) return { ok: false, reason: 'refused', ticket: answer.ticket }
    const optionId = rejectOption(request.options)
    if (answer.answer !== 'deny' || !optionId) return { ok: false, reason: 'refused', ticket: answer.ticket }
    return { ok: true, session: answer.session, request: answer.request, optionId, ticket: answer.ticket }
  }

  private prune(now: number): void {
    for (const [key, ticket] of this.open) if (ticket.expiresAt < now) this.open.delete(key)
  }
}
