import type { AgentReviewService } from '../agent-review'
import type { AiReviewService } from '../ai-review'
import type { IpcRegistrar } from '../ipc-guard'
import type { LocalReviewService } from '../local-review'
import { pageHistory, readActivity, readRemoteFile, registerRemoteIpc, touchedPaths, type RemoteActivityLog, type RemoteService } from '../remote'
import { RemoteChanges, registerRemoteChangesIpc } from '../remote/changes'
import { registerRemoteReviewIpc } from '../remote/review'
import type { SessionManager } from '../session-manager'

export interface RemoteIpcDeps {
  remoteService: RemoteService
  sessions: SessionManager
  remoteActivity: RemoteActivityLog
  localReview: Pick<LocalReviewService, 'load'>
  aiReview: AiReviewService
  agentReview: AgentReviewService
}

/** Remote access settings and what only paired devices ask for (`remote:*`). */
export function registerRemoteAccessIpc(ipc: IpcRegistrar, deps: RemoteIpcDeps): void {
  const { sessions, remoteActivity, localReview, aiReview, agentReview } = deps
  registerRemoteIpc(ipc, deps.remoteService)
  // A paired device reads a file the agent made inside the session's folder, or an image outside it that
  // the session's own agent read or wrote (see remote/allowlist.ts). Containment is checked again on the
  // real paths, symlinks resolved, and secret-like names are refused (remote/files.ts).
  ipc.handle('remote:file', (_e, id: unknown, path: unknown) => {
    if (typeof id !== 'string' || typeof path !== 'string') throw new Error('a session and a path are required')
    const view = sessions.list().find((v) => v.id === id)
    if (!view) throw new Error('the session is not open')
    return readRemoteFile(view.cwd, path, async () => touchedPaths(view.cwd, await sessions.history(id)))
  })
  // A paired device reads an open session's conversation a page at a time (see remote/history.ts):
  // it only sees live events, so this is how it shows what was said before it connected.
  ipc.handle('remote:history', async (_e, id: unknown, before: unknown) => {
    if (typeof id !== 'string') throw new Error('a session is required')
    if (before !== undefined && (typeof before !== 'number' || !Number.isInteger(before) || before < 0)) throw new Error('before must be a message index')
    if (!sessions.list().some((v) => v.id === id)) throw new Error('the session is not open')
    return pageHistory(await sessions.history(id), before)
  })
  // A paired device that connected while sub-agents or background tasks ran reads them here, for one
  // session or a list (see remote/activity.ts).
  ipc.handle('remote:activity', (_e, ids: unknown) => readActivity(remoteActivity, () => sessions.list().map((v) => v.id), ids))
  // A paired device reads what a session changed, through the desktop's own local review (remote/changes.ts),
  // and takes the decisions its review loop offers while it waits for the person (remote/review.ts).
  registerRemoteChangesIpc(ipc, new RemoteChanges({ sessions: () => sessions.list(), load: (id, scope) => localReview.load(id, scope, 'repo') }))
  registerRemoteReviewIpc(ipc, {
    sessions: () => sessions.list(),
    reviews: () => aiReview.snapshot().reviews,
    loops: () => agentReview.snapshot(),
    continueReview: (id) => aiReview.continue(id),
    stopReview: (id) => aiReview.stopReview(id),
    approveLoop: (id, keep, note) => agentReview.approve(id, keep, note),
    stopLoop: (id) => agentReview.stop(id)
  })
}
