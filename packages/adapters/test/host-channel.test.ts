import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { HOST_MAX_LINE_BYTES, type HostMessage } from '@workhub/core'
import { HostChannel, type HostChannelNotice } from '../src/host'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function setup() {
  const input = new PassThrough()
  const output = new PassThrough()
  const messages: HostMessage[] = []
  const notices: HostChannelNotice[] = []
  const channel = new HostChannel(input, output, { onNotice: (n) => notices.push(n) })
  channel.onMessage((m) => messages.push(m))
  return { input, output, channel, messages, notices }
}

const event = (ev: string, p?: unknown): HostMessage => ({ t: 'ev', ev, p })

describe('HostChannel', () => {
  it('reads one message per line, across chunk boundaries', async () => {
    const { input, messages } = setup()
    const line = JSON.stringify(event('out', 'hello')) + '\n'
    input.write(line.slice(0, 7))
    input.write(line.slice(7) + JSON.stringify(event('second')).slice(0, 4))
    await tick()
    expect(messages).toEqual([event('out', 'hello')])
    input.write(JSON.stringify(event('second')).slice(4) + '\r\n')
    await tick()
    expect(messages).toEqual([event('out', 'hello'), event('second')])
  })

  it('decodes a multi-byte character split across chunks', async () => {
    const { input, messages, notices } = setup()
    const bytes = Buffer.from(JSON.stringify(event('out', 'añ€😀b')) + '\n', 'utf8')
    const cut = bytes.indexOf(Buffer.from('😀', 'utf8')) + 2
    input.write(bytes.subarray(0, cut))
    await tick()
    input.write(bytes.subarray(cut))
    await tick()
    expect(notices).toEqual([])
    expect(messages).toEqual([event('out', 'añ€😀b')])
  })

  it('drops an oversize line while it is still buffering, then keeps reading', async () => {
    const { input, messages, notices } = setup()
    const piece = 'a'.repeat(64 * 1024)
    for (let sent = 0; sent <= HOST_MAX_LINE_BYTES; sent += piece.length) input.write(piece)
    await tick()
    // Reported before the newline ever arrives, so the buffer never holds the whole line.
    expect(notices).toEqual([{ kind: 'malformed', reason: 'too_large' }])
    input.write(piece + '\n' + JSON.stringify(event('after')) + '\n')
    await tick()
    expect(notices).toHaveLength(1)
    expect(messages).toEqual([event('after')])
  })

  it('reports malformed lines and keeps the channel open', async () => {
    const { input, channel, messages, notices } = setup()
    input.write('not json\n\n{"t":"nope"}\n' + JSON.stringify(event('ok')) + '\n')
    await tick()
    expect(notices).toEqual([
      { kind: 'malformed', reason: 'invalid_json' },
      { kind: 'malformed', reason: 'bad_shape' }
    ])
    expect(messages).toEqual([event('ok')])
    expect(channel.closed).toBe(false)
  })

  it('reads a last line without a trailing newline when the input ends', async () => {
    const { input, messages } = setup()
    input.end(JSON.stringify(event('last')))
    await tick()
    expect(messages).toEqual([event('last')])
  })

  it('writes encoded lines and stops writing once closed', async () => {
    const { output, channel } = setup()
    let written = ''
    output.on('data', (c: Buffer) => (written += c.toString('utf8')))
    expect(channel.send(event('x', 1))).toBe(true)
    channel.close()
    expect(channel.send(event('y'))).toBe(false)
    await tick()
    expect(written).toBe(JSON.stringify(event('x', 1)) + '\n')
    expect(output.writableEnded).toBe(true)
  })

  it('notifies close once, with the error when a stream fails', async () => {
    const { input, channel } = setup()
    const reasons: (Error | undefined)[] = []
    channel.onClose((err) => reasons.push(err))
    input.destroy(new Error('pipe broke'))
    await tick()
    channel.close()
    expect(reasons).toHaveLength(1)
    expect(reasons[0]?.message).toBe('pipe broke')
    expect(channel.closed).toBe(true)
  })

  it('closes cleanly when the input ends', async () => {
    const { input, channel } = setup()
    const reasons: (Error | undefined)[] = []
    channel.onClose((err) => reasons.push(err))
    input.end()
    await tick()
    expect(reasons).toEqual([undefined])
  })
})
