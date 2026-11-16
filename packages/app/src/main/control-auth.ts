/**
 * Who a request to the local control endpoint is. Reaching the endpoint (the socket's file mode, or
 * the per-launch token on Windows) only says the caller is one of the user's processes; which
 * session it speaks for is proven by a token minted for that session when it starts
 * (`WORKHUB_SESSION_TOKEN`, sent as `X-Workhub-Token`) and revoked when the session is removed.
 *
 * - With a session token the request acts as that session and nothing else: a `session` it names
 *   must be its own, the session is filled in where it left it out, and a read-only (reviewer)
 *   session cannot change anything. Its profile is then the session's (`resolveControlProfile`).
 * - Without one, only reads of the active profile's plan and automations are answered (the
 *   user's own `curl` in a terminal), with a warning in the log. Every change, History and
 *   analytics (which read across profiles) and the list of sessions need a token, and so does
 *   naming a session or a profile.
 */
import { createHash, randomBytes } from 'node:crypto'

/** The header that carries a session's token. */
export const SESSION_TOKEN_HEADER = 'x-workhub-token'

/** The tokens of the running sessions, kept as hashes: a lookup by hash leaks nothing through timing. */
export class ControlTokens {
  private readonly bySession = new Map<string, string>()
  private readonly byHash = new Map<string, string>()

  /** A new token for a session (one it had before stops working). */
  mint(sessionId: string): string {
    this.revoke(sessionId)
    const token = randomBytes(32).toString('hex')
    const hash = hashOf(token)
    this.bySession.set(sessionId, hash)
    this.byHash.set(hash, sessionId)
    return token
  }

  /** The session's token stops working (the session was removed). */
  revoke(sessionId: string): void {
    const hash = this.bySession.get(sessionId)
    if (hash === undefined) return
    this.bySession.delete(sessionId)
    this.byHash.delete(hash)
  }

  /** The session a token was minted for; undefined for a token never minted or revoked. */
  sessionOf(token: string): string | undefined {
    return token ? this.byHash.get(hashOf(token)) : undefined
  }

  /** The endpoint's view of these tokens over the listed sessions: a token whose session left the list is refused too. */
  auth(sessions: () => readonly { id: string; readOnly?: boolean }[]): ControlAuth {
    const find = (id: string) => sessions().find((s) => s.id === id)
    return {
      sessionOf: (token) => {
        const id = this.sessionOf(token)
        return id !== undefined && find(id) ? id : undefined
      },
      readOnly: (id) => find(id)?.readOnly === true
    }
  }
}

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')

/** How the endpoint learns who a token is. */
export interface ControlAuth {
  /** The live session a token belongs to; undefined when unknown, revoked or its session is gone. */
  sessionOf(token: string): string | undefined
  /** Whether a session is read-only (an AI reviewer). */
  readOnly(sessionId: string): boolean
}

/** The caller of a request: a session (proven by its token), or null for a request without a token. */
export type ControlCaller = { session: string; readOnly: boolean } | null

export type ControlAuthResult = { ok: true; caller: ControlCaller } | { ok: false; status: number; error: string }

/** The reads answered without a session token, for the active profile only. */
const ANONYMOUS_READS = new Set(['/v1/plan/today', '/v1/inbox', '/v1/milestones', '/v1/people', '/v1/automations'])
/** The one route a POST only reads through. */
const READ_POSTS = new Set(['/v1/analytics/query'])
const NEEDS_TOKEN = 'this needs the session token: send X-Workhub-Token: $WORKHUB_SESSION_TOKEN (changes, History and analytics are refused without it)'

/**
 * Checks a request's token and binds its query to the caller: with a token, `session` becomes the
 * caller's (a different one is refused); without, only `ANONYMOUS_READS` with no `session`,
 * `profile` or `cwd` pass. The token itself is never logged.
 */
export function authorizeControl(auth: ControlAuth, req: { method?: string | undefined; headers: Record<string, string | string[] | undefined> }, url: URL, log?: (message: string) => void): ControlAuthResult {
  const raw = req.headers[SESSION_TOKEN_HEADER]
  const token = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? ''
  const method = req.method ?? 'GET'
  const write = method !== 'GET' && !READ_POSTS.has(url.pathname)
  if (!token) {
    if (method !== 'GET' || !ANONYMOUS_READS.has(url.pathname)) return { ok: false, status: 401, error: NEEDS_TOKEN }
    if (['session', 'profile', 'cwd'].some((k) => url.searchParams.has(k))) return { ok: false, status: 401, error: `without a session token only the active profile can be read (leave out session, profile and cwd); ${NEEDS_TOKEN}` }
    log?.(`control endpoint: ${method} ${url.pathname} without a session token, answered for the active profile (a later version may refuse it)`)
    return { ok: true, caller: null }
  }
  const session = auth.sessionOf(token)
  if (!session) return { ok: false, status: 401, error: 'unknown or revoked session token' }
  const claimed = url.searchParams.get('session')
  if (claimed !== null && claimed !== session) return { ok: false, status: 403, error: 'a session token acts only as its own session' }
  const review = /^\/v1\/sessions\/([^/]+)\/review$/.exec(url.pathname)
  if (review && review[1] !== session) return { ok: false, status: 403, error: 'a session token acts only as its own session' }
  const readOnly = auth.readOnly(session)
  if (readOnly && write) return { ok: false, status: 403, error: 'a read-only (reviewer) session cannot change anything' }
  url.searchParams.set('session', session)
  return { ok: true, caller: { session, readOnly } }
}

/**
 * A JSON body bound to the caller: a `session` it names must be the caller's, and the caller's is
 * filled in, so a handler reading the body's session (the inbox proposals) sees the proven one.
 */
export function bindBody(body: unknown, caller: ControlCaller): { ok: true; body: unknown } | { ok: false; status: number; error: string } {
  if (!caller || !body || typeof body !== 'object' || Array.isArray(body)) return { ok: true, body }
  const claimed = (body as Record<string, unknown>)['session']
  if (claimed !== undefined && claimed !== null && claimed !== caller.session) return { ok: false, status: 403, error: 'a session token acts only as its own session' }
  return { ok: true, body: { ...(body as Record<string, unknown>), session: caller.session } }
}
