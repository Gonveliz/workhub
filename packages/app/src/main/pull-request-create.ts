import { runGit, type GitRunner } from '@workhub/adapters/git-review'
import { isSafeRefName, pullRequestDraft, repoSlugOfRemote, type RepositoryRef } from '@workhub/core'
import type { SessionView } from '../shared/api'
import type { CreatePullRequestResult, PullRequestDraftResult, PullRequestForm } from '../shared/codehost-api'
import type { IpcRegistrar } from './ipc-guard'
import type { CodeHostService } from './codehost'

/** Base branches tried, in order, when the remote names no default branch (`<remote>/HEAD`). */
const FALLBACK_BASES = ['main', 'master', 'develop']

/** How many commit subjects are read for the title: only the first counts, the rest bound the output. */
const SUBJECTS = 500

export interface PullRequestCreateDeps {
  sessions: () => SessionView[]
  codeHost: Pick<CodeHostService, 'connected' | 'create'>
  /** The review brief the session's agent wrote for "Review with another agent", when it wrote one. */
  brief: (sessionId: string) => string | null
  git?: GitRunner
}

/**
 * "Create pull request" for a session's branch: reads the branch, its remote and the remote's
 * default branch from the session's repository (read-only git calls, no fetch, no push), and opens
 * the pull request on the profile's code host once the user confirmed the form. A branch the
 * remote does not have, or has behind, is reported with the push command for the user to run.
 */
export class PullRequestCreateService {
  private readonly git: GitRunner

  constructor(private readonly deps: PullRequestCreateDeps) {
    this.git = deps.git ?? runGit
  }

  private async out(cwd: string, args: string[]): Promise<string | null> {
    const r = await this.git(cwd, args)
    return r.ok ? r.stdout.trim() : null
  }

  private async exists(root: string, ref: string): Promise<boolean> {
    return (await this.out(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])) !== null
  }

  async draft(sessionId: string): Promise<PullRequestDraftResult> {
    const view = this.deps.sessions().find((v) => v.id === sessionId)
    if (!view) return { state: 'unavailable', reason: 'notRepo' }
    if (!(await this.deps.codeHost.connected(view.profileId ?? null))) return { state: 'unavailable', reason: 'notConnected' }
    const root = await this.out(view.worktree?.path ?? view.cwd, ['rev-parse', '--show-toplevel'])
    if (!root) return { state: 'unavailable', reason: 'notRepo' }
    const branch = await this.out(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    if (!branch) return { state: 'unavailable', reason: 'detached' }
    if (!isSafeRefName(branch)) return { state: 'unavailable', reason: 'badBranch' }

    const remotes = ((await this.out(root, ['remote'])) ?? '').split('\n').map((r) => r.trim()).filter(Boolean)
    const remote = remotes.includes('origin') ? 'origin' : remotes[0]
    // The remote's name goes into the command the user copies: plain names only.
    if (!remote || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(remote)) return { state: 'unavailable', reason: 'noRemote' }
    const slug = repoSlugOfRemote((await this.out(root, ['remote', 'get-url', '--end-of-options', remote])) ?? '')
    if (!slug) return { state: 'unavailable', reason: 'noRemote' }
    const cut = slug.lastIndexOf('/')
    const repository: RepositoryRef = { owner: slug.slice(0, cut), repo: slug.slice(cut + 1) }

    const head = await this.out(root, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`])
    let base = head?.startsWith(`${remote}/`) ? head.slice(remote.length + 1) : null
    if (!base) for (const name of FALLBACK_BASES) if (!base && (await this.exists(root, `refs/remotes/${remote}/${name}`))) base = name
    base ??= 'main'
    if (branch === base) return { state: 'unavailable', reason: 'onBase' }

    const baseRef = `refs/remotes/${remote}/${base}`
    const hasBase = await this.exists(root, baseRef)
    const count = async (range: string) => Number.parseInt((await this.out(root, ['rev-list', '--count', '--end-of-options', range])) ?? '0', 10) || 0
    const ahead = hasBase ? await count(`${baseRef}..HEAD`) : 1
    if (ahead === 0) return { state: 'unavailable', reason: 'noCommits' }

    const remoteBranch = `refs/remotes/${remote}/${branch}`
    if (!(await this.exists(root, remoteBranch))) {
      return { state: 'notPushed', repository, branch, unpushed: hasBase ? ahead : 0, onRemote: false, command: `git push -u ${remote} ${branch}` }
    }
    const unpushed = await count(`${remoteBranch}..HEAD`)
    if (unpushed > 0) return { state: 'notPushed', repository, branch, unpushed, onRemote: true, command: `git push ${remote} ${branch}` }

    const log = hasBase ? await this.out(root, ['log', '--no-color', `--max-count=${SUBJECTS}`, '--format=%s', '--end-of-options', `${baseRef}..HEAD`]) : null
    // `log` lists newest first; the oldest of the branch is the last line.
    const subjects = (log ?? '').split('\n').filter((s) => s.trim()).reverse()
    return { state: 'ready', repository, branch, base, ...pullRequestDraft({ branch, subjects, brief: this.deps.brief(sessionId) }) }
  }

  /** Opens the PR with the form's title, body, base and draft; repository and branch are read again, never taken from the renderer. */
  async create(sessionId: string, form: PullRequestForm): Promise<CreatePullRequestResult> {
    const draft = await this.draft(sessionId)
    if (draft.state === 'notPushed') return { ok: false, error: `The branch is not pushed: ${draft.command}` }
    if (draft.state !== 'ready') return { ok: false, error: `No pull request can be created here (${draft.reason})` }
    const view = this.deps.sessions().find((v) => v.id === sessionId)
    return this.deps.codeHost.create(view?.profileId ?? null, {
      repository: draft.repository,
      branch: draft.branch,
      base: typeof form.base === 'string' && form.base.trim() ? form.base.trim() : draft.base,
      title: typeof form.title === 'string' ? form.title : '',
      body: typeof form.body === 'string' ? form.body : '',
      draft: form.draft === true
    })
  }
}

export function registerPullRequestCreateIpc(ipc: IpcRegistrar, service: PullRequestCreateService): void {
  ipc.handle('codeHost:draftPullRequest', (_e, sessionId: unknown) => (typeof sessionId === 'string' ? service.draft(sessionId) : { state: 'unavailable', reason: 'notRepo' }))
  ipc.handle('codeHost:createPullRequest', (_e, sessionId: unknown, form: unknown) =>
    typeof sessionId === 'string' && form && typeof form === 'object' ? service.create(sessionId, form as PullRequestForm) : { ok: false, error: 'Bad request' }
  )
}
