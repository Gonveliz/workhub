// A pushed notification travels sealed to the device, but a sealed box does not say who made it:
// the relay knows every device's public keys. The desktop signs the payload, and the device
// checks the signature against the desktop it paired with before showing anything.
import { encodeJson, fromBase64Url, toBase64Url } from './bytes'
import { sign, verify, type Identity, type PublicIdentity } from './identity'
import type { PermissionAnswer, PushAsk, PushPayload, UnsignedPermissionAnswer, UnsignedPushPayload } from './messages'

/** At most this old (or this far in the future) to be shown: a relay cannot replay last week's. */
export const PUSH_MAX_AGE_MS = 10 * 60_000

function payloadBytes(payload: UnsignedPushPayload): Uint8Array {
  // A fixed field order, so both ends sign the same bytes whatever the JSON looked like.
  return encodeJson(['workhub-remote/push', payload.v, payload.desktop, payload.kind, payload.title, payload.body, payload.ts, payload.route ?? null, payload.tag ?? null])
}

export function signPushPayload(desktop: Identity, payload: UnsignedPushPayload): PushPayload {
  return { ...payload, sig: toBase64Url(sign(desktop, payloadBytes(payload))) }
}

/** Whether the desktop named in the payload signed it, and it is recent. */
export function verifyPushPayload(payload: PushPayload, desktop: PublicIdentity, now = Date.now(), maxAgeMs = PUSH_MAX_AGE_MS): boolean {
  if (Math.abs(now - payload.ts) > maxAgeMs) return false
  const { sig, ask: _ask, ...rest } = payload
  try {
    return verify(desktop, payloadBytes(rest), fromBase64Url(sig))
  } catch {
    return false
  }
}

/** The ask is bound to the payload it rides in (its desktop and time) and to the device it was made for. */
function askBytes(payload: Pick<PushPayload, 'desktop' | 'ts'>, device: string, ask: Omit<PushAsk, 'sig'>): Uint8Array {
  return encodeJson(['workhub-remote/push-ask', payload.desktop, device, payload.ts, ask.session, ask.request, ask.ticket, [...ask.answers]])
}

/** Adds the request a notification may answer, signed apart so a phone that ignores `ask` still verifies the payload. */
export function signPushAsk(desktop: Identity, payload: PushPayload, device: string, ask: Omit<PushAsk, 'sig'>): PushPayload {
  return { ...payload, ask: { ...ask, sig: toBase64Url(sign(desktop, askBytes(payload, device, ask))) } }
}

/** Whether the payload's ask was signed by its desktop for this device (check the payload itself with `verifyPushPayload`). */
export function verifyPushAsk(payload: PushPayload, desktop: PublicIdentity, device: string): boolean {
  const ask = payload.ask
  if (!ask) return false
  const { sig, ...rest } = ask
  try {
    return verify(desktop, askBytes(payload, device, rest), fromBase64Url(sig))
  } catch {
    return false
  }
}

function answerBytes(answer: UnsignedPermissionAnswer): Uint8Array {
  return encodeJson(['workhub-remote/permission-answer', answer.v, answer.desktop, answer.device, answer.session, answer.request, answer.ticket, answer.answer, answer.ts])
}

/** The device's answer to a notification's request, signed with its own key. */
export function signPermissionAnswer(device: Identity, answer: UnsignedPermissionAnswer): PermissionAnswer {
  return { ...answer, sig: toBase64Url(sign(device, answerBytes(answer))) }
}

/** Whether the device signed this answer, and it is recent (a captured one cannot be sent again later). */
export function verifyPermissionAnswer(answer: PermissionAnswer, device: PublicIdentity, now = Date.now(), maxAgeMs = PUSH_MAX_AGE_MS): boolean {
  if (Math.abs(now - answer.ts) > maxAgeMs) return false
  const { sig, ...rest } = answer
  try {
    return verify(device, answerBytes(rest), fromBase64Url(sig))
  } catch {
    return false
  }
}
