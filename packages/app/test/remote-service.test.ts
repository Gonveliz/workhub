import { describe, expect, it, vi } from 'vitest'
import { RelayCore, type Peer, type PushProvider, MemoryPushStore } from '@workhub/relay'
import {
  answerPairingOffer,
  decodeJson,
  encodeJson,
  generateIdentity,
  makeAuth,
  offerFromLink,
  openBox,
  pairingCode,
  parseChannelMessage,
  parsePushPayload,
  parseRelayMessage,
  verifyPushAsk,
  verifyPushPayload,
  sealBox,
  startHandshake,
  verifyPairAccept,
  verifyPairChallenge,
  type ChannelMessage,
  type Identity,
  type PairingOffer,
  type PermissionAnswer,
  type PushPayload,
  type RelayMessage,
  type SecureChannel
} from '@workhub/protocol'
import type { IpcRegistrar } from '../src/main/ipc-guard'
import { recordIpc, RemoteHub, RemoteService, relayWebClientUrl, relayWebSocketUrl, type RemoteServiceDeps, type RemoteState, type WebSocketLike } from '../src/main/remote'
import type { RemoteStatusView } from '../src/shared/remote-api'
import type { PendingPermission } from '../src/shared/api'
import { answerMessage, askOf, sendAnswer } from '../src/web/notification-answer'

const NOW = 1_800_000_000_000

/** A WebSocket that talks to an in-process RelayCore; `open` happens on the next tick like a real one. */
class FakeSocket implements WebSocketLike {
  onopen: ((ev: any) => void) | null = null
  onmessage: ((ev: any) => void) | null = null
  onclose: ((ev: any) => void) | null = null
  onerror: ((ev: any) => void) | null = null
  peer: Peer | null = null
  closed = false
  constructor(private readonly core: RelayCore) {
    queueMicrotask(() => {
      this.peer = core.connect({ send: (text) => this.onmessage?.({ data: text }), close: (code, reason) => this.dropped(code, reason) }, '10.0.0.1')
      // The client answers the relay's challenge while connect() is still running: delivered now that the peer exists.
      for (const text of this.early.splice(0)) if (this.peer) this.core.receive(this.peer, text)
      this.onopen?.({})
    })
  }
  private readonly early: string[] = []
  send(text: string) {
    if (this.closed) return
    if (!this.peer) this.early.push(text)
    else this.core.receive(this.peer, text)
  }
  close(code = 1000, reason = '') {
    if (this.closed) return
    this.closed = true
    if (this.peer) this.core.disconnect(this.peer)
    this.onclose?.({ code, reason })
  }
  /** The relay closed us. */
  dropped(code: number, reason: string) {
    if (this.closed) return
    this.closed = true
    if (this.peer) this.core.disconnect(this.peer)
    this.onclose?.({ code, reason })
  }
}

/** A phone, scripted: authenticates, joins the desktop's room, pairs, handshakes and calls hub methods. */
class ScriptedDevice {
  readonly identity: Identity
  readonly inbox: RelayMessage[] = []
  readonly channelInbox: ChannelMessage[] = []
  private readonly unread: ChannelMessage[] = []
  peer: Peer
  channel: SecureChannel | null = null
  private pending: ReturnType<typeof startHandshake> | null = null
  private nextId = 1
  private readonly waiting: ((m: ChannelMessage) => void)[] = []

  constructor(
    private readonly core: RelayCore,
    private readonly desktopId: string,
    identity = generateIdentity()
  ) {
    this.identity = identity
    this.peer = core.connect({ send: (text) => this.receive(text), close: () => {} }, '10.0.0.2')!
    const challenge = this.inbox.find((m) => m.t === 'challenge')
    if (challenge?.t !== 'challenge') throw new Error('the relay sent no challenge')
    this.send(makeAuth(identity, challenge.nonce, NOW))
    this.send({ t: 'join', room: desktopId })
  }

  private send(message: unknown) {
    this.core.receive(this.peer, JSON.stringify(message))
  }

  private to(body: unknown) {
    this.send({ t: 'to', room: this.desktopId, to: this.desktopId, body })
  }

  private receive(text: string) {
    const message = parseRelayMessage(JSON.parse(text))
    if (!message) return
    this.inbox.push(message)
    if (message.t !== 'from') return
    const body = message.body
    if (body.k === 'hs' && this.pending) {
      this.channel = this.pending.finish({ e: body.e })
      this.pending = null
      return
    }
    if (body.k === 'enc' && this.channel) {
      const opened = parseChannelMessage(this.channel.open(body.c))
      if (!opened) return
      this.channelInbox.push(opened)
      const w = this.waiting.shift()
      if (w) w(opened)
      else this.unread.push(opened)
    }
  }

  boxes(): { e: string; c: string }[] {
    return this.inbox.flatMap((m) => (m.t === 'from' && m.body.k === 'box' ? [{ e: m.body.e, c: m.body.c }] : []))
  }

  pair(offer: PairingOffer, name = 'Ana’s phone', version: 1 | 2 = 2) {
    const request = answerPairingOffer(this.identity, offer, name, 'ios', version)
    const box = sealBox(offer.desktop, encodeJson(request))
    this.to({ k: 'box', e: box.e, c: box.c })
  }

  /** The pairing code this device shows, from the desktop's last signed challenge; null before one came. */
  code(offer: PairingOffer): string | null {
    for (const box of this.boxes().reverse()) {
      const challenge = verifyPairChallenge(offer, this.identity.public, decodeJson(openBox(this.identity, box)!))
      if (challenge) return pairingCode(offer, this.identity.public, challenge.nonce)
    }
    return null
  }

  handshake(desktop: { sign: string; dh: string }) {
    this.pending = startHandshake(this.identity, desktop, 'initiator')
    this.to({ k: 'hs', e: this.pending.hello.e })
  }

  sendChannel(message: ChannelMessage) {
    if (!this.channel) throw new Error('no channel')
    this.to({ k: 'enc', c: this.channel.seal(message) })
  }

  /** The next channel message: one already received and not yet read, or the next to arrive. */
  next(): Promise<ChannelMessage> {
    const queued = this.unread.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  async invoke(channel: string, args: unknown[] = []): Promise<ChannelMessage> {
    const id = this.nextId++
    const answer = this.next()
    this.sendChannel({ t: 'invoke', id, channel, args })
    return answer
  }

  disconnect() {
    this.core.disconnect(this.peer)
  }
}

function harness(initial: Partial<RemoteState> = {}, extra: Pick<RemoteServiceDeps, 'pendingPermissions'> & { now?: () => number } = {}) {
  const log = { info: vi.fn(), warn: vi.fn() }
  const pushed: [string, string][] = []
  const push: PushProvider = { publicKey: 'VAPID', send: async (sub, payload) => void pushed.push([sub.endpoint, payload]) }
  const pushStore = new MemoryPushStore()
  const core = new RelayCore({ push, pushStore, now: () => NOW })
  const sockets: FakeSocket[] = []
  const saved: RemoteState[] = []
  const secrets = new Map<string, string>()
  const changes: RemoteStatusView[] = []
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = []
  const { ipc, handlers } = recordIpc({ handle: () => {}, on: () => {} } as IpcRegistrar)
  ipc.handle('sessions:list', () => [{ id: 's1', name: 'Fix tests' }])
  ipc.handle('hub:pickFolder', () => '/anywhere')
  const permissions: unknown[][] = []
  ipc.on('sessions:permission', (_e, ...args) => void permissions.push(args))
  const hub = new RemoteHub({ handlers, profileFolders: async () => ['/work/api'], startMode: async () => null })
  const service = new RemoteService({
    store: { load: (fallback) => ({ ...fallback, relayUrl: 'https://relay.example.com', desktopName: 'Ana’s MacBook', ...initial }), save: (s) => void saved.push(structuredClone(s)) },
    secrets: { get: async (ref) => secrets.get(ref) ?? null, set: async (ref, value) => void secrets.set(ref, value) },
    hub,
    connect: () => {
      const s = new FakeSocket(core)
      sockets.push(s)
      return s
    },
    defaultName: () => 'desk',
    onChanged: (status) => void changes.push(status),
    log,
    now: extra.now ?? (() => NOW),
    ...(extra.pendingPermissions ? { pendingPermissions: extra.pendingPermissions } : {}),
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false }
      timers.push(t)
      return () => void (t.cancelled = true)
    }
  })
  const settle = () => new Promise((r) => setTimeout(r, 0))
  const fire = () => {
    const due = timers.splice(0)
    for (const t of due) if (!t.cancelled) t.fn()
  }
  return { core, service, sockets, saved, secrets, changes, timers, fire, settle, hub, pushed, pushStore, log, permissions }
}

describe('relay URLs', () => {
  it('turns the address a person types into the socket and web client URLs', () => {
    expect(relayWebSocketUrl('https://relay.example.com')).toBe('wss://relay.example.com/ws')
    expect(relayWebSocketUrl('https://relay.example.com/')).toBe('wss://relay.example.com/ws')
    expect(relayWebSocketUrl('wss://relay.example.com/ws')).toBe('wss://relay.example.com/ws')
    expect(relayWebSocketUrl('http://localhost:8787')).toBe('ws://localhost:8787/ws')
    expect(relayWebSocketUrl('ftp://x')).toBeNull()
    expect(relayWebSocketUrl('nope')).toBeNull()
    expect(relayWebClientUrl('https://relay.example.com')).toBe('https://relay.example.com/')
    expect(relayWebClientUrl('wss://relay.example.com/app/ws')).toBe('https://relay.example.com/app/')
  })
})

describe('RemoteService', () => {
  it('stays off until enabled, then authenticates, joins its room and keeps its identity', async () => {
    const h = harness()
    await h.service.start()
    expect(h.sockets).toHaveLength(0)
    expect(h.service.status()).toMatchObject({ enabled: false, connection: 'off', desktopId: null })
    await h.service.setEnabled(true)
    await h.settle()
    const online = h.service.status()
    expect(online.connection).toBe('online')
    expect(online.pushAvailable).toBe(true)
    expect(online.desktopId).toMatch(/^[0-9a-f]{32}$/)
    expect(online.fingerprint).toMatch(/^([0-9A-F]{4} ){7}[0-9A-F]{4}$/)
    expect(h.core.peersIn(online.desktopId!)).toEqual([online.desktopId])
    expect(h.secrets.get('remote/identity')).toBeDefined()
    expect(h.saved.at(-1)).toMatchObject({ enabled: true })
  })

  it('pairs a device that answers the QR, after the person accepts it with capabilities', async () => {
    const h = harness({ enabled: true })
    await h.service.start()
    await h.settle()
    const me = h.service.status().desktopId!
    const status = await h.service.startPairing()
    expect(status.pairing).not.toBeNull()
    expect(status.pairing!.link.startsWith('https://relay.example.com/#pair=')).toBe(true)
    const offer = offerFromLink(status.pairing!.link)!
    expect(offer.relay).toBe('wss://relay.example.com/ws')
    expect(offer.name).toBe('Ana’s MacBook')

    const phone = new ScriptedDevice(h.core, me)
    phone.pair(offer)
    const request = h.service.status().request
    expect(request).toMatchObject({ deviceId: phone.identity.id, name: 'Ana’s phone', platform: 'ios' })

    const code = phone.code(offer)
    expect(code).toMatch(/^[0-9]{6}$/)
    const after = h.service.acceptPairing(phone.identity.id, ['sessions', 'health'], code!)
    expect(after.pairing).toBeNull()
    expect(after.request).toBeNull()
    expect(after.devices).toHaveLength(1)
    expect(after.devices[0]).toMatchObject({ id: phone.identity.id, capabilities: ['sessions', 'health'], online: false })
    const box = phone.boxes().at(-1)!
    const accept = verifyPairAccept(offer, phone.identity, decodeJson(openBox(phone.identity, box)!))
    expect(accept).toMatchObject({ capabilities: ['sessions', 'health'], name: 'Ana’s MacBook' })
  })

  it('ignores pairing requests without an open QR, with a bad proof, or from a different sender', async () => {
    const h = harness({ enabled: true })
    await h.service.start()
    await h.settle()
    const me = h.service.status().desktopId!
    const phone = new ScriptedDevice(h.core, me)
    const bogus = { ...(await h.service.startPairing()).pairing! }
    h.service.cancelPairing()
    phone.pair(offerFromLink(bogus.link)!)
    expect(h.service.status().request).toBeNull()
    const status = await h.service.startPairing()
    const offer = offerFromLink(status.pairing!.link)!
    phone.pair({ ...offer, secret: 'A'.repeat(43) })
    expect(h.service.status().request).toBeNull()
    expect(() => h.service.acceptPairing(phone.identity.id, ['sessions'], '000000')).toThrow(/no device/)
  })

  it('cancels the offer when a second device answers it, and tells the person', async () => {
    const h = harness({ enabled: true })
    await h.service.start()
    await h.settle()
    const me = h.service.status().desktopId!
    const offer = offerFromLink((await h.service.startPairing()).pairing!.link)!
    const first = new ScriptedDevice(h.core, me)
    const second = new ScriptedDevice(h.core, me)
    first.pair(offer, 'Ana’s phone')
    expect(h.service.status().request).toMatchObject({ deviceId: first.identity.id })
    // The same device asking again (it reconnected) is no second device, and keeps its code.
    const code = first.code(offer)!
    first.pair(offer, 'Ana’s phone')
    expect(first.code(offer)).toBe(code)
    expect(h.service.status().request).toMatchObject({ deviceId: first.identity.id })

    second.pair(offer, 'Ana’s phone')
    const status = h.service.status()
    expect(status.pairing).toBeNull()
    expect(status.request).toBeNull()
    expect(status.alert).toMatchObject({ kind: 'second-device' })
    expect(h.changes.at(-1)?.alert?.kind).toBe('second-device')
    expect(h.log.warn).toHaveBeenCalledWith(expect.stringContaining('a second device'))
    // Neither device can be accepted, even with the right code.
    expect(() => h.service.acceptPairing(first.identity.id, ['sessions'], code)).toThrow(/no device/)
    expect(() => h.service.acceptPairing(second.identity.id, ['sessions'], second.code(offer) ?? '000000')).toThrow(/no device/)
    expect(h.service.status().devices).toEqual([])
    // A new QR clears the warning.
    expect((await h.service.startPairing()).alert).toBeNull()
  })

  it('refuses the request and cancels the offer when the code typed is wrong', async () => {
    const h = harness({ enabled: true })
    await h.service.start()
    await h.settle()
    const me = h.service.status().desktopId!
    const offer = offerFromLink((await h.service.startPairing()).pairing!.link)!
    const phone = new ScriptedDevice(h.core, me)
    phone.pair(offer)
    const right = phone.code(offer)!
    const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, '0')
    const after = h.service.acceptPairing(phone.identity.id, ['sessions'], wrong)
    expect(after.devices).toEqual([])
    expect(after.request).toBeNull()
    expect(after.pairing).toBeNull()
    expect(after.alert).toMatchObject({ kind: 'wrong-code' })
    // One guess per QR: the right code no longer helps.
    expect(() => h.service.acceptPairing(phone.identity.id, ['sessions'], right)).toThrow(/no device/)
    // Nothing was sent but the challenge: no accept for the phone to verify.
    expect(phone.boxes().every((box) => verifyPairAccept(offer, phone.identity, decodeJson(openBox(phone.identity, box)!)) === null)).toBe(true)
  })

  it('tells the person to update a phone that answers with the pairing version before the code', async () => {
    const h = harness({ enabled: true })
    await h.service.start()
    await h.settle()
    const me = h.service.status().desktopId!
    const offer = offerFromLink((await h.service.startPairing()).pairing!.link)!
    const phone = new ScriptedDevice(h.core, me)
    phone.pair(offer, 'Ana’s old phone', 1)
    const status = h.service.status()
    expect(status.request).toBeNull()
    expect(status.alert).toMatchObject({ kind: 'device-outdated', name: 'Ana’s old phone' })
    expect(status.pairing).not.toBeNull()
    expect(phone.code(offer)).toBeNull()
    // Updated (the same phone, reloaded), it answers the same QR and gets its code.
    phone.pair(offer, 'Ana’s phone')
    expect(h.service.status()).toMatchObject({ request: { deviceId: phone.identity.id }, alert: null })
    expect(phone.code(offer)).toMatch(/^[0-9]{6}$/)
  })

  it('keeps a live link when a stale hello is replayed; the new channel takes over only once it opens a message', async () => {
    const h = harness({ enabled: true })
    await h.service.start()
    await h.settle()
    const me = h.service.status().desktopId!
    const offer = offerFromLink((await h.service.startPairing()).pairing!.link)!
    const phone = new ScriptedDevice(h.core, me)
    phone.pair(offer)
    h.service.acceptPairing(phone.identity.id, ['sessions'], phone.code(offer)!)
    phone.handshake(offer.desktop)
    const firstHello = phone.inbox.filter((m) => m.t === 'from' && m.body.k === 'hs').length
    phone.sendChannel({ t: 'ready' })
    await phone.next()
    expect(h.service.status().devices[0]!.online).toBe(true)
    const live = phone.channel!

    // A relay replays an old hello as if it came from the phone: the desktop answers, but the link stands.
    const stale = startHandshake(generateIdentity(), offer.desktop, 'initiator').hello.e
    h.core.receive(phone.peer, JSON.stringify({ t: 'to', room: me, to: me, body: { k: 'hs', e: stale } }))
    expect(phone.inbox.filter((m) => m.t === 'from' && m.body.k === 'hs').length).toBe(firstHello + 1)
    expect(h.service.status().devices[0]!.online).toBe(true)
    phone.channel = live
    const answer = await phone.invoke('sessions:list')
    expect(answer).toMatchObject({ t: 'result', ok: true })

    // A real reconnect: the new channel replaces the old one once `ready` opens with it.
    phone.handshake(offer.desktop)
    phone.sendChannel({ t: 'ready' })
    await phone.next()
    expect(h.service.status().devices[0]!.online).toBe(true)
    expect((await phone.invoke('sessions:list')).t).toBe('result')
  })

  it('drops a device that says unpair over the channel', async () => {
    const h = harness({ enabled: true })
    await h.service.start()
    await h.settle()
    const me = h.service.status().desktopId!
    const offer = offerFromLink((await h.service.startPairing()).pairing!.link)!
    const phone = new ScriptedDevice(h.core, me)
    phone.pair(offer)
    h.service.acceptPairing(phone.identity.id, ['sessions'], phone.code(offer)!)
    phone.handshake(offer.desktop)
    phone.sendChannel({ t: 'ready' })
    await phone.next()
    expect(h.service.status().devices).toHaveLength(1)
    phone.sendChannel({ t: 'unpair' })
    expect(h.service.status().devices).toEqual([])
    // Trying again without pairing gets nowhere.
    phone.handshake(offer.desktop)
    expect(phone.channel).not.toBeNull()
    expect(h.service.status().devices).toEqual([])
  })

  it('answers a paired device’s handshake and routes its calls through the hub with its capabilities', async () => {
    const h = harness({ enabled: true })
    await h.service.start()
    await h.settle()
    const me = h.service.status().desktopId!
    const offer = offerFromLink((await h.service.startPairing()).pairing!.link)!
    const phone = new ScriptedDevice(h.core, me)
    phone.pair(offer)
    h.service.acceptPairing(phone.identity.id, ['sessions'], phone.code(offer)!)

    phone.handshake(offer.desktop)
    expect(phone.channel).not.toBeNull()
    const ready = phone.next()
    phone.sendChannel({ t: 'ready', client: 'web' })
    expect(await ready).toMatchObject({ t: 'ready', capabilities: ['sessions'], desktop: 'Ana’s MacBook' })
    expect(h.service.status().devices[0]!.online).toBe(true)

    expect(await phone.invoke('sessions:list')).toEqual({ t: 'result', id: 1, ok: true, value: [{ id: 's1', name: 'Fix tests' }] })
    expect(await phone.invoke('hub:pickFolder')).toMatchObject({ t: 'result', id: 2, ok: false, error: expect.stringContaining('not available remotely') })
    expect(await phone.invoke('codeHost:lists', ['work'])).toMatchObject({ ok: false })

    // Events main sends reach the device over the channel.
    h.hub.tap('session:changed', [{ id: 's1', name: 'Renamed' }])
    expect(phone.channelInbox.at(-1)).toEqual({ t: 'event', channel: 'session:changed', args: [{ id: 's1', name: 'Renamed' }] })
    h.hub.tap('metricAlerts:changed', ['work'])
    expect(phone.channelInbox.at(-1)!.t).toBe('event')
    expect((phone.channelInbox.at(-1) as { channel: string }).channel).toBe('session:changed')
  })

  it('refuses a handshake from an unpaired identity and a stranger impersonating a device', async () => {
    const h = harness({ enabled: true })
    await h.service.start()
    await h.settle()
    const me = h.service.status().desktopId!
    const offer = offerFromLink((await h.service.startPairing()).pairing!.link)!
    const phone = new ScriptedDevice(h.core, me)
    phone.pair(offer)
    h.service.acceptPairing(phone.identity.id, ['sessions'], phone.code(offer)!)
    const stranger = new ScriptedDevice(h.core, me)
    stranger.handshake(offer.desktop)
    expect(stranger.channel).toBeNull()
    // The phone still pairs and connects; the stranger's attempt changed nothing.
    phone.handshake(offer.desktop)
    phone.sendChannel({ t: 'ready' })
    await phone.next()
    expect(h.service.status().devices[0]!.online).toBe(true)
    expect(h.service.status().devices).toHaveLength(1)
  })

  it('repeats notifications over the channel when the device is online and by push when it is not', async () => {
    const h = harness({ enabled: true })
    await h.service.start()
    await h.settle()
    const me = h.service.status().desktopId!
    const offer = offerFromLink((await h.service.startPairing()).pairing!.link)!
    const phone = new ScriptedDevice(h.core, me)
    phone.pair(offer)
    h.service.acceptPairing(phone.identity.id, ['sessions'], phone.code(offer)!)
    h.pushStore.set(phone.identity.id, { sub: { endpoint: 'https://push.example.com/p', keys: { p256dh: 'B'.repeat(87), auth: 'C'.repeat(22) } }, rooms: [me], updatedAt: NOW })

    // Offline: a sealed box goes out by push; only the phone opens it.
    h.service.notify({ kind: 'needsAnswer', title: 'Claude asks', body: 'Run npm test?', at: NOW, sessionId: 's1', tag: 's1' })
    await vi.waitFor(() => expect(h.pushed).toHaveLength(1))
    const { box } = JSON.parse(h.pushed[0]![1]) as { box: { e: string; c: string } }
    const payload = parsePushPayload(decodeJson(openBox(phone.identity, box)!))!
    expect(payload).toMatchObject({ v: 1, kind: 'needsAnswer', title: 'Claude asks', body: 'Run npm test?', ts: NOW, tag: 's1', route: '#session/s1', desktop: me })
    // Signed by the desktop: a relay with the phone's public key could seal a box, not sign one.
    expect(verifyPushPayload(payload, offer.desktop, NOW)).toBe(true)
    expect(verifyPushPayload({ ...payload, title: 'Tap to approve' }, offer.desktop, NOW)).toBe(false)
    expect(openBox(generateIdentity(), box)).toBeNull()
    // A kind outside the device's capabilities is not sent at all.
    h.service.notify({ kind: 'prEvent', title: 'PR merged', body: '', at: NOW })
    await h.settle()
    expect(h.pushed).toHaveLength(1)

    // Online: it goes over the channel instead.
    phone.handshake(offer.desktop)
    phone.sendChannel({ t: 'ready' })
    await phone.next()
    h.service.notify({ kind: 'replied', title: 'Claude replied', body: 'Done', at: NOW })
    expect(phone.channelInbox.at(-1)).toMatchObject({ t: 'event', channel: 'remote:notification', args: [{ kind: 'replied', title: 'Claude replied' }] })
    expect(h.pushed).toHaveLength(1)
  })

  it('revokes a device: it is told, dropped and forgotten; changing capabilities re-keys the link', async () => {
    const h = harness({ enabled: true })
    await h.service.start()
    await h.settle()
    const me = h.service.status().desktopId!
    const offer = offerFromLink((await h.service.startPairing()).pairing!.link)!
    const phone = new ScriptedDevice(h.core, me)
    phone.pair(offer)
    h.service.acceptPairing(phone.identity.id, ['sessions'], phone.code(offer)!)
    phone.handshake(offer.desktop)
    phone.sendChannel({ t: 'ready' })
    await phone.next()

    const changed = h.service.setCapabilities(phone.identity.id, ['sessions', 'pullRequests'])
    expect(changed.devices[0]).toMatchObject({ capabilities: ['sessions', 'pullRequests'], online: false })
    expect(await phone.next()).toEqual({ t: 'bye', reason: 'shutdown' })
    phone.handshake(offer.desktop)
    phone.sendChannel({ t: 'ready' })
    expect(await phone.next()).toMatchObject({ t: 'ready', capabilities: ['sessions', 'pullRequests'] })

    const gone = h.service.revoke(phone.identity.id)
    expect(gone.devices).toEqual([])
    expect(await phone.next()).toEqual({ t: 'bye', reason: 'revoked' })
    phone.handshake(offer.desktop)
    expect(phone.inbox.filter((m) => m.t === 'from' && m.body.k === 'hs')).toHaveLength(2)
  })

  it('reconnects with backoff when the relay goes away, and stops when turned off', async () => {
    const h = harness({ enabled: true })
    await h.service.start()
    await h.settle()
    expect(h.service.status().connection).toBe('online')
    h.sockets[0]!.dropped(1001, 'relay shutting down')
    expect(h.service.status()).toMatchObject({ connection: 'error', error: 'disconnected: relay shutting down' })
    expect(h.timers.at(-1)!.ms).toBeGreaterThanOrEqual(750)
    h.fire()
    await h.settle()
    expect(h.sockets).toHaveLength(2)
    expect(h.service.status().connection).toBe('online')
    await h.service.setEnabled(false)
    expect(h.service.status().connection).toBe('off')
    expect(h.sockets[1]!.closed).toBe(true)
    h.fire()
    await h.settle()
    expect(h.sockets).toHaveLength(2)
  })

  it('needs a relay address and a valid one', async () => {
    const h = harness({ relayUrl: '' })
    const status = await h.service.setEnabled(true)
    expect(status).toMatchObject({ connection: 'error', error: 'no relay address' })
    await expect(h.service.setRelayUrl('ftp://nope')).rejects.toThrow(/https/)
    await expect(h.service.startPairing()).rejects.toThrow(/relay address/)
    await h.service.setRelayUrl('https://relay.example.com')
    await h.settle()
    expect(h.service.status().connection).toBe('online')
  })
})

describe('answering a permission request from a notification', () => {
  const waiting = (requestId = 'r1', extra: Partial<PendingPermission> = {}): PendingPermission => ({
    requestId,
    title: 'Run npm test',
    options: [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'no', name: 'Deny', kind: 'reject_once' }
    ],
    at: NOW,
    ...extra
  })

  /** A desktop with two paired phones (both with sessions), offline, subscribed to push, and a clock the test moves. */
  async function setup(pending: () => PendingPermission[]) {
    const clock = { now: NOW }
    const h = harness({ enabled: true }, { pendingPermissions: () => pending(), now: () => clock.now })
    await h.service.start()
    await h.settle()
    const me = h.service.status().desktopId!
    const pairOne = async () => {
      const offer = offerFromLink((await h.service.startPairing()).pairing!.link)!
      const phone = new ScriptedDevice(h.core, me)
      phone.pair(offer)
      h.service.acceptPairing(phone.identity.id, ['sessions'], phone.code(offer)!)
      h.pushStore.set(phone.identity.id, { sub: { endpoint: `https://push.example.com/${phone.identity.id}`, keys: { p256dh: 'B'.repeat(87), auth: 'C'.repeat(22) } }, rooms: [me], updatedAt: NOW })
      phone.disconnect()
      return { phone, desktop: offer.desktop }
    }
    const one = await pairOne()
    const two = await pairOne()
    /** The payload the last push to `phone` carried, as its service worker opens it. */
    const pushedTo = (phone: ScriptedDevice): PushPayload => {
      const sent = h.pushed.filter(([endpoint]) => endpoint.endsWith(phone.identity.id)).at(-1)!
      return parsePushPayload(decodeJson(openBox(phone.identity, (JSON.parse(sent[1]) as { box: { e: string; c: string } }).box)!))!
    }
    const notify = async () => {
      const before = h.pushed.length
      h.service.notify({ kind: 'needsAnswer', title: 'Claude asks', body: 'Run npm test?', at: clock.now, sessionId: 's1', tag: 'session:s1' })
      await vi.waitFor(() => expect(h.pushed.length).toBe(before + 2))
    }
    /** What a tap on a button sends, from the worker's own short connection. */
    const answer = (phone: ScriptedDevice, message: PermissionAnswer, timeoutMs = 2000) =>
      sendAnswer({ connect: () => new FakeSocket(h.core), relay: 'wss://relay.example.com/ws', me: phone.identity, desktop: one.desktop, desktopId: me, answer: message, now: () => NOW, timeoutMs })
    return { h, me, clock, one, two, pushedTo, notify, answer }
  }

  it('pushes a ticket for this device that offers only Deny, and a tap on it denies the live request once', async () => {
    const s = await setup(() => [waiting()])
    await s.notify()
    const payload = s.pushedTo(s.one.phone)
    // The payload itself still verifies as before: a phone that ignores `ask` keeps working.
    expect(verifyPushPayload(payload, s.one.desktop, NOW)).toBe(true)
    expect(payload.ask).toMatchObject({ session: 's1', request: 'r1', answers: ['deny'] })
    // Signed for this phone only.
    expect(verifyPushAsk(payload, s.one.desktop, s.one.phone.identity.id)).toBe(true)
    expect(verifyPushAsk(payload, s.one.desktop, s.two.phone.identity.id)).toBe(false)
    expect(s.pushedTo(s.two.phone).ask!.ticket).not.toBe(payload.ask!.ticket)

    const ask = askOf(payload)!
    const message = answerMessage(s.one.phone.identity, ask, 'deny', NOW)
    expect(await s.answer(s.one.phone, message)).toBe('ok')
    expect(s.h.permissions).toEqual([['s1', 'r1', 'no']])
    // The same answer again (a replay, or a second tap) finds its ticket used.
    expect(await s.answer(s.one.phone, message)).toBe('expired')
    expect(s.h.permissions).toHaveLength(1)
  })

  it('refuses a request that is gone or already answered', async () => {
    let pending = [waiting()]
    const s = await setup(() => pending)
    await s.notify()
    // Answered at the desktop (or withdrawn) before the tap.
    pending = []
    expect(await s.answer(s.one.phone, answerMessage(s.one.phone.identity, askOf(s.pushedTo(s.one.phone))!, 'deny', NOW))).toBe('gone')
    // Another request now waits under the same session: the ticket named the old one.
    pending = [waiting('r2')]
    expect(await s.answer(s.two.phone, answerMessage(s.two.phone.identity, { ...askOf(s.pushedTo(s.two.phone))!, request: 'r2' }, 'deny', NOW))).toBe('refused')
    expect(s.h.permissions).toEqual([])
  })

  it('refuses a stale notification and a stale answer', async () => {
    const s = await setup(() => [waiting()])
    await s.notify()
    // Eleven minutes later the ticket is gone, even for an answer signed just now.
    s.clock.now = NOW + 11 * 60_000
    const late = answerMessage(s.one.phone.identity, askOf(s.pushedTo(s.one.phone))!, 'deny', s.clock.now)
    expect(await s.answer(s.one.phone, late)).toBe('expired')
    // A fresh ticket, but an answer captured long ago.
    s.clock.now = NOW
    await s.notify()
    const old = answerMessage(s.one.phone.identity, askOf(s.pushedTo(s.one.phone))!, 'deny', NOW - 11 * 60_000)
    expect(await s.answer(s.one.phone, old)).toBe('expired')
    expect(s.h.permissions).toEqual([])
  })

  it('refuses another device, a stranger and a forged answer, and leaves the ticket to its device', async () => {
    const s = await setup(() => [waiting()])
    await s.notify()
    const ask = askOf(s.pushedTo(s.one.phone))!
    // The second phone (paired, granted sessions) with the first one's ticket.
    expect(await s.answer(s.two.phone, answerMessage(s.two.phone.identity, ask, 'deny', NOW))).toBe('refused')
    // Signed by another key in the first phone's name.
    const forged = { ...answerMessage(s.two.phone.identity, ask, 'deny', NOW), device: s.one.phone.identity.id }
    expect(await s.answer(s.one.phone, forged)).toBe('refused')
    // An unpaired identity gets no answer at all.
    const stranger = new ScriptedDevice(s.h.core, s.me)
    stranger.disconnect()
    expect(await s.answer(stranger, answerMessage(stranger.identity, ask, 'deny', NOW), 100)).toBe('unreachable')
    expect(s.h.permissions).toEqual([])
    // None of that used the ticket up.
    expect(await s.answer(s.one.phone, answerMessage(s.one.phone.identity, ask, 'deny', NOW))).toBe('ok')
  })

  it('never allows from a notification', async () => {
    const s = await setup(() => [waiting()])
    await s.notify()
    const ask = askOf(s.pushedTo(s.one.phone))!
    expect(await s.answer(s.one.phone, answerMessage(s.one.phone.identity, { ...ask, answers: ['allow', 'deny'] }, 'allow', NOW))).toBe('refused')
    expect(s.h.permissions).toEqual([])
  })

  it('refuses a device whose sessions capability was taken away after the push', async () => {
    const s = await setup(() => [waiting()])
    await s.notify()
    s.h.service.setCapabilities(s.one.phone.identity.id, ['health'])
    expect(await s.answer(s.one.phone, answerMessage(s.one.phone.identity, askOf(s.pushedTo(s.one.phone))!, 'deny', NOW))).toBe('refused')
    expect(s.h.permissions).toEqual([])
  })

  it('offers nothing for several requests, a question, or a request without a deny option', async () => {
    let pending: PendingPermission[] = [waiting('r1'), waiting('r2')]
    const s = await setup(() => pending)
    await s.notify()
    expect(s.pushedTo(s.one.phone).ask).toBeUndefined()
    pending = [waiting('r1', { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] })]
    await s.notify()
    expect(s.pushedTo(s.one.phone).ask).toBeUndefined()
    pending = [waiting('r1', { options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }] })]
    await s.notify()
    expect(s.pushedTo(s.one.phone).ask).toBeUndefined()
  })
})
