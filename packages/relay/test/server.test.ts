import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { generateIdentity, makeAuth, MAX_FRAME_BYTES, PUSH_MAX_AGE_MS, type RelayMessage } from '@workhub/protocol'
import { addressOf, createRelayServer, type RelayServer } from '../src/server'
import { PassThrough, Readable, Writable } from 'node:stream'
import { resolveStatic, sendStream } from '../src/static'
import { FilePushStore } from '../src/push-store'
import { PUSH_TTL_SECONDS, pushEndpointAllowed } from '../src/push'

let server: RelayServer
let base: string
let webDir: string

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), 'relay-web-'))
  mkdirSync(join(webDir, 'assets'))
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Workhub</title>')
  writeFileSync(join(webDir, 'assets', 'app-abc123.js'), 'console.log(1)')
  server = createRelayServer({ webClientDir: webDir, authTimeoutMs: 300, heartbeatMs: 60_000, version: 'test' })
  await new Promise<void>((done) => server.http.listen(0, '127.0.0.1', () => done()))
  const address = server.http.address() as { port: number }
  base = `127.0.0.1:${address.port}`
})

afterAll(() => server.close())

function connect(): Promise<{ ws: WebSocket; next: () => Promise<RelayMessage>; closed: Promise<[number, string]> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/ws`)
    const queue: RelayMessage[] = []
    const waiters: ((m: RelayMessage) => void)[] = []
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as RelayMessage
      const w = waiters.shift()
      if (w) w(m)
      else queue.push(m)
    })
    const closed = new Promise<[number, string]>((done) => ws.on('close', (code, reason) => done([code, reason.toString()])))
    ws.on('open', () => resolve({ ws, next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise((r) => waiters.push(r))), closed }))
    ws.on('error', reject)
  })
}

describe('relay server', () => {
  it('answers health and serves the web client with a SPA fallback', async () => {
    const health = await fetch(`http://${base}/healthz`).then((r) => r.json())
    expect(health).toMatchObject({ ok: true, version: 'test', push: false })
    const index = await fetch(`http://${base}/`)
    expect(index.headers.get('content-type')).toContain('text/html')
    expect(await index.text()).toContain('Workhub')
    const fallback = await fetch(`http://${base}/pair`)
    expect(await fallback.text()).toContain('Workhub')
    const asset = await fetch(`http://${base}/assets/app-abc123.js`)
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect((await fetch(`http://${base}/missing.png`)).status).toBe(404)
    expect(index.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(index.headers.get('x-frame-options')).toBe('DENY')
    expect(index.headers.get('x-content-type-options')).toBe('nosniff')
    expect(health).not.toHaveProperty('uptimeSeconds')
  })

  it('survives a malformed escape in the path', async () => {
    expect((await fetch(`http://${base}/%E0%A4%A`)).status).toBe(404)
    expect((await fetch(`http://${base}/%`)).status).toBe(404)
    expect((await fetch(`http://${base}/healthz`)).status).toBe(200)
  })

  it('relays between two authenticated sockets', async () => {
    const desktop = generateIdentity()
    const phone = generateIdentity()
    const a = await connect()
    const b = await connect()
    const challengeA = await a.next()
    const challengeB = await b.next()
    if (challengeA.t !== 'challenge' || challengeB.t !== 'challenge') throw new Error('no challenge')
    a.ws.send(JSON.stringify(makeAuth(desktop, challengeA.nonce)))
    expect(await a.next()).toMatchObject({ t: 'welcome', id: desktop.id })
    b.ws.send(JSON.stringify(makeAuth(phone, challengeB.nonce)))
    expect(await b.next()).toMatchObject({ t: 'welcome', id: phone.id })
    a.ws.send(JSON.stringify({ t: 'join', room: desktop.id }))
    expect(await a.next()).toMatchObject({ t: 'joined' })
    b.ws.send(JSON.stringify({ t: 'join', room: desktop.id }))
    expect(await b.next()).toMatchObject({ t: 'joined', peers: [desktop.id] })
    expect(await a.next()).toMatchObject({ t: 'peer', id: phone.id, online: true })
    b.ws.send(JSON.stringify({ t: 'to', room: desktop.id, to: desktop.id, body: { k: 'enc', c: 'hello' } }))
    expect(await a.next()).toEqual({ t: 'from', room: desktop.id, from: phone.id, body: { k: 'enc', c: 'hello' } })
    b.ws.close()
    expect(await a.next()).toMatchObject({ t: 'peer', id: phone.id, online: false })
    a.ws.close()
  })

  it('keeps an authenticated socket open after an oversized frame and says it was too large', async () => {
    const desktop = generateIdentity()
    const a = await connect()
    const challenge = await a.next()
    if (challenge.t !== 'challenge') throw new Error('no challenge')
    a.ws.send(JSON.stringify(makeAuth(desktop, challenge.nonce)))
    expect(await a.next()).toMatchObject({ t: 'welcome' })
    a.ws.send(JSON.stringify({ t: 'join', room: desktop.id }))
    expect(await a.next()).toMatchObject({ t: 'joined' })
    a.ws.send(JSON.stringify({ t: 'to', room: desktop.id, to: desktop.id, body: { k: 'enc', c: 'x'.repeat(MAX_FRAME_BYTES + 1) } }))
    expect(await a.next()).toMatchObject({ t: 'error', code: 'too-large' })
    // Still connected: the next frame goes through.
    a.ws.send(JSON.stringify({ t: 'ping' }))
    expect(await a.next()).toMatchObject({ t: 'pong' })
    a.ws.close()
  })

  it('closes a socket that never authenticates', async () => {
    const c = await connect()
    expect(await c.closed).toEqual([1008, 'auth timeout'])
  })
})

describe('addressOf', () => {
  const req = (headers: Record<string, string>, remote = '203.0.113.9') => ({ headers, socket: { remoteAddress: remote } }) as unknown as Parameters<typeof addressOf>[0]
  it('ignores forwarded headers unless a proxy is trusted, then takes the last hop of the configured one', () => {
    expect(addressOf(req({ 'x-forwarded-for': '1.1.1.1' }), false)).toBe('203.0.113.9')
    // The client wrote 1.1.1.1; the proxy appended the real address last.
    expect(addressOf(req({ 'x-forwarded-for': '1.1.1.1, 198.51.100.7' }), true)).toBe('198.51.100.7')
    expect(addressOf(req({}), true)).toBe('203.0.113.9')
  })
  it('trusts only the configured header', () => {
    // A client-sent X-Real-IP is not the configured header, so it cannot pick the bucket.
    expect(addressOf(req({ 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '198.51.100.7' }), true)).toBe('198.51.100.7')
    expect(addressOf(req({ 'x-real-ip': '1.1.1.1' }), true)).toBe('203.0.113.9')
    expect(addressOf(req({ 'x-real-ip': '198.51.100.8', 'x-forwarded-for': '1.1.1.1' }), true, 'X-Real-IP')).toBe('198.51.100.8')
    expect(addressOf(req({ 'x-forwarded-for': '1.1.1.1' }), true, 'x-real-ip')).toBe('203.0.113.9')
  })
  it('buckets IPv6 addresses by their /64', () => {
    const a = addressOf(req({ 'x-forwarded-for': '2001:db8:1:2:aaaa:bbbb:cccc:dddd' }), true)
    expect(a).toBe('2001:db8:1:2::/64')
    expect(addressOf(req({ 'x-forwarded-for': '2001:DB8:1:2::1' }), true)).toBe(a)
    expect(addressOf(req({ 'x-forwarded-for': '2001:db8:1:3::1' }), true)).not.toBe(a)
    expect(addressOf(req({}, '2001:db8::5'), false)).toBe('2001:db8:0:0::/64')
    expect(addressOf(req({}, '::1'), false)).toBe('0:0:0:0::/64')
    expect(addressOf(req({}, '::ffff:198.51.100.7'), false)).toBe('198.51.100.7')
  })
})

describe('pushEndpointAllowed', () => {
  it('admits the browsers’ push services over https only', () => {
    expect(pushEndpointAllowed('https://fcm.googleapis.com/fcm/send/abc')).toBe(true)
    expect(pushEndpointAllowed('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true)
    expect(pushEndpointAllowed('https://web.push.apple.com/abc')).toBe(true)
    expect(pushEndpointAllowed('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true)
    expect(pushEndpointAllowed('https://10.0.0.5/internal')).toBe(false)
    expect(pushEndpointAllowed('http://fcm.googleapis.com/fcm/send/abc')).toBe(false)
    expect(pushEndpointAllowed('https://fcm.googleapis.com.evil.example/x')).toBe(false)
    expect(pushEndpointAllowed('https://push.example.com/x', ['push.example.com'])).toBe(true)
  })
})

describe('resolveStatic', () => {
  it('never leaves the root', () => {
    expect(resolveStatic(webDir, '/../index.html')).toBeNull()
    expect(resolveStatic(webDir, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull()
    expect(resolveStatic(webDir, '/')?.path).toBe(join(webDir, 'index.html'))
    expect(resolveStatic(webDir, '/anything?x=1')?.path).toBe(join(webDir, 'index.html'))
  })
})

describe('FilePushStore', () => {
  it('persists records across instances and writes the file privately', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-push-'))
    const path = join(dir, 'nested', 'push.json')
    const a = new FilePushStore(path)
    a.set('d1', { sub: { endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } }, rooms: ['r1'], updatedAt: 1 })
    // Writes are gathered; nothing is on disk until the delay passes or flush() is called.
    expect(() => readFileSync(path, 'utf8')).toThrow()
    a.flush()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveProperty('d1')
    const b = new FilePushStore(path)
    expect(b.get('d1')?.rooms).toEqual(['r1'])
    expect(b.size()).toBe(1)
    b.delete('d1')
    b.flush()
    expect(new FilePushStore(path).size()).toBe(0)
  })
})

describe('push TTL', () => {
  it('stays inside the window in which the phone still shows a push', () => {
    expect(PUSH_TTL_SECONDS).toBeGreaterThan(0)
    expect(PUSH_TTL_SECONDS * 1000).toBeLessThan(PUSH_MAX_AGE_MS)
  })
})

describe('sendStream', () => {
  const sink = () => {
    const res = new Writable({ write: (_c, _e, cb) => cb() })
    return res as Writable & { destroyed: boolean }
  }

  it('does not throw on a read error and cuts the response short', async () => {
    const res = sink()
    const source = new Readable({ read() {} })
    sendStream(source, res as never)
    source.destroy(new Error('EIO'))
    await new Promise((r) => setTimeout(r, 10))
    expect(res.destroyed).toBe(true)
  })

  it('closes the file when the client goes away', async () => {
    const res = sink()
    const source = new PassThrough()
    sendStream(source, res as never)
    res.destroy()
    await new Promise((r) => setTimeout(r, 10))
    expect(source.destroyed).toBe(true)
  })

  it('ends the response after a complete read', async () => {
    const chunks: string[] = []
    const res = new Writable({ write: (c, _e, cb) => (chunks.push(String(c)), cb()) })
    sendStream(Readable.from(['a', 'b']), res as never)
    await new Promise((r) => res.on('finish', r))
    expect(chunks.join('')).toBe('ab')
  })
})
