/**
 * Shared redaction for anything that leaves the app as text: the main log, an agent's stderr tail
 * shown to the user and the diagnostics export. A best-effort filter for credential-looking
 * strings, not a guarantee: callers that can avoid the text altogether should.
 */

const MASK = '[redacted]'

/** Patterns that look like credentials, whatever error or output carried them. */
const SECRETS: RegExp[] = [
  /\b(xox[abposr]-|xapp-)[\w-]+/gi,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bglpat-[\w-]{10,}/g,
  /\bsk-[\w-]{10,}/g,
  /\b(bearer|basic|token)\s+[\w.~+/=-]{8,}/gi,
  /\b[A-Za-z0-9+_-]{32,}={0,2}/g
]

/** `name=value` and `"name": "value"` where the name says it is a secret; the name stays, the value goes. */
const NAMED_VALUE = /(\b[\w-]*(?:key|token|secret|passw(?:or)?d|credential|authorization)[\w-]*(?:["']?\s*=\s*|["']\s*:\s*))("[^"]*"|'[^']*'|[^\s"',;&]+)/gi

/** `scheme://user:password@host`: the credentials of a URL. */
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi

/** The text with anything that looks like a token replaced, cut to `max` characters (no cut when `max` is infinite). */
export function redactText(text: string, max = 300): string {
  let out = text.replace(NAMED_VALUE, (_m, name: string) => `${name}${MASK}`).replace(URL_CREDENTIALS, `$1${MASK}@`)
  for (const pattern of SECRETS) out = out.replace(pattern, MASK)
  return out.length > max ? `${out.slice(0, max)}…` : out
}

/** Property names whose value is a secret or a place on the disk, whatever the value looks like. */
const SECRET_KEY = /(key|token|secret|passw(?:or)?d|credential|authorization|cookie|session)/i
const PATH_KEY = /(path|dir|folder|cwd|file|workspace|root|home)$/i
/** Maps whose values are free-form (environment variables, headers): any of them may hold a secret. */
const FREE_FORM_KEY = /^(env|environment|headers|extraHeaders)$/i

const PATH_MASK = '[path]'
/** A value that starts like a path: `/x`, `~/x`, `C:\x`, `\\server\x`, `file://…`. */
const PATH_VALUE = /^(?:~|file:\/\/|[A-Za-z]:[\\/]|\\\\|\/)/
/** A path inside a longer string: after whitespace, a quote or `=`. */
const PATH_INSIDE = /(^|[\s"'=(])(?:~|[A-Za-z]:)?[\\/][^\s"'<>|)]*/g

/** A string with its paths replaced by `[path]`. */
export function redactPaths(text: string): string {
  return PATH_VALUE.test(text) && !/\s/.test(text) ? PATH_MASK : text.replace(PATH_INSIDE, `$1${PATH_MASK}`)
}

/**
 * A copy of a JSON-like value that is safe to put in a diagnostics folder: values under secret-like
 * names are masked, so are environment and header maps, every path, and credential-looking strings.
 * Keys, numbers, booleans and structure stay, so the shape of the config can still be read.
 */
export function redactConfig(value: unknown, key = ''): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || value === undefined) return value
  if (typeof value === 'string') {
    if (!value) return value
    if (SECRET_KEY.test(key)) return MASK
    if (PATH_KEY.test(key) && PATH_VALUE.test(value)) return PATH_MASK
    return redactPaths(redactText(value, Infinity))
  }
  if (Array.isArray(value)) return value.map((v) => redactConfig(v, key))
  if (typeof value === 'object') {
    const free = FREE_FORM_KEY.test(key)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = free && typeof v === 'string' && v ? MASK : redactConfig(v, k)
    }
    return out
  }
  return undefined
}
