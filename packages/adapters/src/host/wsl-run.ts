// Runs `wsl.exe` for the WSL helpers in core (listing distributions, reading one): no shell, the
// arguments as a list, the output decoded from whichever encoding `wsl.exe` wrote it in.
import { execFile } from 'node:child_process'
import type { WslRun, WslRunResult } from '@workhub/core'

/**
 * Decodes `wsl.exe` output. Its own messages and listings are UTF-16LE (often with a BOM) when it
 * runs from Windows, and UTF-8 with `WSL_UTF8=1` or when it runs from inside WSL; what a Linux
 * program in the distribution prints passes through as it was written (UTF-8). The BOM and stray
 * NULs are dropped.
 */
export function decodeWslOutput(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let utf16 = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe
  if (!utf16 && buf.length >= 2) {
    // ASCII text in UTF-16LE has a NUL after (nearly) every character.
    let oddNuls = 0
    for (let i = 1; i < buf.length; i += 2) if (buf[i] === 0) oddNuls++
    utf16 = oddNuls * 2 >= Math.floor(buf.length / 2)
  }
  return buf.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '').replace(/\0/g, '')
}

export function wslRunner(options: { command?: string; timeoutMs?: number } = {}): WslRun {
  const command = options.command ?? 'wsl.exe'
  return (args) =>
    new Promise<WslRunResult>((resolve) => {
      execFile(command, args, { encoding: 'buffer', windowsHide: true, timeout: options.timeoutMs ?? 20_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
        resolve({ code, stdout: decodeWslOutput(stdout), stderr: decodeWslOutput(stderr) })
      })
    })
}
