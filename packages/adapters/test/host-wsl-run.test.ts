import { describe, expect, it } from 'vitest'
import { decodeWslOutput, wslRunner } from '../src/host'

// A stand-in for wsl.exe: Node itself, so the runner's handling of arguments and bytes is checked on any OS.
const node = process.execPath

const utf16 = (text: string, bom = true): Uint8Array => new Uint8Array(Buffer.concat([Buffer.from(bom ? [0xff, 0xfe] : []), Buffer.from(text, 'utf16le')]))

describe('decodeWslOutput', () => {
  it('reads UTF-16LE with or without a BOM, and UTF-8, dropping the BOM and NUL padding', () => {
    expect(decodeWslOutput(utf16('Ubuntu\r\nDebian\r\n'))).toBe('Ubuntu\r\nDebian\r\n')
    expect(decodeWslOutput(utf16('Ubuntu\r\n', false))).toBe('Ubuntu\r\n')
    expect(decodeWslOutput(utf16('Ubuntu\r\n\u0000\u0000'))).toBe('Ubuntu\r\n')
    expect(decodeWslOutput(utf16('No hay ninguna distribución\r\n'))).toBe('No hay ninguna distribución\r\n')
    expect(decodeWslOutput(Buffer.from('Ubuntu\r\n'))).toBe('Ubuntu\r\n')
    expect(decodeWslOutput(Buffer.from('\uFEFFdistribución\u0000'))).toBe('distribución')
    expect(decodeWslOutput(new Uint8Array())).toBe('')
  })
})

describe('wslRunner', () => {
  it('passes the arguments as a list, without a shell, and decodes UTF-16LE output', async () => {
    const run = wslRunner({ command: node })
    const r = await run(['-e', "process.stdout.write(Buffer.from('\\ufeff' + process.argv.slice(1).join('|'), 'utf16le'))", 'a b', '$HOME', ';', 'x'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('a b|$HOME|;|x')
  })

  it('reports a failed run as its exit code, and a missing command as -1', async () => {
    expect((await wslRunner({ command: node })(['-e', 'process.exit(3)'])).code).toBe(3)
    expect((await wslRunner({ command: '/w/acme/no-such-wsl.exe' })(['-l', '-q'])).code).toBe(-1)
  })
})
