import {
  CodeHostError,
  type CodeHostCapabilities,
  type CodeHostFailure,
  type DiffFile,
  type MergeMethod,
  type NewPullRequest,
  type PullRequest,
  type PullRequestDetail,
  type PullRequestRef,
  type PullRequestReview,
  type ReviewAction
} from './domain'
import { ticketKeysOfPullRequest } from './links'
import type { CodeHost, PullRequestQuery } from './port'

/** Days without activity after which a PR of mine counts as stale (Workhub 1). */
export const STALE_DAYS = 30

/**
 * The one word that sums a PR up, in Workhub 1's order: conflicts, failing CI, requested changes,
 * draft, approved, running CI, otherwise waiting for a review.
 */
export type PullRequestStatus =
  | 'merged'
  | 'closed'
  | 'conflicts'
  | 'ciFailed'
  | 'changesRequested'
  | 'draft'
  | 'approved'
  | 'ciRunning'
  | 'waitingReview'

export function classifyPullRequest(pr: Pick<PullRequest, 'state' | 'mergeable' | 'ci' | 'reviewDecision' | 'isDraft'>): PullRequestStatus {
  if (pr.state === 'merged') return 'merged'
  if (pr.state === 'closed') return 'closed'
  if (pr.mergeable === 'conflicting') return 'conflicts'
  if (pr.ci === 'failure') return 'ciFailed'
  if (pr.reviewDecision === 'changesRequested') return 'changesRequested'
  if (pr.isDraft) return 'draft'
  if (pr.reviewDecision === 'approved') return 'approved'
  if (pr.ci === 'pending') return 'ciRunning'
  return 'waitingReview'
}

export function isStale(pr: Pick<PullRequest, 'updatedAt'>, now: number, days = STALE_DAYS): boolean {
  return pr.updatedAt !== undefined && now - pr.updatedAt > days * 86_400_000
}

/** A PR with what the lists need beyond the host's data. */
export interface PullRequestItem {
  pr: PullRequest
  status: PullRequestStatus
  stale: boolean
  ticketKeys: string[]
}

export function toItem(pr: PullRequest, now: number, { markStale }: { markStale: boolean }): PullRequestItem {
  return { pr, status: classifyPullRequest(pr), stale: markStale && isStale(pr, now), ticketKeys: ticketKeysOfPullRequest(pr) }
}

const newestFirst = (a: PullRequestItem, b: PullRequestItem) => (b.pr.updatedAt ?? 0) - (a.pr.updatedAt ?? 0)

/** My open PRs, newest activity first; those idle for `STALE_DAYS` are marked stale. */
export async function loadMyPullRequests(host: CodeHost, query: PullRequestQuery, now = Date.now()): Promise<PullRequestItem[]> {
  return (await host.listAuthored(query)).map((pr) => toItem(pr, now, { markStale: true })).sort(newestFirst)
}

/** PRs waiting for my review, newest activity first. */
export async function loadReviewQueue(host: CodeHost, query: PullRequestQuery, now = Date.now()): Promise<PullRequestItem[]> {
  return (await host.listReviewRequested(query)).map((pr) => toItem(pr, now, { markStale: false })).sort(newestFirst)
}

export interface PullRequestLists {
  mine: PullRequestItem[]
  toReview: PullRequestItem[]
}

export type PullRequestFilter = 'toReview' | 'mine' | 'stale' | 'all'
export const PULL_REQUEST_FILTERS: readonly PullRequestFilter[] = ['toReview', 'mine', 'stale', 'all']

/** The list under a filter. `mine` leaves out stale PRs, which have a filter of their own; `all` has each PR once. */
export function itemsForFilter(lists: PullRequestLists, filter: PullRequestFilter): PullRequestItem[] {
  switch (filter) {
    case 'toReview':
      return lists.toReview
    case 'mine':
      return lists.mine.filter((i) => !i.stale)
    case 'stale':
      return lists.mine.filter((i) => i.stale)
    case 'all': {
      const seen = new Set<string>()
      return [...lists.mine, ...lists.toReview].filter((i) => !seen.has(i.pr.url) && Boolean(seen.add(i.pr.url)))
    }
  }
}

export const prName = (pr: Pick<PullRequestRef, 'repo' | 'number'>, provider = 'github'): string =>
  `${pr.repo}${provider === 'gitlab' ? '!' : '#'}${pr.number}`

/** Case-insensitive search over the fields Workhub 1 searched: title, name, author, ticket keys, branches. */
export function searchPullRequests(items: readonly PullRequestItem[], query: string): PullRequestItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...items]
  return items.filter((i) =>
    [i.pr.title, prName(i.pr, i.pr.provider), i.pr.author, i.ticketKeys.join(' '), i.pr.branch, i.pr.base].some((f) => f.toLowerCase().includes(q))
  )
}

export interface PullRequestView {
  detail: PullRequestDetail
  /** Null while the diff could not be read; `filesError` says why. The conversation still shows. */
  files: DiffFile[] | null
  filesError?: string
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Everything the detail view shows. A failing diff does not hide the rest. */
export async function loadPullRequestView(host: CodeHost, ref: PullRequestRef): Promise<PullRequestView> {
  const [detail, files] = await Promise.allSettled([host.detail(ref), host.diff(ref)])
  if (detail.status === 'rejected') throw detail.reason
  return files.status === 'fulfilled'
    ? { detail: detail.value, files: files.value }
    : { detail: detail.value, files: null, filesError: messageOf(files.reason) }
}

export type ReviewRefusal = 'unsupported' | 'ownPullRequest' | 'bodyRequired'

/**
 * Whether a review can be sent. Approving or sending back one's own PR is refused (Workhub 1), and
 * so is a verdict the host does not support; "request changes" and "comment" need a body.
 */
export function reviewRefusal(
  capabilities: CodeHostCapabilities,
  action: ReviewAction,
  body: string,
  isMine: boolean
): ReviewRefusal | null {
  if (!capabilities.reviewActions.includes(action)) return 'unsupported'
  if (isMine && action !== 'comment') return 'ownPullRequest'
  if (action !== 'approve' && body.trim() === '') return 'bodyRequired'
  return null
}

/** Sends a review after `reviewRefusal` allows it. */
export async function submitReview(host: CodeHost, ref: PullRequestRef, action: ReviewAction, body: string, isMine: boolean): Promise<void> {
  const refusal = reviewRefusal(host.capabilities, action, body, isMine)
  if (refusal) throw new CodeHostError(`review refused: ${refusal}`, 'unsupported')
  await host.submitReview(ref, action, body.trim())
}

/** Posts a conversation comment; an empty one is refused. */
export async function postComment(host: CodeHost, ref: PullRequestRef, body: string): Promise<void> {
  if (body.trim() === '') throw new CodeHostError('comment refused: bodyRequired', 'unsupported')
  await host.comment(ref, body.trim())
}

/** Long-lived branches Workhub never deletes when it closes a PR (Workhub 1's default list). */
export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = ['develop', 'development', 'dev', 'master', 'main', 'staging', 'stage', 'production', 'prod', 'qa', 'test']

/** Whether closing a PR may delete this branch: never a listed long-lived one, nor any `release…` branch. */
export function isLongLivedBranch(branch: string, protectedBranches: readonly string[] = DEFAULT_PROTECTED_BRANCHES): boolean {
  const name = branch.trim().toLowerCase()
  return name === '' || name.startsWith('release') || protectedBranches.some((b) => b.toLowerCase() === name)
}

/** A comma/space/newline separated list typed in Settings as branch names: trimmed, no blanks, no duplicates. */
export function parseBranchList(text: string): string[] {
  const seen = new Set<string>()
  for (const part of text.split(/[\s,;]+/)) {
    const name = part.trim()
    if (name) seen.add(name)
  }
  return [...seen]
}

export type CloseRefusal = 'notMine' | 'notOpen'

/** Why the user cannot close this PR from Workhub: only their own open PRs (Workhub 1 offered it on "mine" only). */
export function closeRefusal(pr: Pick<PullRequest, 'state'>, isMine: boolean): CloseRefusal | null {
  if (!isMine) return 'notMine'
  if (pr.state !== 'open') return 'notOpen'
  return null
}

/** Closes a PR after `closeRefusal` allows it; a protected head branch is kept whatever was asked. */
export async function closePullRequest(host: CodeHost, ref: PullRequestRef, pr: Pick<PullRequest, 'state' | 'branch'>, isMine: boolean, options: { comment: string; deleteBranch: boolean; protectedBranches?: readonly string[] }): Promise<void> {
  const refusal = closeRefusal(pr, isMine)
  if (refusal) throw new CodeHostError(`close refused: ${refusal}`, 'unsupported')
  await host.close(ref, { comment: options.comment.trim(), deleteBranch: options.deleteBranch && !isLongLivedBranch(pr.branch, options.protectedBranches), branch: pr.branch })
}

/**
 * A branch name Workhub hands to a CLI: plain ref characters only, never something read as an
 * option (`-x`), a range (`a..b`) or a path trick. Stricter than git, on purpose.
 */
export function isSafeRefName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !/^[-./]/.test(name) &&
    !/[/.]$/.test(name) &&
    !name.endsWith('.lock') &&
    !/\.\.|\/\/|\/\.|\/-/.test(name)
  )
}

/** `owner/repo` (GitLab: `group/sub/project`) made of plain path segments, none read as an option. */
export function isSafeRepositoryPath(path: string): boolean {
  return path.length <= 400 && path.split('/').length >= 2 && path.split('/').every((s) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(s))
}

const FAILURE_TEXT: readonly [CodeHostFailure, RegExp][] = [
  ['exists', /already exists/i],
  ['checksFailing', /status checks?|required checks?|checks? (?:are |is |have )?fail|pipeline (?:must|has not|did not|failed|is (?:still )?running)/i],
  ['forbidden', /\b403\b|forbidden|permission|not authori[sz]ed to|must have (?:write|admin|push|maintainer)|resource not accessible/i],
  ['notMergeable', /not mergeable|cannot be merged|merge conflict|\b40[56]\b|is (?:still )?a draft|base branch policy|branch protection|review is required|approvals? (?:is |are )?required|not allowed on this repository/i]
]

/** What a failed create or merge was about, read from the host's own text; null when it does not say. */
export function classifyCodeHostFailure(text: string): CodeHostFailure | null {
  return FAILURE_TEXT.find(([, re]) => re.test(text))?.[0] ?? null
}

export type CreateRefusal = 'titleRequired' | 'badBranch' | 'badBase' | 'sameBranch' | 'badRepository'

/** Why a PR cannot be created as asked; checked before the CLI runs. */
export function createRefusal(input: NewPullRequest): CreateRefusal | null {
  if (!isSafeRepositoryPath(`${input.repository.owner}/${input.repository.repo}`)) return 'badRepository'
  if (!isSafeRefName(input.branch)) return 'badBranch'
  if (!isSafeRefName(input.base)) return 'badBase'
  if (input.branch === input.base) return 'sameBranch'
  if (!input.title.trim()) return 'titleRequired'
  return null
}

/** Creates a PR after `createRefusal` allows it, with the title and body trimmed. */
export async function createPullRequest(host: CodeHost, input: NewPullRequest): Promise<PullRequestRef> {
  const refusal = createRefusal(input)
  if (refusal) throw new CodeHostError(`create refused: ${refusal}`, 'unsupported')
  return host.createPullRequest({ ...input, title: input.title.trim().slice(0, 256), body: input.body.trim() })
}

/** The form's first values: the first commit's subject (else the branch) and the review brief, when there is one. */
export function pullRequestDraft(input: { branch: string; subjects: readonly string[]; brief?: string | null }): { title: string; body: string } {
  return { title: input.subjects.find((s) => s.trim())?.trim() ?? input.branch, body: input.brief?.trim() ?? '' }
}

export type MergeRefusal = 'notOpen' | 'draft' | 'notMergeable' | 'methodNotAllowed'

/**
 * Why "Merge" is refused: only an open, non-draft PR the host reports as mergeable, with a method
 * the repository allows. The host still has the last word (checks, reviews, permissions).
 */
export function mergeRefusal(pr: Pick<PullRequest, 'state' | 'isDraft' | 'mergeable'>, method?: MergeMethod, allowed?: readonly MergeMethod[]): MergeRefusal | null {
  if (pr.state !== 'open') return 'notOpen'
  if (pr.isDraft) return 'draft'
  if (pr.mergeable !== 'mergeable') return 'notMergeable'
  if (method && allowed && !allowed.includes(method)) return 'methodNotAllowed'
  return null
}

/** Merges after `mergeRefusal` allows it; a protected head branch is kept whatever was asked. Says whether deletion was asked of the host. */
export async function mergePullRequest(
  host: CodeHost,
  ref: PullRequestRef,
  pr: Pick<PullRequest, 'state' | 'isDraft' | 'mergeable' | 'branch'>,
  options: { method: MergeMethod; deleteBranch: boolean; allowed: readonly MergeMethod[]; protectedBranches?: readonly string[] }
): Promise<{ branchDeleted: boolean }> {
  const refusal = mergeRefusal(pr, options.method, options.allowed)
  if (refusal) throw new CodeHostError(`merge refused: ${refusal}`, refusal === 'notMergeable' ? 'notMergeable' : 'unsupported')
  const deleteBranch = options.deleteBranch && isSafeRefName(pr.branch) && !isLongLivedBranch(pr.branch, options.protectedBranches)
  await host.merge(ref, { method: options.method, deleteBranch, branch: pr.branch })
  return { branchDeleted: deleteBranch }
}

export interface ReviewerState {
  name: string
  state: 'approved' | 'changesRequested' | 'dismissed' | 'requested'
}

/** Each reviewer's latest verdict, then the ones still asked to review. */
export function reviewerStates(detail: Pick<PullRequestDetail, 'reviews' | 'requestedReviewers'>): ReviewerState[] {
  const latest = new Map<string, { state: PullRequestReview['state']; at: number }>()
  for (const r of detail.reviews) {
    if (r.state !== 'approved' && r.state !== 'changesRequested' && r.state !== 'dismissed') continue
    const at = r.submittedAt ?? 0
    const prev = latest.get(r.author)
    if (!prev || at >= prev.at) latest.set(r.author, { state: r.state, at })
  }
  const decided: ReviewerState[] = [...latest.entries()]
    .map(([name, v]) => ({ name, state: v.state as ReviewerState['state'] }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const pending = detail.requestedReviewers.filter((n) => !latest.has(n)).map((name) => ({ name, state: 'requested' as const }))
  return [...decided, ...pending]
}
