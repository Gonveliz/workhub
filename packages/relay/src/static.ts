// Serves the web client's built files next to the WebSocket: one origin for the phone to install
// as an app. Unknown paths without an extension fall back to index.html (the client routes by hash
// and fragment, but a bare path like /pair should still load).
import { createReadStream, realpathSync, statSync } from 'node:fs'
import { pipeline } from 'node:stream'
import type { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
}

/**
 * The file under `root` a request path names, or null when it escapes the root or does not exist.
 * The relay faces the internet, so containment is checked twice: on the resolved path and on the
 * real path (statSync follows symlinks, so a link inside the root must not lead out of it).
 */
export function resolveStatic(root: string, urlPath: string): { path: string; type: string; immutable: boolean } | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/')
  } catch {
    // A malformed escape (`/%E0`): not a file of ours.
    return null
  }
  // Decoded once only: a double-encoded `%252e` stays a literal name. A backslash is a separator on
  // Windows and never part of a name the web client uses.
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const rootAbs = resolve(root)
  const rootPrefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep
  // The request path is rooted at `/`; resolve it relative to the root so it can never be absolute.
  const wanted = resolve(rootAbs, '.' + sep + decoded.replace(/^\/+/, ''))
  if (wanted !== rootAbs && !wanted.startsWith(rootPrefix)) return null
  let rootReal: string
  try {
    rootReal = realpathSync(rootAbs)
  } catch {
    return null
  }
  const rootRealPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep
  const candidates = extname(decoded) ? [wanted] : [join(wanted, 'index.html'), join(rootAbs, 'index.html')]
  for (const candidate of candidates) {
    try {
      if (!candidate.startsWith(rootPrefix)) continue
      const real = realpathSync(candidate)
      if (real !== rootReal && !real.startsWith(rootRealPrefix)) continue
      if (!statSync(candidate).isFile()) continue
    } catch {
      continue
    }
    const ext = extname(candidate)
    // Vite names hashed assets under /assets/; they never change under the same name.
    return { path: candidate, type: TYPES[ext] ?? 'application/octet-stream', immutable: candidate.includes(`${sep}assets${sep}`) }
  }
  return null
}

export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): boolean {
  const found = resolveStatic(root, req.url ?? '/')
  if (!found) return false
  res.setHeader('Content-Type', found.type)
  res.setHeader('Cache-Control', found.immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  sendStream(createReadStream(found.path), res)
  return true
}

/**
 * Pipes a file to the response. `pipeline` closes the file when the client goes away and reports a
 * read error instead of leaving it unhandled (which would crash the process); on an error the
 * response is cut short, as headers are already out.
 */
export function sendStream(stream: Readable, res: ServerResponse): void {
  pipeline(stream, res, (err) => {
    if (err && !res.destroyed) res.destroy()
  })
}
