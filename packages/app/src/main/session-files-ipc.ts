/**
 * The files the composer's `@` menu offers: a session's folder, listed on the main side. The
 * renderer names a session, never a path. A listing is kept for a few seconds per session, so
 * typing after the `@` does not run git again, and two asks at once share one run.
 */
import { listSessionFiles, type SessionFiles } from '@workhub/adapters/session-files'
import type { IpcRegistrar } from './ipc-guard'

/** How long a listing answers further asks. */
export const SESSION_FILES_TTL_MS = 5_000

export interface SessionFilesDeps {
  /** The session's folder or worktree; null for an unknown session. */
  cwdOf: (id: string) => string | null
  list?: (cwd: string) => Promise<SessionFiles>
  now?: () => number
}

export function createSessionFiles(deps: SessionFilesDeps): (id: unknown) => Promise<SessionFiles> {
  const list = deps.list ?? ((cwd: string) => listSessionFiles(cwd))
  const now = deps.now ?? Date.now
  const cache = new Map<string, { cwd: string; at: number; result: Promise<SessionFiles> }>()
  return async (id) => {
    const cwd = typeof id === 'string' ? deps.cwdOf(id) : null
    if (typeof id !== 'string' || !cwd) return { files: [], truncated: false }
    const hit = cache.get(id)
    if (hit && hit.cwd === cwd && now() - hit.at < SESSION_FILES_TTL_MS) return hit.result
    const result = list(cwd).catch(() => ({ files: [], truncated: false }))
    cache.set(id, { cwd, at: now(), result })
    return result
  }
}

export function registerSessionFilesIpc(ipc: IpcRegistrar, deps: SessionFilesDeps): void {
  const files = createSessionFiles(deps)
  ipc.handle('sessions:files', (_e, id: unknown) => files(id))
}
