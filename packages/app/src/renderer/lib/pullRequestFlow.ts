import type { CodeHostErrorKind, MergeMethod, PullRequest, RepositoryRef } from '@workhub/core'
import type { SessionView } from '@shared/api'
import type { MessageKey } from '../i18n/translate'

/**
 * Whether a branch already has an open pull request among the ones Workhub knows (the lists and the
 * session's own): then "Create pull request" is not offered. Owner and repository compare without
 * case, as hosts treat them.
 */
export function hasOpenPullRequestFor(prs: readonly Pick<PullRequest, 'owner' | 'repo' | 'branch' | 'state'>[], target: { repository: RepositoryRef; branch: string }): boolean {
  const slug = `${target.repository.owner}/${target.repository.repo}`.toLowerCase()
  return prs.some((p) => p.state === 'open' && p.branch === target.branch && `${p.owner}/${p.repo}`.toLowerCase() === slug)
}

/**
 * Open sessions in a worktree Workhub created on a merged PR's head branch: after the merge they
 * are offered to close, with their worktree removed.
 */
export function sessionsOnMergedBranch(sessions: readonly SessionView[], branch: string): SessionView[] {
  return sessions.filter((s) => s.worktree?.branch === branch)
}

export const MERGE_METHOD_LABEL: Record<MergeMethod, MessageKey> = {
  merge: 'pr.merge.method.merge',
  squash: 'pr.merge.method.squash',
  rebase: 'pr.merge.method.rebase'
}

/** The words for a refusal the host explained; undefined leaves the host's own text alone. */
export function failureKey(kind: CodeHostErrorKind | undefined): MessageKey | undefined {
  switch (kind) {
    case 'notMergeable':
    case 'checksFailing':
    case 'forbidden':
    case 'exists':
      return `pr.failure.${kind}`
    default:
      return undefined
  }
}
