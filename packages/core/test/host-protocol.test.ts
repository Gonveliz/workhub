import { describe, expect, it } from 'vitest'
import {
  encodeHostMessage,
  HOST_MAX_LINE_BYTES,
  HOST_PROTOCOL_VERSION,
  isCompatibleHello,
  parseHostLine,
  utf8ByteLength,
  type HostHello,
  type HostMessage
} from '../src'

const hello: HostHello = {
  t: 'hello',
  protocol: HOST_PROTOCOL_VERSION,
  hostVersion: '1.2.3',
  features: ['exec', 'fs'],
  platform: 'linux',
  home: '/home/user',
  pathFlavor: 'posix'
}

describe('host protocol messages', () => {
  const messages: HostMessage[] = [
    hello,
    { t: 'req', id: 1, m: 'fs.read', p: { path: '/home/user/work/acme/README.md' } },
    { t: 'req', id: 2, m: 'host.info' },
    { t: 'res', id: 1, r: { text: 'hello' } },
    { t: 'res', id: 2 },
    { t: 'res', id: 3, e: { code: 'unknown_method', message: 'no such method: nope' } },
    { t: 'ev', ev: 'session.output', p: { id: 's1', data: 'línea ✓' } },
    { t: 'ev', ev: 'host.ready' }
  ]

  it.each(messages)('round-trips a $t message', (msg) => {
    const line = encodeHostMessage(msg)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(parseHostLine(line)).toEqual({ ok: true, msg })
  })

  it('accepts a line without its trailing newline', () => {
    expect(parseHostLine('{"t":"ev","ev":"x"}')).toEqual({ ok: true, msg: { t: 'ev', ev: 'x' } })
  })

  it('parses an error response as an error, not a result', () => {
    const parsed = parseHostLine('{"t":"res","id":7,"e":{"code":"timeout","message":"took too long"}}')
    expect(parsed.ok && parsed.msg.t === 'res' && 'e' in parsed.msg ? parsed.msg.e.code : null).toBe('timeout')
  })

  it('rejects an oversize line before parsing it', () => {
    const big = JSON.stringify({ t: 'ev', ev: 'x', p: 'a'.repeat(HOST_MAX_LINE_BYTES) })
    expect(parseHostLine(big)).toEqual({ ok: false, reason: 'too_large' })
  })

  it('counts UTF-8 bytes, not UTF-16 units, against the cap', () => {
    expect(utf8ByteLength('abc')).toBe(3)
    expect(utf8ByteLength('ñ')).toBe(2)
    expect(utf8ByteLength('✓')).toBe(3)
    expect(utf8ByteLength('😀')).toBe(4)
    expect(utf8ByteLength('\ud800')).toBe(3) // a lone surrogate is encoded as U+FFFD
    // Under the cap in UTF-16 units, over it in bytes.
    const wide = '✓'.repeat(Math.ceil(HOST_MAX_LINE_BYTES / 3) + 1)
    expect(wide.length).toBeLessThan(HOST_MAX_LINE_BYTES)
    expect(parseHostLine(wide)).toEqual({ ok: false, reason: 'too_large' })
  })

  it('rejects invalid JSON without throwing', () => {
    expect(parseHostLine('{"t":')).toEqual({ ok: false, reason: 'invalid_json' })
    expect(parseHostLine('')).toEqual({ ok: false, reason: 'invalid_json' })
  })

  it('rejects wrong shapes and unknown kinds', () => {
    for (const line of [
      '{"t":"nope"}',
      '[]',
      'null',
      '42',
      '{"t":"req","id":"1","m":"x"}',
      '{"t":"req","id":1.5,"m":"x"}',
      '{"t":"req","id":1}',
      '{"t":"res","id":1,"e":{"code":"weird","message":"x"}}',
      '{"t":"res","id":1,"r":1,"e":{"code":"internal","message":"both"}}',
      '{"t":"hello","protocol":1}'
    ]) {
      expect(parseHostLine(line), line).toEqual({ ok: false, reason: 'bad_shape' })
    }
  })

  it('refuses to encode an oversize message', () => {
    expect(() => encodeHostMessage({ t: 'ev', ev: 'x', p: 'a'.repeat(HOST_MAX_LINE_BYTES) })).toThrow(/too large/)
  })
})

describe('host hello compatibility', () => {
  const expected = { protocol: HOST_PROTOCOL_VERSION, hostVersion: '1.2.3' }

  it('accepts the expected protocol and version', () => {
    expect(isCompatibleHello(hello, expected)).toEqual({ ok: true })
  })

  it('reports a protocol mismatch first', () => {
    expect(isCompatibleHello({ ...hello, protocol: 2, hostVersion: '9.9.9' }, expected)).toEqual({ ok: false, reason: 'protocol_mismatch' })
  })

  it('reports a version mismatch', () => {
    expect(isCompatibleHello({ ...hello, hostVersion: '1.2.4' }, expected)).toEqual({ ok: false, reason: 'version_mismatch' })
  })
})
