// What a paired device reads of a session's changes (`remote:changes`, `remote:diff`) and of its
// review loop (`remote:review`, `remote:reviewDecide`). Read only, except the review decisions the
// desktop offers while a loop waits for the person: continue, approve or stop.
import type { DiffFileStatus, DiffLine, EscalationReason, FindingStatus, LocalFileNote, LocalRepoNote, LocalReviewScope, ReviewSeverity, ReviewStatus } from '@workhub/core'
import type { ReviewLoopPhase } from './ai-review-api'
import type { RemotePage, RemotePageRequest } from './remote-api'

/** A repository with changes, as a device names it: by `key` (its folder's name, made unique), never its path. */
export interface RemoteChangedRepo {
  key: string
  name: string
  branch: string | null
  base?: string
  note?: LocalRepoNote
  /** How many of its files changed. */
  files: number
}

/**
 * Why a file's diff is not shown on the phone: the desktop's own reasons (`binary`, `tooLarge`, …),
 * or `hidden` for a dotfile or a key-like name, which a device never reads (see remote/files.ts).
 */
export type RemoteFileNote = LocalFileNote | 'hidden'

export interface RemoteChangedFile {
  /** The `key` of its repository. */
  repo: string
  /** Relative to the repository. */
  path: string
  oldPath?: string
  status: DiffFileStatus
  additions: number
  deletions: number
  binary: boolean
  untracked: boolean
  note?: RemoteFileNote
  /** Diff lines past the desktop's per-file limit, not shown anywhere. */
  hiddenLines: number
}

/** `remote:changes`: the scope to compare (`branch` when omitted) and a page of the files. */
export interface RemoteChangesRequest extends RemotePageRequest {
  scope?: LocalReviewScope
}

export type RemoteChangesPage =
  | { ok: true; scope: LocalReviewScope; repos: RemoteChangedRepo[]; files: RemotePage<RemoteChangedFile> }
  | { ok: false; reason: 'unknownSession' | 'failed' }

/** `remote:diff`: one changed file, named by its repository key and path as `remote:changes` listed it. */
export interface RemoteDiffRequest extends RemotePageRequest {
  scope?: LocalReviewScope
  repo: string
  path: string
}

/**
 * A run of lines of one hunk, small enough that a page of them fits one relay frame. `start` is
 * the index of its first line in the hunk (0: the hunk begins here, show its header).
 */
export interface RemoteDiffPiece {
  hunk: number
  header: string
  start: number
  lines: DiffLine[]
  /** Lines whose text was cut to fit; the full line is on the desktop. */
  cutLines?: number
}

export interface RemoteDiffPage {
  file: RemoteChangedFile
  pieces: RemotePage<RemoteDiffPiece>
}

/** A decision the phone may take on a review loop that waits for the person. */
export type RemoteReviewDecision = 'continue' | 'approve' | 'stop'

/** The automatic review of the session's branch ("Review before PR"), as a device sees it. */
export interface RemoteBranchReview {
  status: ReviewStatus
  branch: string
  baseRef: string
  round: number
  escalation?: { reason: EscalationReason; detail: string }
  /** Findings still open, then the rest; text cut. */
  findings: { id: string; severity: ReviewSeverity; title: string; status: FindingStatus }[]
  /** Findings left out to fit one frame. */
  omittedFindings?: number
  decisions: RemoteReviewDecision[]
}

/** A "Review with another agent" loop, as a device sees it. */
export interface RemoteReviewLoop {
  phase: ReviewLoopPhase
  round: number
  maxRounds: number
  reviewerLabel: string
  /** While it waits for the person: the reviewer's findings to pick from (empty: it did not number them). */
  findings?: { id: string; severity?: string; title: string; text: string }[]
  omittedFindings?: number
  /** The reviewer's whole answer, cut. */
  review?: string
  decisions: RemoteReviewDecision[]
}

/** `remote:review`: the session's review and loop, when it has them. */
export interface RemoteReviewState {
  review?: RemoteBranchReview
  loop?: RemoteReviewLoop
}

/**
 * `remote:reviewDecide`: `continue` or `stop` the paused branch review, `approve` (with the findings
 * to keep and a note) or `stop` the loop waiting for a pick. `target` says which one; false when it
 * no longer waits.
 */
export interface RemoteReviewDecisionRequest {
  target: 'review' | 'loop'
  decision: RemoteReviewDecision
  keep?: string[]
  note?: string
}
