import { describe, expect, it } from 'vitest'
import {
  acceptPairing,
  answerPairingOffer,
  decodePairingOffer,
  encodePairingOffer,
  generateIdentity,
  identityFromSeed,
  toBase64Url,
  makePairChallenge,
  makePairingOffer,
  offerFromLink,
  offerOutdated,
  pairingCode,
  pairingCodeMatches,
  pairingLink,
  PAIRING_VERSION,
  verifyPairAccept,
  verifyPairChallenge,
  verifyPairRequest
} from '../src'

const NOW = 1_800_000_000_000

describe('pairing', () => {
  const desktop = generateIdentity()
  const phone = generateIdentity()
  const offer = makePairingOffer(desktop, 'wss://relay.example.com/ws', "Ana's MacBook", NOW)

  it('encodes the offer for a QR and reads it back from the link fragment', () => {
    expect(offer.exp).toBe(NOW + 5 * 60_000)
    expect(decodePairingOffer(encodePairingOffer(offer))).toEqual(offer)
    const link = pairingLink('https://remote.example.com/app/#home', offer)
    expect(link.startsWith('https://remote.example.com/app/#pair=')).toBe(true)
    expect(offerFromLink(link)).toEqual(offer)
    expect(offerFromLink('https://remote.example.com/')).toBeNull()
    expect(decodePairingOffer('AAAA')).toBeNull()
    expect(decodePairingOffer('not base64url!')).toBeNull()
    // The relay must be wss (ws only on a local host) and the secret exactly 32 bytes.
    expect(decodePairingOffer(encodePairingOffer({ ...offer, relay: 'https://relay.example.com/ws' }))).toBeNull()
    expect(decodePairingOffer(encodePairingOffer({ ...offer, relay: 'ws://relay.example.com/ws' }))).toBeNull()
    expect(decodePairingOffer(encodePairingOffer({ ...offer, relay: 'ws://localhost:8787/ws' }))).not.toBeNull()
    expect(decodePairingOffer(encodePairingOffer({ ...offer, secret: 'A'.repeat(42) }))).toBeNull()
    expect(decodePairingOffer(encodePairingOffer({ ...offer, secret: 'A'.repeat(43) }))).not.toBeNull()
  })

  it('accepts a request made with the secret from the QR, before the offer expires', () => {
    const request = answerPairingOffer(phone, offer, 'Ana’s phone', 'ios')
    expect(verifyPairRequest(offer, request, NOW + 1000)).toEqual({ ok: true, deviceId: phone.id })
    expect(verifyPairRequest(offer, request, NOW + 6 * 60_000)).toEqual({ ok: false, reason: 'expired' })
  })

  it('refuses a request without the secret, for another desktop, or malformed', () => {
    const otherOffer = makePairingOffer(desktop, 'wss://relay.example.com/ws', "Ana's MacBook", NOW)
    const forOther = answerPairingOffer(phone, otherOffer, 'phone', 'ios')
    expect(verifyPairRequest(offer, forOther, NOW)).toEqual({ ok: false, reason: 'proof' })
    const request = answerPairingOffer(phone, offer, 'phone', 'ios')
    expect(verifyPairRequest(offer, { ...request, device: generateIdentity().public }, NOW)).toEqual({ ok: false, reason: 'proof' })
    expect(verifyPairRequest(offer, { ...request, proof: 'A'.repeat(43) }, NOW)).toEqual({ ok: false, reason: 'proof' })
    // The name and platform the person sees are under the proof: nobody renames the device on the way.
    expect(verifyPairRequest(offer, { ...request, name: 'Ana’s other phone' }, NOW)).toEqual({ ok: false, reason: 'proof' })
    expect(verifyPairRequest(offer, { ...request, platform: 'android' }, NOW)).toEqual({ ok: false, reason: 'proof' })
    expect(verifyPairRequest(offer, { ...request, proof: '!!' }, NOW)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyPairRequest(offer, { v: 1 }, NOW)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyPairRequest(offer, null, NOW)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('signs the accept so the device knows it came from the desktop in the QR, with these capabilities', () => {
    const accept = acceptPairing(desktop, phone.public, "Ana's MacBook", ['sessions', 'health'])
    expect(verifyPairAccept(offer, phone, accept)).toEqual(accept)
    expect(verifyPairAccept(offer, phone, { ...accept, capabilities: ['sessions', 'health', 'pullRequests'] })).toBeNull()
    expect(verifyPairAccept(offer, generateIdentity(), accept)).toBeNull()
    const impostor = generateIdentity()
    expect(verifyPairAccept(offer, phone, acceptPairing(impostor, phone.public, 'x', ['sessions']))).toBeNull()
    expect(verifyPairAccept(offer, phone, { ...accept, sig: 'A'.repeat(86) })).toBeNull()
    expect(verifyPairAccept(offer, phone, { ...accept, sig: 'AAAA' })).toBeNull()
    expect(verifyPairAccept(offer, phone, { ...accept, name: 'Someone else’s MacBook' })).toBeNull()
    expect(verifyPairAccept(offer, phone, 'junk')).toBeNull()
  })

  it('marks the offer with the pairing version, and tells which side is older', () => {
    expect(offer.pv).toBe(PAIRING_VERSION)
    expect(offerOutdated(offer)).toBeNull()
    // A desktop from before the pairing code sends no `pv`; a newer one a higher number.
    const { pv: _pv, ...older } = offer
    expect(offerOutdated(decodePairingOffer(encodePairingOffer(older as typeof offer))!)).toBe('desktop')
    expect(offerOutdated({ ...offer, pv: PAIRING_VERSION + 1 })).toBe('phone')
  })

  it('tells an answer from a phone older than the pairing code apart, once its proof holds', () => {
    const old = answerPairingOffer(phone, offer, 'Ana’s phone', 'ios', 1)
    expect(verifyPairRequest(offer, old, NOW)).toEqual({ ok: false, reason: 'outdated', deviceId: phone.id })
    // The version is under the proof: an old request cannot pass as a new one, nor the other way.
    expect(verifyPairRequest(offer, { ...old, v: 2 }, NOW)).toEqual({ ok: false, reason: 'proof' })
    expect(verifyPairRequest(offer, { ...answerPairingOffer(phone, offer, 'Ana’s phone', 'ios'), v: 1 }, NOW)).toEqual({ ok: false, reason: 'proof' })
  })

  it('derives the same pairing code on both sides from a challenge the desktop signed', () => {
    const challenge = makePairChallenge(desktop, offer, phone.public)
    // The phone checks the challenge came from the offer's desktop, for this phone and this offer.
    expect(verifyPairChallenge(offer, phone.public, challenge)).toEqual(challenge)
    expect(verifyPairChallenge(offer, generateIdentity().public, challenge)).toBeNull()
    expect(verifyPairChallenge({ ...offer, exp: offer.exp + 1 }, phone.public, challenge)).toBeNull()
    expect(verifyPairChallenge(offer, phone.public, makePairChallenge(generateIdentity(), offer, phone.public))).toBeNull()
    expect(verifyPairChallenge(offer, phone.public, { ...challenge, nonce: 'A'.repeat(43) })).toBeNull()
    expect(verifyPairChallenge(offer, phone.public, 'junk')).toBeNull()

    const onDesktop = pairingCode(offer, phone.public, challenge.nonce)
    const onPhone = pairingCode(offer, phone.public, verifyPairChallenge(offer, phone.public, challenge)!.nonce)
    expect(onDesktop).toMatch(/^[0-9]{6}$/)
    expect(onPhone).toBe(onDesktop)
  })

  it('gives another code when any input differs', () => {
    // Fixed inputs, so the check is exact rather than right a million times to one.
    const id = (n: number) => identityFromSeed(new Uint8Array(32).fill(n))
    const fixed = { ...offer, desktop: id(1).public, secret: toBase64Url(new Uint8Array(32).fill(7)) }
    const device = id(2).public
    const nonce = toBase64Url(new Uint8Array(32).fill(9))
    const code = pairingCode(fixed, device, nonce)
    expect(code).toMatch(/^[0-9]{6}$/)
    expect(pairingCode(fixed, device, nonce)).toBe(code)
    expect(pairingCode(fixed, id(3).public, nonce)).not.toBe(code)
    expect(pairingCode({ ...fixed, desktop: id(4).public }, device, nonce)).not.toBe(code)
    expect(pairingCode({ ...fixed, secret: toBase64Url(new Uint8Array(32).fill(8)) }, device, nonce)).not.toBe(code)
    expect(pairingCode(fixed, device, toBase64Url(new Uint8Array(32).fill(10)))).not.toBe(code)
  })

  it('matches a typed code exactly, spaces aside', () => {
    expect(pairingCodeMatches('012345', '012345')).toBe(true)
    expect(pairingCodeMatches('012345', ' 012 345 ')).toBe(true)
    expect(pairingCodeMatches('012345', '12345')).toBe(false)
    expect(pairingCodeMatches('012345', '012346')).toBe(false)
    expect(pairingCodeMatches('012345', '01234a')).toBe(false)
    expect(pairingCodeMatches('012345', '')).toBe(false)
  })
})
