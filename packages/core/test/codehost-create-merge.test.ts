import { describe, expect, it } from 'vitest'
import {
  classifyCodeHostFailure,
  CodeHostError,
  createPullRequest,
  createRefusal,
  isSafeRefName,
  isSafeRepositoryPath,
  mergePullRequest,
  mergeRefusal,
  pullRequestDraft,
  type CodeHost,
  type NewPullRequest,
  type PullRequest
} from '../src'

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  provider: 'github', owner: 'acme', repo: 'api', number: 1, url: 'https://github.com/acme/api/pull/1', title: 'Add widgets', author: 'ana',
  branch: 'feat/widgets', base: 'main', state: 'open', isDraft: false, reviewDecision: 'none', ci: 'success', mergeable: 'mergeable',
  additions: 1, deletions: 0, changedFiles: 1, ...over
})

/** Only the writes these tests reach; anything else is not called. */
function fakeHost(): CodeHost & { calls: string[] } {
  const calls: string[] = []
  const host: Partial<CodeHost> = {
    createPullRequest: async (i) => {
      calls.push(`create:${i.branch}->${i.base}:${i.title}:${i.draft}`)
      return { provider: 'github', owner: i.repository.owner, repo: i.repository.repo, number: 9, url: `https://github.com/${i.repository.owner}/${i.repository.repo}/pull/9` }
    },
    merge: async (_r, o) => void calls.push(`merge:${o.method}:${o.deleteBranch}:${o.branch}`)
  }
  return Object.assign(host as CodeHost, { calls })
}

const input = (over: Partial<NewPullRequest> = {}): NewPullRequest => ({
  repository: { owner: 'acme', repo: 'api' },
  branch: 'feat/widgets',
  base: 'main',
  title: ' Add widgets ',
  body: ' Brief \n',
  draft: false,
  ...over
})

describe('creating a pull request', () => {
  it('validates refs and the repository before the host is asked', async () => {
    expect(createRefusal(input())).toBeNull()
    expect(createRefusal(input({ branch: '--upload-pack=x' }))).toBe('badBranch')
    expect(createRefusal(input({ base: 'main..evil' }))).toBe('badBase')
    expect(createRefusal(input({ base: 'feat/widgets' }))).toBe('sameBranch')
    expect(createRefusal(input({ title: '  ' }))).toBe('titleRequired')
    expect(createRefusal(input({ repository: { owner: '-R', repo: 'api' } }))).toBe('badRepository')
    const host = fakeHost()
    await expect(createPullRequest(host, input({ branch: 'a b' }))).rejects.toBeInstanceOf(CodeHostError)
    const ref = await createPullRequest(host, input({ draft: true }))
    expect(ref.number).toBe(9)
    expect(host.calls).toEqual(['create:feat/widgets->main:Add widgets:true'])
  })

  it('accepts ordinary branch names and refuses option-like or odd ones', () => {
    for (const ok of ['main', 'feat/PAY-123-widgets', 'release/2.1', 'user_x/fix.thing']) expect(isSafeRefName(ok)).toBe(true)
    for (const bad of ['', '-x', 'a..b', 'a//b', 'a/.b', 'a/-b', 'a.lock', 'a/', '.a', 'a;b', 'a b', 'a$(x)']) expect(isSafeRefName(bad)).toBe(false)
    expect(isSafeRepositoryPath('acme/team/shop')).toBe(true)
    expect(isSafeRepositoryPath('acme')).toBe(false)
    expect(isSafeRepositoryPath('acme/.git')).toBe(false)
  })

  it('prefills the title from the first commit and the body from the brief', () => {
    expect(pullRequestDraft({ branch: 'feat/x', subjects: ['', 'Add the thing', 'Fix'], brief: ' What changed \n' })).toEqual({ title: 'Add the thing', body: 'What changed' })
    expect(pullRequestDraft({ branch: 'feat/x', subjects: [] })).toEqual({ title: 'feat/x', body: '' })
  })
})

describe('merging a pull request', () => {
  it('needs an open, ready, mergeable PR and an allowed method', () => {
    expect(mergeRefusal(pr())).toBeNull()
    expect(mergeRefusal(pr({ state: 'merged' }))).toBe('notOpen')
    expect(mergeRefusal(pr({ isDraft: true }))).toBe('draft')
    expect(mergeRefusal(pr({ mergeable: 'unknown' }))).toBe('notMergeable')
    expect(mergeRefusal(pr({ mergeable: 'conflicting' }))).toBe('notMergeable')
    expect(mergeRefusal(pr(), 'rebase', ['merge', 'squash'])).toBe('methodNotAllowed')
  })

  it('never deletes a protected branch and refuses before calling the host', async () => {
    const host = fakeHost()
    const ref = { provider: 'github', owner: 'acme', repo: 'api', number: 1, url: 'https://github.com/acme/api/pull/1' }
    expect(await mergePullRequest(host, ref, pr(), { method: 'squash', deleteBranch: true, allowed: ['merge', 'squash'] })).toEqual({ branchDeleted: true })
    expect(await mergePullRequest(host, ref, pr({ branch: 'develop' }), { method: 'merge', deleteBranch: true, allowed: ['merge'] })).toEqual({ branchDeleted: false })
    expect(await mergePullRequest(host, ref, pr({ branch: 'hotfix' }), { method: 'merge', deleteBranch: true, allowed: ['merge'], protectedBranches: ['hotfix'] })).toEqual({ branchDeleted: false })
    await expect(mergePullRequest(host, ref, pr({ mergeable: 'conflicting' }), { method: 'merge', deleteBranch: false, allowed: ['merge'] })).rejects.toMatchObject({ kind: 'notMergeable' })
    await expect(mergePullRequest(host, ref, pr(), { method: 'rebase', deleteBranch: false, allowed: ['merge'] })).rejects.toBeInstanceOf(CodeHostError)
    expect(host.calls).toEqual(['merge:squash:true:feat/widgets', 'merge:merge:false:develop', 'merge:merge:false:hotfix'])
  })
})

describe('classifyCodeHostFailure', () => {
  it('reads the reason out of gh and glab texts', () => {
    expect(classifyCodeHostFailure('X Pull request acme/api#1 is not mergeable: the merge commit cannot be cleanly created.')).toBe('notMergeable')
    expect(classifyCodeHostFailure('X Pull request acme/api#1 is not mergeable: the base branch policy prohibits the merge.')).toBe('notMergeable')
    expect(classifyCodeHostFailure('GraphQL: Required status check "build" is failing (mergePullRequest)')).toBe('checksFailing')
    expect(classifyCodeHostFailure('405 Method Not Allowed')).toBe('notMergeable')
    expect(classifyCodeHostFailure('GraphQL: Resource not accessible by integration (createPullRequest)')).toBe('forbidden')
    expect(classifyCodeHostFailure('403 Forbidden')).toBe('forbidden')
    expect(classifyCodeHostFailure('a pull request for branch "feat/x" into branch "main" already exists:\nhttps://github.com/acme/api/pull/3')).toBe('exists')
    expect(classifyCodeHostFailure('409 {message: [Another open merge request already exists for this source branch: !5]}')).toBe('exists')
    expect(classifyCodeHostFailure('dial tcp: i/o timeout')).toBeNull()
  })
})
