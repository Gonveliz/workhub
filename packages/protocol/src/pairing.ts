// Pairing a device with a desktop, once. The desktop shows a QR with an offer (its identity, the
// relay, a one-time secret, an expiry). The device answers through the relay with a request that
// proves it saw the QR (an HMAC with the secret); the person confirms the device's name and
// fingerprint on the desktop, and the desktop answers with what it granted. From then on both
// ends know each other's identity and connect without pairing again.
//
// Pairing version 2 adds a code: whoever saw the QR (a screen share, a photo) knows the secret, so
// the secret alone cannot tell the person's phone from a stranger's. The desktop answers the first
// request with a fresh nonce it signs; the phone shows a 6-digit code derived from the secret, both
// identities and that nonce, and the person types it on the desktop. A stranger's device gets a
// different code, and cannot search for an identity whose code matches the person's phone: the
// nonce is chosen only after its identity is fixed, and it is signed, so a relay cannot pick it.
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { z } from 'zod'
import { decodeJson, encodeJson, equalBytes, fromBase64Url, randomBytes, toBase64Url, utf8ToBytes } from './bytes'
import { fingerprintOf, sign, verify, isPublicIdentity, type Identity, type PublicIdentity } from './identity'

const publicIdentitySchema = z.custom<PublicIdentity>(isPublicIdentity, 'a public identity')

const base64url = z.string().regex(/^[A-Za-z0-9_-]*$/)

export const pairingOfferSchema = z.object({
  v: z.literal(1),
  /** The relay's WebSocket URL (wss, or ws on a local host). */
  relay: z
    .string()
    .max(512)
    .url()
    .refine((u) => /^wss:\/\//.test(u) || /^ws:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(u), 'a wss:// relay'),
  desktop: publicIdentitySchema,
  /** What the desktop calls itself ("Ana's MacBook"). */
  name: z.string().min(1).max(80),
  /** base64url of 32 random bytes; proves the device saw this QR. */
  secret: base64url.length(43),
  /** Unix ms after which the offer is void. */
  exp: z.number().int().positive(),
  /**
   * The pairing version the desktop speaks; absent from a desktop older than the pairing code.
   * Not `v`: an older phone must still read the offer, answer it, and so let the desktop tell the
   * person to update the phone (it ignores fields it does not know).
   */
  pv: z.number().int().positive().optional()
})
export type PairingOffer = z.infer<typeof pairingOfferSchema>

export const remoteCapabilitySchema = z.enum(['sessions', 'pullRequests', 'automations', 'health', 'plan'])
export type RemoteCapability = z.infer<typeof remoteCapabilitySchema>

/** The pairing version this code speaks: 2 is the one with the pairing code. */
export const PAIRING_VERSION = 2

export const pairRequestSchema = z.object({
  /** 1 is a phone from before the pairing code: it can only be told to update. */
  v: z.union([z.literal(1), z.literal(2)]),
  device: publicIdentitySchema,
  name: z.string().min(1).max(80),
  platform: z.enum(['ios', 'android', 'web', 'other']),
  /** base64url HMAC-SHA256(secret, "workhub-remote/pair[/v2]" ‖ deviceId ‖ desktopId ‖ name ‖ platform). */
  proof: base64url.length(43)
})
export type PairRequest = z.infer<typeof pairRequestSchema>

export const pairAcceptSchema = z.object({
  v: z.literal(1),
  desktop: publicIdentitySchema,
  name: z.string().min(1).max(80),
  capabilities: z.array(remoteCapabilitySchema),
  /** base64url Ed25519 signature by the desktop over "workhub-remote/accept" ‖ deviceId ‖ desktopId ‖ capabilities ‖ name. */
  sig: base64url.length(86)
})
export type PairAccept = z.infer<typeof pairAcceptSchema>

/** The desktop's answer to the first request of a version-2 phone: what the pairing code is made with. */
export const pairChallengeSchema = z.object({
  v: z.literal(2),
  t: z.literal('code'),
  /** base64url of 32 random bytes the desktop chose after the request arrived. */
  nonce: base64url.length(43),
  /** base64url Ed25519 signature by the desktop over "workhub-remote/pair-code" ‖ deviceId ‖ desktopId ‖ exp ‖ nonce. */
  sig: base64url.length(86)
})
export type PairChallenge = z.infer<typeof pairChallengeSchema>

export const DEFAULT_OFFER_TTL_MS = 5 * 60_000

export function makePairingOffer(me: Identity, relay: string, name: string, now = Date.now(), ttlMs = DEFAULT_OFFER_TTL_MS): PairingOffer {
  return { v: 1, relay, desktop: me.public, name, secret: toBase64Url(randomBytes(32)), exp: now + ttlMs, pv: PAIRING_VERSION }
}

/** Whether the offer's desktop speaks this phone's pairing version: 'desktop' when it is older, 'phone' when newer. */
export function offerOutdated(offer: PairingOffer): 'desktop' | 'phone' | null {
  const pv = offer.pv ?? 1
  if (pv < PAIRING_VERSION) return 'desktop'
  if (pv > PAIRING_VERSION) return 'phone'
  return null
}

/** The offer as the QR carries it (base64url JSON); goes in a URL fragment so no server sees it. */
export function encodePairingOffer(offer: PairingOffer): string {
  return toBase64Url(encodeJson(offer))
}

export function decodePairingOffer(encoded: string): PairingOffer | null {
  try {
    const parsed = pairingOfferSchema.safeParse(decodeJson(fromBase64Url(encoded)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The link the QR shows: the web client, with the offer in the fragment. */
export function pairingLink(webClientUrl: string, offer: PairingOffer): string {
  const base = webClientUrl.replace(/#.*$/, '')
  return `${base}#pair=${encodePairingOffer(offer)}`
}

/** The offer in a pairing link, or null when the link has none. */
export function offerFromLink(link: string): PairingOffer | null {
  const match = /#pair=([A-Za-z0-9_-]+)/.exec(link)
  return match ? decodePairingOffer(match[1]!) : null
}

function proofBytes(offer: PairingOffer, device: PublicIdentity, name: string, platform: string, v: PairRequest['v']): Uint8Array {
  // Every field the person sees is under the HMAC: a relay cannot rename the device on the way.
  // The version is too, so a request cannot be passed off as the other version.
  const label = v === 1 ? 'workhub-remote/pair' : 'workhub-remote/pair/v2'
  return hmac(sha256, fromBase64Url(offer.secret), encodeJson([label, fingerprintOf(device), fingerprintOf(offer.desktop), name, platform]))
}

/** The phone's request. `v` is this code's version; 1 only stands in for an older phone in tests. */
export function answerPairingOffer(me: Identity, offer: PairingOffer, name: string, platform: PairRequest['platform'], v: PairRequest['v'] = PAIRING_VERSION): PairRequest {
  return { v, device: me.public, name, platform, proof: toBase64Url(proofBytes(offer, me.public, name, platform, v)) }
}

/** `outdated`: a genuine answer from a phone older than the pairing code, which must be updated first. */
export type PairRequestVerdict = { ok: true; deviceId: string } | { ok: false; reason: 'outdated'; deviceId: string } | { ok: false; reason: 'expired' | 'proof' | 'malformed' }

/** Whether a request answers this offer: made before it expired, with the secret only the QR had. */
export function verifyPairRequest(offer: PairingOffer, request: unknown, now = Date.now()): PairRequestVerdict {
  const parsed = pairRequestSchema.safeParse(request)
  if (!parsed.success) return { ok: false, reason: 'malformed' }
  if (now > offer.exp) return { ok: false, reason: 'expired' }
  let proof: Uint8Array
  try {
    proof = fromBase64Url(parsed.data.proof)
  } catch {
    return { ok: false, reason: 'proof' }
  }
  const expected = proofBytes(offer, parsed.data.device, parsed.data.name, parsed.data.platform, parsed.data.v)
  if (proof.length !== expected.length || !equalBytes(proof, expected)) return { ok: false, reason: 'proof' }
  const deviceId = fingerprintOf(parsed.data.device)
  if (parsed.data.v !== PAIRING_VERSION) return { ok: false, reason: 'outdated', deviceId }
  return { ok: true, deviceId }
}

function challengeBytes(offer: PairingOffer, device: PublicIdentity, nonce: string): Uint8Array {
  // Bound to this offer (its expiry) and this device: a challenge cannot be replayed to another phone or another QR.
  return encodeJson(['workhub-remote/pair-code', fingerprintOf(device), fingerprintOf(offer.desktop), offer.exp, nonce])
}

/** The desktop's side: a fresh nonce for the device whose request it took, signed so the relay cannot choose it. */
export function makePairChallenge(me: Identity, offer: PairingOffer, device: PublicIdentity): PairChallenge {
  const nonce = toBase64Url(randomBytes(32))
  return { v: 2, t: 'code', nonce, sig: toBase64Url(sign(me, challengeBytes(offer, device, nonce))) }
}

/** The phone's side: the challenge, when the offer's desktop signed it for this device and this offer. */
export function verifyPairChallenge(offer: PairingOffer, device: PublicIdentity, challenge: unknown): PairChallenge | null {
  const parsed = pairChallengeSchema.safeParse(challenge)
  if (!parsed.success) return null
  try {
    return verify(offer.desktop, challengeBytes(offer, device, parsed.data.nonce), fromBase64Url(parsed.data.sig)) ? parsed.data : null
  } catch {
    return null
  }
}

export const PAIRING_CODE_DIGITS = 6

/**
 * The code the phone shows and the person types on the desktop: six digits from an HMAC, keyed
 * with the offer's secret, over both identities and the desktop's nonce. Both ends compute it;
 * any other device, or any other nonce, gives another code.
 */
export function pairingCode(offer: PairingOffer, device: PublicIdentity, nonce: string): string {
  const mac = hmac(sha256, fromBase64Url(offer.secret), encodeJson(['workhub-remote/pair-code', fingerprintOf(device), fingerprintOf(offer.desktop), nonce]))
  // 32 bits reduced to a million values: the bias is under one in four thousand, far below a guess.
  const n = ((mac[0]! << 24) | (mac[1]! << 16) | (mac[2]! << 8) | mac[3]!) >>> 0
  return String(n % 10 ** PAIRING_CODE_DIGITS).padStart(PAIRING_CODE_DIGITS, '0')
}

/** Whether a typed code is the expected one: digits only (spaces dropped), compared in constant time. */
export function pairingCodeMatches(expected: string, typed: string): boolean {
  const clean = typed.replace(/\s+/g, '')
  if (!/^[0-9]+$/.test(clean)) return false
  return equalBytes(utf8ToBytes(clean), utf8ToBytes(expected))
}

function acceptBytes(device: PublicIdentity, desktop: PublicIdentity, capabilities: RemoteCapability[], name: string): Uint8Array {
  return encodeJson(['workhub-remote/accept', fingerprintOf(device), fingerprintOf(desktop), [...capabilities].sort(), name])
}

export function acceptPairing(me: Identity, device: PublicIdentity, name: string, capabilities: RemoteCapability[]): PairAccept {
  return { v: 1, desktop: me.public, name, capabilities, sig: toBase64Url(sign(me, acceptBytes(device, me.public, capabilities, name))) }
}

/** Whether an accept came from the desktop the offer named, for this device. */
export function verifyPairAccept(offer: PairingOffer, me: Identity, accept: unknown): PairAccept | null {
  const parsed = pairAcceptSchema.safeParse(accept)
  if (!parsed.success) return null
  if (fingerprintOf(parsed.data.desktop) !== fingerprintOf(offer.desktop)) return null
  try {
    if (!verify(parsed.data.desktop, acceptBytes(me.public, parsed.data.desktop, parsed.data.capabilities, parsed.data.name), fromBase64Url(parsed.data.sig))) return null
  } catch {
    return null
  }
  return parsed.data
}
