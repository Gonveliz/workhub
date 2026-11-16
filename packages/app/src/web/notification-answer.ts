// What the service worker does with a notification that can answer a permission request: which
// buttons it shows, what a tap on one sends, and the short relay connection that sends it. The
// worker has no channel to the desktop, so the answer goes as one sealed box, signed with this
// device's key, carrying the one-time ticket the desktop put in the push (see
// main/remote/permission-tickets.ts). No DOM here: the worker and the tests share it.
import {
  decodeJson,
  encodeJson,
  makeAuth,
  openBox,
  parsePermissionAnswered,
  parseRelayMessage,
  PUSH_MAX_AGE_MS,
  sealBox,
  signPermissionAnswer,
  type Identity,
  type NotificationAnswer,
  type PermissionAnswer,
  type PermissionAnswerRefusal,
  type PublicIdentity,
  type PushPayload
} from '@workhub/protocol'
import type { WebSocketLike } from './remote-client'

/** What a notification keeps (in its `data`) to answer from a tap on one of its buttons. */
export interface NotificationAsk {
  desktop: string
  session: string
  request: string
  ticket: string
  answers: NotificationAnswer[]
  /** When the desktop sent the notification: one left in the tray too long answers nothing. */
  ts: number
}

export interface NotificationAction {
  action: NotificationAnswer
  title: string
}

/** The texts the worker needs, in the phone's language. */
export interface AnswerTexts {
  allow: string
  deny: string
}

/** Buttons shown in this order, at most as many as the platform draws. */
const ORDER: readonly NotificationAnswer[] = ['allow', 'deny']

/** The ask a verified payload carries, as the notification keeps it. */
export function askOf(payload: PushPayload): NotificationAsk | undefined {
  const ask = payload.ask
  return ask ? { desktop: payload.desktop, session: ask.session, request: ask.request, ticket: ask.ticket, answers: [...ask.answers], ts: payload.ts } : undefined
}

/**
 * The buttons a notification gets: the answers the desktop offered, only where the platform
 * draws buttons (`Notification.maxActions` above 0). Elsewhere none, and the notification behaves
 * as one without an ask: a tap opens the session.
 */
export function notificationActions(ask: NotificationAsk | undefined, maxActions: number | undefined, text: AnswerTexts): NotificationAction[] {
  if (!ask || !maxActions || maxActions < 1) return []
  return ORDER.filter((a) => ask.answers.includes(a))
    .slice(0, maxActions)
    .map((action) => ({ action, title: text[action] }))
}

/** Reads back the ask a notification kept; anything malformed is none. */
export function readAsk(value: unknown): NotificationAsk | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const strings = ['desktop', 'session', 'request', 'ticket'].every((k) => typeof v[k] === 'string')
  const answers = Array.isArray(v['answers']) && v['answers'].every((a) => a === 'allow' || a === 'deny') ? (v['answers'] as NotificationAnswer[]) : null
  if (!strings || !answers || typeof v['ts'] !== 'number') return undefined
  return { desktop: v['desktop'] as string, session: v['session'] as string, request: v['request'] as string, ticket: v['ticket'] as string, answers, ts: v['ts'] }
}

export type TapOutcome = { kind: 'open' } | { kind: 'answer'; answer: NotificationAnswer; ask: NotificationAsk }

/**
 * What a tap does. The body (no action), a button the desktop did not offer, or a notification
 * older than a push may be, opens the session as before; a button it offered answers.
 */
export function tapOutcome(action: string, ask: NotificationAsk | undefined, now: number): TapOutcome {
  if (!action || !ask) return { kind: 'open' }
  const answer = ask.answers.find((a) => a === action)
  if (!answer) return { kind: 'open' }
  if (Math.abs(now - ask.ts) > PUSH_MAX_AGE_MS) return { kind: 'open' }
  return { kind: 'answer', answer, ask }
}

/** The answer a tap sends: signed with this device's key, naming the exact request and its ticket. */
export function answerMessage(me: Identity, ask: NotificationAsk, answer: NotificationAnswer, now: number): PermissionAnswer {
  return signPermissionAnswer(me, { t: 'permission-answer', v: 1, desktop: ask.desktop, device: me.id, session: ask.session, request: ask.request, ticket: ask.ticket, answer, ts: now })
}

export type AnswerResult = 'ok' | PermissionAnswerRefusal | 'unreachable'

export interface SendAnswerOptions {
  connect: (url: string) => WebSocketLike
  /** The relay's WebSocket URL the desktop was paired through. */
  relay: string
  me: Identity
  desktop: PublicIdentity
  desktopId: string
  answer: PermissionAnswer
  now?: () => number
  /** How long to wait for the desktop's reply (a worker is kept alive only so long). */
  timeoutMs?: number
}

export const ANSWER_TIMEOUT_MS = 15_000

/**
 * Sends one answer over a connection of its own: authenticate with this device's identity, join
 * the desktop's room, send the sealed answer, wait for the desktop's reply about that ticket, and
 * close. The page's own connection, if any, is not touched: the desktop keeps its channel.
 */
export function sendAnswer(o: SendAnswerOptions): Promise<AnswerResult> {
  const now = o.now ?? Date.now
  return new Promise((resolve) => {
    let socket: WebSocketLike | null = null
    let done = false
    const finish = (result: AnswerResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        socket?.close(1000, 'done')
      } catch {
        // Already gone.
      }
      resolve(result)
    }
    const timer = setTimeout(() => finish('unreachable'), o.timeoutMs ?? ANSWER_TIMEOUT_MS)
    const send = (message: unknown) => {
      try {
        socket?.send(JSON.stringify(message))
      } catch {
        finish('unreachable')
      }
    }
    try {
      socket = o.connect(o.relay)
    } catch {
      finish('unreachable')
      return
    }
    socket.onopen = () => {}
    socket.onerror = () => {}
    socket.onclose = () => finish('unreachable')
    socket.onmessage = (ev: { data: unknown }) => {
      let message
      try {
        message = parseRelayMessage(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)))
      } catch {
        return
      }
      if (!message) return
      switch (message.t) {
        case 'challenge':
          return send(makeAuth(o.me, message.nonce, now()))
        case 'welcome':
          return send({ t: 'join', room: o.desktopId })
        case 'joined': {
          if (!message.peers.includes(o.desktopId)) return finish('unreachable')
          const box = sealBox(o.desktop, encodeJson(o.answer))
          return send({ t: 'to', room: o.desktopId, to: o.desktopId, body: { k: 'box', e: box.e, c: box.c } })
        }
        case 'from': {
          if (message.from !== o.desktopId || message.body.k !== 'box') return
          const plain = openBox(o.me, { e: message.body.e, c: message.body.c })
          if (!plain) return
          let reply
          try {
            reply = parsePermissionAnswered(decodeJson(plain))
          } catch {
            return
          }
          // The ticket is known only to this device and the desktop: a reply naming it is the desktop's.
          if (!reply || reply.ticket !== o.answer.ticket) return
          return finish(reply.ok ? 'ok' : (reply.reason ?? 'refused'))
        }
        case 'error':
          if (message.code === 'offline' || message.code === 'bad-auth' || message.code === 'not-joined') finish('unreachable')
          return
        default:
          return
      }
    }
  })
}
