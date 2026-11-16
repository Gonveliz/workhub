// What a session changed, as a paired device reads it: the changed files of the session's
// repositories (`remote:changes`) and one file's diff (`remote:diff`), each a page at a time so every
// answer fits one relay frame. Both come from the desktop's own local review (local-review.ts), read
// only. A device names a file only as the list named it (repository key and path), and gets a diff
// only for a file in that list: it never names a path on this computer.
import type { DiffLine, LocalReview, LocalReviewFile, LocalReviewScope } from '@workhub/core'
import type { SessionView } from '../../shared/api'
import type { LocalReviewLoad } from '../../shared/local-review-api'
import type { RemoteChangedFile, RemoteChangedRepo, RemoteChangesPage, RemoteDiffPage, RemoteDiffPiece } from '../../shared/remote-changes-api'
import type { IpcRegistrar } from '../ipc-guard'
import { RemoteRefused } from './dispatcher'
import { hasSecretPart } from './files'
import { pageOf, PageRequestError, readPageRequest, sizeOf, type PageRequest } from './paging'

/** How long a loaded review answers further pages and diffs before git is read again. */
export const CHANGES_CACHE_MS = 60_000
/** Sessions whose last review is kept; the oldest goes first. */
const CACHE_MAX = 8
/** Characters of one diff line a device gets; a minified line would otherwise fill a page alone. */
export const DIFF_LINE_MAX = 2_000
/** Bytes of JSON one piece of a hunk stops before, so a page holds a few and never one too large. */
export const DIFF_PIECE_BYTES = 48 * 1024
/** Bytes of JSON the repositories of an answer stop before; a container folder with more is cut (their files still page). */
const REPOS_BYTES = 64 * 1024
const NAME_MAX = 200
/** A repository key or file path longer than this is not one the list sent. */
const ARG_MAX = 4_096

export interface RemoteChangesDeps {
  sessions(): SessionView[]
  /** The desktop's local review of the session (LocalReviewService.load), every change of its repos. */
  load(sessionId: string, scope: LocalReviewScope): Promise<LocalReviewLoad>
  now?: () => number
}

interface Loaded {
  at: number
  review: LocalReview
  /** The repositories' keys, in the order of `review.repos`. */
  keys: string[]
}

const scopeOf = (value: unknown): LocalReviewScope => (value === 'uncommitted' ? 'uncommitted' : 'branch')

/** Folder names made unique (`api`, `api#2`): what a device calls a repository instead of its path. */
export function repoKeys(review: LocalReview): string[] {
  const seen = new Map<string, number>()
  return review.repos.map((r) => {
    const name = String(r.name).slice(0, NAME_MAX)
    const n = (seen.get(name) ?? 0) + 1
    seen.set(name, n)
    return n === 1 ? name : `${name}#${n}`
  })
}

/** A changed file as a device sees it: counts and status, never its content; a secret-like name says so. */
export function remoteChangedFile(repo: string, f: LocalReviewFile): RemoteChangedFile {
  const note = hasSecretPart(f.path) || (f.oldPath !== undefined && hasSecretPart(f.oldPath)) ? 'hidden' : f.note
  return {
    repo,
    path: f.path,
    ...(f.oldPath ? { oldPath: f.oldPath } : {}),
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    binary: f.binary,
    untracked: f.untracked,
    ...(note ? { note } : {}),
    hiddenLines: f.hiddenLines
  }
}

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * A file's hunks as pieces of at most about `DIFF_PIECE_BYTES` each: a long hunk is split into runs
 * of lines, and a line longer than `DIFF_LINE_MAX` characters is cut.
 */
export function diffPieces(file: Pick<LocalReviewFile, 'hunks'>): RemoteDiffPiece[] {
  const pieces: RemoteDiffPiece[] = []
  file.hunks.forEach((h, hunk) => {
    const header = cut(String(h.header ?? ''), DIFF_LINE_MAX)
    let piece: RemoteDiffPiece = { hunk, header, start: 0, lines: [] }
    let bytes = sizeOf(piece)
    h.lines.forEach((line, i) => {
      const text = cut(String(line.text ?? ''), DIFF_LINE_MAX)
      const out: DiffLine = { ...line, text }
      const size = sizeOf(out) + 1
      if (piece.lines.length > 0 && bytes + size > DIFF_PIECE_BYTES) {
        pieces.push(piece)
        piece = { hunk, header, start: i, lines: [] }
        bytes = sizeOf(piece)
      }
      piece.lines.push(out)
      if (text !== line.text) piece.cutLines = (piece.cutLines ?? 0) + 1
      bytes += size
    })
    pieces.push(piece)
  })
  return pieces
}

function pageRequest(value: unknown): PageRequest {
  try {
    return readPageRequest(value)
  } catch (err) {
    if (err instanceof PageRequestError) throw new RemoteRefused(err.message)
    throw err
  }
}

export class RemoteChanges {
  private readonly cache = new Map<string, Loaded>()
  private readonly now: () => number

  constructor(private readonly deps: RemoteChangesDeps) {
    this.now = deps.now ?? Date.now
  }

  /** The session's review in `scope`: the cached one while fresh (and `fresh` is not asked), else read again. */
  private async loaded(sessionId: string, scope: LocalReviewScope, fresh: boolean): Promise<Loaded | { ok: false; reason: 'unknownSession' | 'failed' }> {
    if (!this.deps.sessions().some((v) => v.id === sessionId)) return { ok: false, reason: 'unknownSession' }
    const key = `${sessionId}\0${scope}`
    const hit = this.cache.get(key)
    if (!fresh && hit && this.now() - hit.at < CHANGES_CACHE_MS) return hit
    const load = await this.deps.load(sessionId, scope)
    // The desktop's error text can name local paths: the device gets the reason only.
    if (!load.ok) return { ok: false, reason: load.reason === 'unknownSession' ? 'unknownSession' : 'failed' }
    const entry: Loaded = { at: this.now(), review: load.review, keys: repoKeys(load.review) }
    this.cache.delete(key)
    this.cache.set(key, entry)
    this.prune()
    return entry
  }

  /** Drops reviews of sessions that closed, and the oldest past `CACHE_MAX`. */
  private prune(): void {
    const open = new Set(this.deps.sessions().map((v) => v.id))
    for (const key of [...this.cache.keys()]) if (!open.has(key.split('\0')[0]!)) this.cache.delete(key)
    while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!)
  }

  /** `remote:changes`: the repositories and a page of the changed files. A first page reads git again. */
  async changes(sessionId: unknown, raw: unknown): Promise<RemoteChangesPage> {
    if (typeof sessionId !== 'string') throw new RemoteRefused('a session is required')
    const request = pageRequest(raw)
    const scope = scopeOf((raw as { scope?: unknown } | null | undefined)?.scope)
    const loaded = await this.loaded(sessionId, scope, request.cursor === null)
    if ('ok' in loaded) return loaded
    const { review, keys } = loaded
    const repos: RemoteChangedRepo[] = []
    let bytes = 0
    for (const [i, r] of review.repos.entries()) {
      const repo: RemoteChangedRepo = {
        key: keys[i]!,
        name: cut(String(r.name), NAME_MAX),
        branch: r.branch === null ? null : cut(String(r.branch), NAME_MAX),
        ...(r.base ? { base: cut(r.base, NAME_MAX) } : {}),
        ...(r.note ? { note: r.note } : {}),
        files: r.files.length
      }
      bytes += sizeOf(repo)
      if (bytes > REPOS_BYTES) break
      repos.push(repo)
    }
    const files = review.repos.flatMap((r, i) => r.files.map((f) => remoteChangedFile(keys[i]!, f)))
    return { ok: true, scope, repos, files: pageOf(files, request, (f) => `${f.repo}\0${f.path}`) }
  }

  /**
   * `remote:diff`: a page of one file's diff. The file must be one the session's review lists (read
   * again once when the cached list does not have it); anything else is refused.
   */
  async diff(sessionId: unknown, raw: unknown): Promise<RemoteDiffPage> {
    if (typeof sessionId !== 'string') throw new RemoteRefused('a session is required')
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const repo = o['repo']
    const path = o['path']
    if (typeof repo !== 'string' || typeof path !== 'string' || !repo || !path || repo.length > ARG_MAX || path.length > ARG_MAX) throw new RemoteRefused('a repository and a file are required')
    const request = pageRequest(raw)
    const scope = scopeOf(o['scope'])
    let found = await this.find(sessionId, scope, repo, path, false)
    if (!found && request.cursor === null) found = await this.find(sessionId, scope, repo, path, true)
    if (!found) throw new RemoteRefused('the file is not among the session’s changes')
    const file = remoteChangedFile(repo, found)
    // A dotfile or key-like name is listed but never read out, as remote:file refuses it.
    const pieces = file.note === 'hidden' || found.binary ? [] : diffPieces(found)
    return { file, pieces: pageOf(pieces, request, (p) => `${p.hunk}:${p.start}`) }
  }

  private async find(sessionId: string, scope: LocalReviewScope, repo: string, path: string, fresh: boolean): Promise<LocalReviewFile | null> {
    const loaded = await this.loaded(sessionId, scope, fresh)
    if ('ok' in loaded) {
      if (loaded.reason === 'unknownSession') throw new RemoteRefused('the session is not open')
      throw new RemoteRefused('the changes could not be read')
    }
    const at = loaded.keys.indexOf(repo)
    if (at < 0) return null
    return loaded.review.repos[at]!.files.find((f) => f.path === path) ?? null
  }
}

/** Registers `remote:changes` and `remote:diff` (reached only through the remote allowlist). */
export function registerRemoteChangesIpc(ipc: IpcRegistrar, changes: RemoteChanges): void {
  ipc.handle('remote:changes', (_e, sessionId: unknown, request: unknown) => changes.changes(sessionId, request))
  ipc.handle('remote:diff', (_e, sessionId: unknown, request: unknown) => changes.diff(sessionId, request))
}
