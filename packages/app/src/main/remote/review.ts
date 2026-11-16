// A session's review loop as a paired device sees it (`remote:review`), and the decisions the desktop
// offers while the loop waits for the person (`remote:reviewDecide`): continue or stop a paused
// "Review before PR", approve the findings of a "Review with another agent" loop or stop it. Nothing
// here edits files or runs a command on its own; the decisions are the desktop panel's buttons.
import { cycleRound, sessionIdentity } from '@workhub/core'
import type { SessionView } from '../../shared/api'
import type { AiReviewView, ReviewLoopView } from '../../shared/ai-review-api'
import type { RemoteBranchReview, RemoteReviewDecision, RemoteReviewLoop, RemoteReviewState } from '../../shared/remote-changes-api'
import type { IpcRegistrar } from '../ipc-guard'
import { validFindingPick } from '../agent-review'
import { RemoteRefused } from './dispatcher'
import { sizeOf } from './paging'

/** Bytes of JSON the findings of one answer stop before; the rest are counted. */
export const REVIEW_FINDINGS_BYTES = 160 * 1024
const TITLE_MAX = 300
const TEXT_MAX = 4_000
const REVIEW_TEXT_MAX = 24_000
const DETAIL_MAX = 1_000

export interface RemoteReviewDeps {
  sessions(): SessionView[]
  /** The automatic reviews (AiReviewService.snapshot().reviews). */
  reviews(): AiReviewView[]
  /** The "Review with another agent" loops (AgentReviewService.snapshot()). */
  loops(): ReviewLoopView[]
  continueReview(reviewId: string): Promise<void>
  stopReview(reviewId: string): Promise<void>
  approveLoop(loopId: string, keep: string[], note?: string): boolean
  stopLoop(loopId: string): Promise<void>
}

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** The session's branch review as its desktop panel picks it: the one reviewing, else the latest. */
function reviewOf(deps: RemoteReviewDeps, view: SessionView): AiReviewView | undefined {
  const identity = sessionIdentity(view)
  const mine = deps.reviews().filter((r) => r.devIdentity === identity)
  return mine.find((r) => r.status === 'reviewing') ?? [...mine].sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

/** The session's newest loop, as author or reviewer. */
function loopOf(deps: RemoteReviewDeps, sessionId: string): ReviewLoopView | undefined {
  return deps
    .loops()
    .filter((l) => l.authorSessionId === sessionId || l.reviewerSessionId === sessionId)
    .sort((a, b) => b.startedAt - a.startedAt)[0]
}

/** What the desktop panel offers at this point: Continue and Stop while the review is paused for the person. */
export function reviewDecisions(review: Pick<AiReviewView, 'status'>): RemoteReviewDecision[] {
  return review.status === 'paused' ? ['continue', 'stop'] : []
}

/** The finding picker (send the picked findings) and Stop, while the loop waits for the person. */
export function loopDecisions(loop: Pick<ReviewLoopView, 'phase'>): RemoteReviewDecision[] {
  return loop.phase === 'awaitingApproval' ? ['approve', 'stop'] : []
}

/** Items of `list` until `budget` bytes, and how many were left out. */
function within<T>(list: readonly T[], budget: number): { kept: T[]; omitted: number } {
  const kept: T[] = []
  let bytes = 0
  for (const item of list) {
    bytes += sizeOf(item)
    if (bytes > budget) break
    kept.push(item)
  }
  return { kept, omitted: list.length - kept.length }
}

export function remoteBranchReview(review: AiReviewView): RemoteBranchReview {
  const open = (s: string) => (s === 'open' ? 0 : 1)
  const findings = [...review.findings]
    .sort((a, b) => open(a.status) - open(b.status))
    .map((f) => ({ id: f.id, severity: f.severity, title: cut(String(f.title ?? ''), TITLE_MAX), status: f.status }))
  const { kept, omitted } = within(findings, REVIEW_FINDINGS_BYTES)
  const last = review.rounds.at(-1)
  return {
    status: review.status,
    branch: cut(review.branch, TITLE_MAX),
    baseRef: cut(review.baseRef, TITLE_MAX),
    round: last ? cycleRound(review, last.n) : 0,
    ...(review.status === 'paused' && review.escalation ? { escalation: { reason: review.escalation.reason, detail: cut(review.escalation.detail ?? '', DETAIL_MAX) } } : {}),
    findings: kept,
    ...(omitted ? { omittedFindings: omitted } : {}),
    decisions: reviewDecisions(review)
  }
}

export function remoteReviewLoop(loop: ReviewLoopView): RemoteReviewLoop {
  const waiting = loop.phase === 'awaitingApproval'
  const findings = waiting ? (loop.findings ?? []).map((f) => ({ id: f.id, ...(f.severity ? { severity: f.severity } : {}), title: cut(f.title, TITLE_MAX), text: cut(f.text, TEXT_MAX) })) : []
  const { kept, omitted } = within(findings, REVIEW_FINDINGS_BYTES)
  return {
    phase: loop.phase,
    round: loop.round,
    maxRounds: loop.maxRounds,
    reviewerLabel: cut(loop.reviewerLabel, TITLE_MAX),
    ...(waiting ? { findings: kept } : {}),
    ...(omitted ? { omittedFindings: omitted } : {}),
    ...(waiting && loop.review ? { review: cut(loop.review, REVIEW_TEXT_MAX) } : {}),
    decisions: loopDecisions(loop)
  }
}

function openSession(deps: RemoteReviewDeps, sessionId: unknown): SessionView {
  if (typeof sessionId !== 'string') throw new RemoteRefused('a session is required')
  const view = deps.sessions().find((v) => v.id === sessionId)
  if (!view) throw new RemoteRefused('the session is not open')
  return view
}

/** `remote:review`: the open session's review and loop, each when it has one. */
export function readRemoteReview(deps: RemoteReviewDeps, sessionId: unknown): RemoteReviewState {
  const view = openSession(deps, sessionId)
  const review = reviewOf(deps, view)
  const loop = loopOf(deps, view.id)
  return { ...(review ? { review: remoteBranchReview(review) } : {}), ...(loop ? { loop: remoteReviewLoop(loop) } : {}) }
}

/**
 * `remote:reviewDecide`: one decision on the session's own review or loop, only one the desktop
 * offers right now (see reviewDecisions, loopDecisions); false when it no longer waits. The device
 * names the session, never a review or loop id, so it reaches no other session's loop.
 */
export async function decideRemoteReview(deps: RemoteReviewDeps, sessionId: unknown, raw: unknown): Promise<boolean> {
  const view = openSession(deps, sessionId)
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const decision = o['decision']
  if (decision !== 'continue' && decision !== 'approve' && decision !== 'stop') throw new RemoteRefused('the decision is not valid')
  if (o['target'] === 'review') {
    const review = reviewOf(deps, view)
    if (!review || !reviewDecisions(review).includes(decision)) return false
    if (decision === 'continue') await deps.continueReview(review.id)
    else await deps.stopReview(review.id)
    return true
  }
  if (o['target'] === 'loop') {
    const loop = loopOf(deps, view.id)
    if (!loop || !loopDecisions(loop).includes(decision)) return false
    if (decision === 'stop') {
      await deps.stopLoop(loop.id)
      return true
    }
    const pick = validFindingPick(o['keep'], o['note'])
    if (!pick) throw new RemoteRefused('the findings are not valid')
    // Only findings the loop offers (or the whole review when it numbered none).
    const offered = new Set((loop.findings ?? []).length ? (loop.findings ?? []).map((f) => f.id) : ['all'])
    const keep = pick.keep.filter((id) => offered.has(id))
    if (!keep.length && !pick.note) throw new RemoteRefused('pick a finding or write a note')
    return deps.approveLoop(loop.id, keep, pick.note)
  }
  throw new RemoteRefused('the review is not valid')
}

/** Registers `remote:review` and `remote:reviewDecide` (reached only through the remote allowlist). */
export function registerRemoteReviewIpc(ipc: IpcRegistrar, deps: RemoteReviewDeps): void {
  ipc.handle('remote:review', (_e, sessionId: unknown) => readRemoteReview(deps, sessionId))
  ipc.handle('remote:reviewDecide', (_e, sessionId: unknown, request: unknown) => decideRemoteReview(deps, sessionId, request))
}
