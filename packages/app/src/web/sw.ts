/// <reference lib="webworker" />
// The service worker: opens pushed notifications (sealed to this device's key by the desktop) and
// shows them; a tap opens the app on the session the notification is about. A notification about
// a waiting permission request may carry buttons ("Deny"); a tap on one answers it without
// opening the app (notification-answer.ts). Nothing is cached here: the app is small and the relay
// serves it with its own cache headers.
import { decodeJson, fromBase64Url, identityFromSeed, isPublicIdentity, openBox, parsePushPayload, verifyPushAsk, verifyPushPayload, type PublicIdentity } from '@workhub/protocol'
import { webEn } from '../renderer/i18n/web.en'
import { webEs } from '../renderer/i18n/web.es'
import { DESKTOPS_KEY, kvGet, LOCALE_KEY, RELAYS_KEY, SEED_KEY } from './kv'
import { answerMessage, askOf, notificationActions, readAsk, sendAnswer, tapOutcome, type AnswerResult, type NotificationAsk } from './notification-answer'

declare const self: ServiceWorkerGlobalScope

self.addEventListener('install', () => void self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  event.waitUntil(showPushed(event.data?.text() ?? ''))
})

/** The worker's texts in the phone's language (the page mirrors it to IndexedDB). */
async function texts(): Promise<Record<keyof typeof webEn, string>> {
  return (await kvGet(LOCALE_KEY).catch(() => null)) === 'es' ? webEs : webEn
}

/** How many buttons this browser draws on a notification; 0 where it draws none (iOS, Safari, Firefox). */
function maxActions(): number {
  const n = (self as unknown as { Notification?: { maxActions?: number } }).Notification?.maxActions
  return typeof n === 'number' ? n : 0
}

async function showPushed(text: string): Promise<void> {
  let box: { e: string; c: string } | null = null
  try {
    const parsed = JSON.parse(text) as { box?: { e?: unknown; c?: unknown } }
    if (typeof parsed.box?.e === 'string' && typeof parsed.box.c === 'string') box = { e: parsed.box.e, c: parsed.box.c }
  } catch {
    return
  }
  if (!box) return
  const seed = await kvGet(SEED_KEY)
  if (!seed) return
  const identity = identityFromSeed(fromBase64Url(seed))
  const plain = openBox(identity, box)
  if (!plain) return
  let payload: ReturnType<typeof parsePushPayload> = null
  try {
    payload = parsePushPayload(decodeJson(plain))
  } catch {
    return
  }
  if (!payload) return
  // Only a desktop this phone paired with may notify it: the relay holds the phone's public key
  // and could seal a box of its own, but it cannot sign as the desktop.
  const desktop = await pairedDesktop(payload.desktop)
  if (!desktop || !verifyPushPayload(payload, desktop, Date.now())) return
  // Buttons only for a request the desktop signed for this very device.
  const ask = payload.ask && verifyPushAsk(payload, desktop, identity.id) ? askOf(payload) : undefined
  const t = await texts()
  const actions = notificationActions(ask, maxActions(), { allow: t['web.push.allow'], deny: t['web.push.deny'] })
  const route = `#d/${payload.desktop}/${(payload.route ?? '#').replace(/^#\/?/, '')}`
  await self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: '/icons/icon-256.png',
    badge: '/icons/icon-256.png',
    ...(payload.tag ? { tag: payload.tag } : {}),
    ...(actions.length ? { actions } : {}),
    data: { route, ts: payload.ts, ...(actions.length ? { ask } : {}) }
  } as NotificationOptions)
}

async function readMap(key: string): Promise<Record<string, unknown> | null> {
  const raw = await kvGet(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

async function pairedDesktop(id: string): Promise<PublicIdentity | null> {
  const pub = (await readMap(DESKTOPS_KEY))?.[id]
  return isPublicIdentity(pub) ? pub : null
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data as { route?: unknown; ask?: unknown } | undefined
  const route = typeof data?.route === 'string' ? data.route : '#'
  const outcome = tapOutcome(event.action, readAsk(data?.ask), Date.now())
  if (outcome.kind === 'open') event.waitUntil(openApp(route))
  else event.waitUntil(answer(outcome.ask, outcome.answer, event.notification.title, route))
})

/** Sends the answer through the relay; when it did not apply, says so in a notification whose tap opens the session. */
async function answer(ask: NotificationAsk, choice: NotificationAsk['answers'][number], title: string, route: string): Promise<void> {
  const result = await sendFromWorker(ask, choice)
  if (result === 'ok') return
  const t = await texts()
  const body = result === 'gone' ? t['web.push.answerGone'] : result === 'unreachable' ? t['web.push.answerUnreachable'] : t['web.push.answerExpired']
  await self.registration.showNotification(title, { body, icon: '/icons/icon-256.png', badge: '/icons/icon-256.png', tag: `answer:${ask.session}`, data: { route } })
}

async function sendFromWorker(ask: NotificationAsk, choice: NotificationAsk['answers'][number]): Promise<AnswerResult> {
  if (typeof WebSocket === 'undefined') return 'unreachable'
  const seed = await kvGet(SEED_KEY)
  const desktop = await pairedDesktop(ask.desktop)
  const relay = (await readMap(RELAYS_KEY))?.[ask.desktop]
  if (!seed || !desktop || typeof relay !== 'string') return 'unreachable'
  const me = identityFromSeed(fromBase64Url(seed))
  return sendAnswer({ connect: (url) => new WebSocket(url), relay, me, desktop, desktopId: ask.desktop, answer: answerMessage(me, ask, choice, Date.now()) })
}

async function openApp(route: string): Promise<void> {
  const url = new URL(`/${route.startsWith('#') ? route : `#${route}`}`, self.location.origin).href
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const existing = clients[0]
  if (existing) {
    await existing.focus()
    if ('navigate' in existing) await existing.navigate(url)
    return
  }
  await self.clients.openWindow(url)
}
