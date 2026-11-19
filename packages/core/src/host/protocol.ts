// The wire protocol between the app and a `workhub host` process (inside a WSL distro, or a local
// child process): newline-delimited JSON, one message per line, over the host's stdio.
import { z } from 'zod'

export const HOST_PROTOCOL_VERSION = 1
/** The largest line either side accepts, in UTF-8 bytes (without the trailing newline). */
export const HOST_MAX_LINE_BYTES = 1024 * 1024
/** How long a request waits for its response unless the caller says otherwise. */
export const HOST_REQUEST_TIMEOUT_MS = 30_000

export const HOST_ERROR_CODES = ['unknown_method', 'bad_params', 'timeout', 'closed', 'too_large', 'internal'] as const
export const hostErrorCodeSchema = z.enum(HOST_ERROR_CODES)
export type HostErrorCode = z.infer<typeof hostErrorCodeSchema>

const requestId = z.number().int().nonnegative()

/** First line the host writes: what it is and what it can do. */
export const hostHelloSchema = z.object({
  t: z.literal('hello'),
  protocol: z.number().int(),
  hostVersion: z.string(),
  features: z.array(z.string()),
  platform: z.enum(['linux', 'darwin', 'win32']),
  home: z.string(),
  pathFlavor: z.enum(['posix', 'win32'])
})
export type HostHello = z.infer<typeof hostHelloSchema>

export const hostRequestSchema = z.object({ t: z.literal('req'), id: requestId, m: z.string().min(1), p: z.unknown().optional() })
export type HostRequest = z.infer<typeof hostRequestSchema>

// Strict, so a response carries either a result or an error, never both.
export const hostResultSchema = z.strictObject({ t: z.literal('res'), id: requestId, r: z.unknown().optional() })
export const hostErrorResponseSchema = z.strictObject({
  t: z.literal('res'),
  id: requestId,
  e: z.object({ code: hostErrorCodeSchema, message: z.string() })
})
export const hostResponseSchema = z.union([hostResultSchema, hostErrorResponseSchema])
export type HostResponse = z.infer<typeof hostResponseSchema>

/** Something that happened on the host, not tied to a request (output, exits, file changes). */
export const hostEventSchema = z.object({ t: z.literal('ev'), ev: z.string().min(1), p: z.unknown().optional() })
export type HostEvent = z.infer<typeof hostEventSchema>

// A plain union: zod's discriminatedUnion allows one option per `t`, and a response has two shapes.
// The inferred type is still a union discriminated on `t`.
export const hostMessageSchema = z.union([hostHelloSchema, hostRequestSchema, hostResultSchema, hostErrorResponseSchema, hostEventSchema])
export type HostMessage = z.infer<typeof hostMessageSchema>

export type HostLineRejection = 'too_large' | 'invalid_json' | 'bad_shape'
export type ParsedHostLine = { ok: true; msg: HostMessage } | { ok: false; reason: HostLineRejection }

/** UTF-8 length of a string (core has no TextEncoder); a lone surrogate counts as U+FFFD. */
export function utf8ByteLength(s: string): number {
  let bytes = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

// A UTF-16 unit is 1 to 3 bytes: only count when the cheap bounds do not decide.
function tooLarge(s: string): boolean {
  if (s.length > HOST_MAX_LINE_BYTES) return true
  return s.length * 3 > HOST_MAX_LINE_BYTES && utf8ByteLength(s) > HOST_MAX_LINE_BYTES
}

/** Reads one line from the peer. Never throws: a bad line is reported, not fatal. */
export function parseHostLine(line: string): ParsedHostLine {
  const text = line.endsWith('\n') ? line.slice(0, line.endsWith('\r\n') ? -2 : -1) : line
  if (tooLarge(text)) return { ok: false, reason: 'too_large' }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }
  const parsed = hostMessageSchema.safeParse(json)
  return parsed.success ? { ok: true, msg: parsed.data } : { ok: false, reason: 'bad_shape' }
}

/** One message as a line to write. Throws when it would exceed the line cap. */
export function encodeHostMessage(msg: HostMessage): string {
  const text = JSON.stringify(msg)
  if (tooLarge(text)) throw new Error(`host message too large: ${utf8ByteLength(text)} bytes (max ${HOST_MAX_LINE_BYTES})`)
  return text + '\n'
}

export type HelloMismatch = 'protocol_mismatch' | 'version_mismatch'

/** Whether a host's hello is the one this app expects (same protocol, same host build). */
export function isCompatibleHello(
  hello: HostHello,
  expected: { protocol: number; hostVersion: string }
): { ok: true } | { ok: false; reason: HelloMismatch } {
  if (hello.protocol !== expected.protocol) return { ok: false, reason: 'protocol_mismatch' }
  if (hello.hostVersion !== expected.hostVersion) return { ok: false, reason: 'version_mismatch' }
  return { ok: true }
}
