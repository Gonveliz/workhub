import { describe, expect, it } from 'vitest'
import { CodeHostError, type CodeHost, type PullRequestDetail, type WorkhubConfig } from '@workhub/core'
import type { GitRunner } from '@workhub/adapters/git-review'
import type { SessionView } from '../src/shared/api'
import { CodeHostService } from '../src/main/codehost'
import { PullRequestCreateService } from '../src/main/pull-request-create'
import { failureKey, hasOpenPullRequestFor, sessionsOnMergedBranch } from '../src/renderer/lib/pullRequestFlow'

const session = { id: 's1', profileId: 'work', cwd: '/work/api', worktree: { repoRoot: '/work/api', path: '/work/wt/api-feat', branch: 'feat/widgets' } } as unknown as SessionView

/** A repository as git answers it: refs that exist, counts per range, and the log. */
function gitOf(repo: { branch?: string; remotes?: string; url?: string; head?: string; refs: string[]; counts?: Record<string, number>; log?: string }): GitRunner & { calls: string[][] } {
  const calls: string[][] = []
  const run = (async (cwd: string, args: string[]) => {
    calls.push([cwd, ...args])
    const ok = (stdout: string) => ({ ok: true, stdout, stderr: '' })
    const no = { ok: false, stdout: '', stderr: '' }
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return ok('/work/wt/api-feat\n')
    if (args[0] === 'symbolic-ref' && args.at(-1) === 'HEAD') return repo.branch ? ok(repo.branch) : no
    if (args[0] === 'symbolic-ref') return repo.head ? ok(repo.head) : no
    if (args[0] === 'remote' && args.length === 1) return ok(repo.remotes ?? 'origin\n')
    if (args[0] === 'remote') return ok(repo.url ?? 'git@github.com:acme/api.git')
    if (args[0] === 'rev-parse') return repo.refs.includes(args.at(-1)!.replace('^{commit}', '')) ? ok('abc') : no
    if (args[0] === 'rev-list') return ok(String(repo.counts?.[args.at(-1)!] ?? 0))
    if (args[0] === 'log') return ok(repo.log ?? '')
    return no
  }) as GitRunner & { calls: string[][] }
  run.calls = calls
  return run
}

function service(git: GitRunner, opts: { connected?: boolean; brief?: string | null } = {}) {
  const created: unknown[] = []
  const svc = new PullRequestCreateService({
    sessions: () => [session],
    codeHost: {
      connected: async () => opts.connected ?? true,
      create: async (_p, input) => {
        created.push(input)
        return { ok: true, url: 'https://github.com/acme/api/pull/5' }
      }
    },
    brief: () => opts.brief ?? null,
    git
  })
  return { svc, created }
}

const PUSHED = {
  branch: 'feat/widgets',
  head: 'origin/main',
  refs: ['refs/remotes/origin/main', 'refs/remotes/origin/feat/widgets'],
  counts: { 'refs/remotes/origin/main..HEAD': 2, 'refs/remotes/origin/feat/widgets..HEAD': 0 },
  log: 'Second change\nAdd widgets\n'
}

describe('PullRequestCreateService.draft', () => {
  it('prefills from the oldest commit, the brief and the remote default branch', async () => {
    const { svc } = service(gitOf(PUSHED), { brief: 'What changed and why' })
    expect(await svc.draft('s1')).toEqual({ state: 'ready', repository: { owner: 'acme', repo: 'api' }, branch: 'feat/widgets', base: 'main', title: 'Add widgets', body: 'What changed and why' })
  })

  it('says how to push a branch the remote does not have, and never pushes', async () => {
    const git = gitOf({ ...PUSHED, refs: ['refs/remotes/origin/main'] })
    const { svc } = service(git)
    expect(await svc.draft('s1')).toMatchObject({ state: 'notPushed', onRemote: false, unpushed: 2, command: 'git push -u origin feat/widgets' })
    expect(git.calls.some((c) => c.includes('push') || c.includes('fetch'))).toBe(false)
  })

  it('counts the commits the remote branch lacks', async () => {
    const { svc } = service(gitOf({ ...PUSHED, counts: { ...PUSHED.counts, 'refs/remotes/origin/feat/widgets..HEAD': 3 } }))
    expect(await svc.draft('s1')).toMatchObject({ state: 'notPushed', onRemote: true, unpushed: 3, command: 'git push origin feat/widgets' })
  })

  it('offers nothing without a code host, on the base, detached, without commits or with an odd branch name', async () => {
    expect(await service(gitOf(PUSHED), { connected: false }).svc.draft('s1')).toEqual({ state: 'unavailable', reason: 'notConnected' })
    expect(await service(gitOf({ ...PUSHED, branch: 'main' })).svc.draft('s1')).toEqual({ state: 'unavailable', reason: 'onBase' })
    expect(await service(gitOf({ ...PUSHED, branch: undefined })).svc.draft('s1')).toEqual({ state: 'unavailable', reason: 'detached' })
    expect(await service(gitOf({ ...PUSHED, counts: {} })).svc.draft('s1')).toEqual({ state: 'unavailable', reason: 'noCommits' })
    expect(await service(gitOf({ ...PUSHED, branch: '-bad' })).svc.draft('s1')).toEqual({ state: 'unavailable', reason: 'badBranch' })
    expect(await service(gitOf({ ...PUSHED, url: '/local/path' })).svc.draft('s1')).toEqual({ state: 'unavailable', reason: 'noRemote' })
    expect(await service(gitOf(PUSHED)).svc.draft('nope')).toEqual({ state: 'unavailable', reason: 'notRepo' })
  })

  it('falls back to a known base when the remote names no default branch', async () => {
    const { svc } = service(gitOf({ ...PUSHED, head: undefined, refs: ['refs/remotes/origin/master', 'refs/remotes/origin/feat/widgets'], counts: { 'refs/remotes/origin/master..HEAD': 1 } }))
    expect(await svc.draft('s1')).toMatchObject({ state: 'ready', base: 'master' })
  })
})

describe('PullRequestCreateService.create', () => {
  it('reads the repository and branch again and sends the confirmed form', async () => {
    const { svc, created } = service(gitOf(PUSHED))
    expect(await svc.create('s1', { title: 'T', body: 'B', base: 'develop', draft: true })).toEqual({ ok: true, url: 'https://github.com/acme/api/pull/5' })
    expect(created).toEqual([{ repository: { owner: 'acme', repo: 'api' }, branch: 'feat/widgets', base: 'develop', title: 'T', body: 'B', draft: true }])
  })

  it('refuses an unpushed branch without asking the host', async () => {
    const { svc, created } = service(gitOf({ ...PUSHED, refs: ['refs/remotes/origin/main'] }))
    expect(await svc.create('s1', { title: 'T', body: '', base: 'main', draft: false })).toMatchObject({ ok: false })
    expect(created).toEqual([])
  })
})

const config = {
  activeProfileId: 'work',
  options: { protectedBranches: ['trunk'] },
  profiles: [{ id: 'work', name: 'Work', connections: { codeHost: 'gh' } }],
  connections: [{ id: 'gh', provider: 'github', settings: {} }]
} as unknown as WorkhubConfig

function mergeSetup(detail: Partial<PullRequestDetail>, merge: CodeHost['merge']) {
  const url = 'https://github.com/acme/api/pull/7'
  const ref = { provider: 'github', owner: 'acme', repo: 'api', number: 7, url }
  const state = { merged: false }
  const calls: unknown[] = []
  const host = {
    provider: 'github',
    parseUrl: () => ref,
    detail: async () => ({ ...ref, state: state.merged ? 'merged' : 'open', isDraft: false, mergeable: 'mergeable', branch: 'feat/x', ...detail }),
    mergeMethods: async () => ['squash'],
    merge: async (r: typeof ref, o: Parameters<CodeHost['merge']>[1]) => {
      calls.push(o)
      await merge(r, o)
      state.merged = true
    }
  } as unknown as CodeHost
  const svc = new CodeHostService(async () => config, { demo: false })
  ;(svc as unknown as { hostFor: () => unknown }).hostFor = () => ({ host, cli: 'gh' })
  return { svc, url, calls }
}

describe('CodeHostService.merge', () => {
  it('merges with an allowed method and keeps a protected branch', async () => {
    const { svc, url, calls } = mergeSetup({ branch: 'trunk' }, async () => undefined)
    expect(await svc.merge('work', url, 'squash', true)).toEqual({ ok: true, branchDeleted: false })
    expect(calls).toEqual([{ method: 'squash', deleteBranch: false, branch: 'trunk' }])
  })

  it('refuses a method the repository does not allow and a PR the host does not call mergeable', async () => {
    const a = mergeSetup({}, async () => undefined)
    expect(await a.svc.merge('work', a.url, 'rebase', false)).toMatchObject({ ok: false })
    const b = mergeSetup({ mergeable: 'conflicting' }, async () => undefined)
    expect(await b.svc.merge('work', b.url, 'squash', false)).toMatchObject({ ok: false, kind: 'notMergeable' })
    expect([...a.calls, ...b.calls]).toEqual([])
  })

  it('passes the host reason on, and reports a merged PR whose branch could not be deleted as merged', async () => {
    const failing = mergeSetup({}, async () => Promise.reject(new CodeHostError('Required status check "build" is failing', 'checksFailing')))
    expect(await failing.svc.merge('work', failing.url, 'squash', false)).toEqual({ ok: false, error: 'Required status check "build" is failing', kind: 'checksFailing' })
    const late = mergeSetup({}, async () => undefined)
    const host = (late.svc as unknown as { hostFor: () => { host: CodeHost } }).hostFor().host
    const merge = host.merge.bind(host)
    host.merge = async (r, o) => {
      await merge(r, o)
      throw new CodeHostError('Merged, but the branch could not be deleted: 403')
    }
    expect(await late.svc.merge('work', late.url, 'squash', true)).toEqual({ ok: true, branchDeleted: false, warning: 'Merged, but the branch could not be deleted: 403' })
  })
})

describe('pull request flow helpers', () => {
  it('hides "Create" when the branch already has an open PR in that repository', () => {
    const target = { repository: { owner: 'Acme', repo: 'API' }, branch: 'feat/x' }
    expect(hasOpenPullRequestFor([{ owner: 'acme', repo: 'api', branch: 'feat/x', state: 'open' }], target)).toBe(true)
    expect(hasOpenPullRequestFor([{ owner: 'acme', repo: 'api', branch: 'feat/x', state: 'merged' }], target)).toBe(false)
    expect(hasOpenPullRequestFor([{ owner: 'acme', repo: 'web', branch: 'feat/x', state: 'open' }], target)).toBe(false)
  })

  it('offers only sessions in a worktree on the merged branch', () => {
    const plain = { ...session, id: 's2', worktree: undefined } as SessionView
    const other = { ...session, id: 's3', worktree: { ...session.worktree!, branch: 'feat/y' } } as SessionView
    expect(sessionsOnMergedBranch([session, plain, other], 'feat/widgets').map((s) => s.id)).toEqual(['s1'])
  })

  it('words only the reasons the host gave', () => {
    expect(failureKey('checksFailing')).toBe('pr.failure.checksFailing')
    expect(failureKey('failed')).toBeUndefined()
    expect(failureKey(undefined)).toBeUndefined()
  })
})
