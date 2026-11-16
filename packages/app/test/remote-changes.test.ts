import { describe, expect, it, vi } from 'vitest'
import type { DiffHunk, LocalReview, LocalReviewFile, LocalReviewScope } from '@workhub/core'
import { fitsFrame } from '@workhub/protocol'
import type { IpcRegistrar } from '../src/main/ipc-guard'
import { recordIpc, RemoteHub, type RemoteDevice } from '../src/main/remote'
import { DIFF_LINE_MAX, RemoteChanges, registerRemoteChangesIpc, repoKeys, type RemoteChangesDeps } from '../src/main/remote/changes'
import { decideRemoteReview, readRemoteReview, registerRemoteReviewIpc, type RemoteReviewDeps } from '../src/main/remote/review'
import type { SessionView } from '../src/shared/api'
import type { AiReviewView, ReviewLoopView } from '../src/shared/ai-review-api'
import type { LocalReviewLoad } from '../src/shared/local-review-api'
import type { RemoteCapability } from '../src/shared/remote-api'
import type { RemoteChangedFile, RemoteChangesPage, RemoteDiffPage, RemoteDiffPiece, RemoteReviewState } from '../src/shared/remote-changes-api'
import { addFiles, addPieces } from '../src/web/changes-pages'

const fits = (value: unknown) => fitsFrame({ t: 'result', id: Number.MAX_SAFE_INTEGER, ok: true, value })

function file(path: string, hunks: DiffHunk[] = [], extra: Partial<LocalReviewFile> = {}): LocalReviewFile {
  const additions = hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === 'added').length, 0)
  return { path, status: 'modified', binary: false, additions, deletions: 0, hunks, hiddenLines: 0, untracked: false, ...extra }
}

/** A hunk of `count` added lines of `width` characters (quotes and control characters, which JSON escapes to several bytes). */
function hugeHunk(count: number, width: number): DiffHunk {
  const text = '"\u0001\\é'.repeat(Math.ceil(width / 4)).slice(0, width)
  return { header: `@@ -0,0 +1,${count} @@`, lines: Array.from({ length: count }, (_, i) => ({ kind: 'added' as const, newNumber: i + 1, text })) }
}

function review(files: LocalReviewFile[], extraRepos: { name: string; files: LocalReviewFile[] }[] = []): LocalReview {
  return {
    folder: '/work/api',
    scope: 'branch',
    scannedRepos: 1 + extraRepos.length,
    repos: [{ root: '/work/api', name: 'api', branch: 'feature/x', base: 'origin/main', files }, ...extraRepos.map((r) => ({ root: `/work/api/${r.name}`, name: r.name, branch: 'main', files: r.files }))]
  }
}

function setupChanges(load: LocalReview | LocalReviewLoad, open = ['s1']) {
  const calls: { id: string; scope: LocalReviewScope }[] = []
  let current = load
  const deps: RemoteChangesDeps = {
    sessions: () => open.map((id) => ({ id }) as SessionView),
    load: vi.fn(async (id: string, scope: LocalReviewScope) => {
      calls.push({ id, scope })
      return 'ok' in current ? current : ({ ok: true, session: { id, label: id, agentName: 'Claude', cwd: '/work/api' }, review: current } as LocalReviewLoad)
    })
  }
  return { changes: new RemoteChanges(deps), calls, set: (next: LocalReview | LocalReviewLoad) => void (current = next) }
}

async function allFiles(changes: RemoteChanges): Promise<{ pages: RemoteChangesPage[]; files: RemoteChangedFile[] }> {
  const pages: RemoteChangesPage[] = []
  let files: RemoteChangedFile[] = []
  let cursor: string | null = null
  do {
    const page: RemoteChangesPage = await changes.changes('s1', { limit: 200, ...(cursor ? { cursor } : {}) })
    if (!page.ok) throw new Error('not ok')
    pages.push(page)
    files = addFiles(files, page.files.items)
    cursor = page.files.nextCursor
  } while (cursor)
  return { pages, files }
}

async function allPieces(changes: RemoteChanges, repo: string, path: string): Promise<{ pages: RemoteDiffPage[]; pieces: RemoteDiffPiece[] }> {
  const pages: RemoteDiffPage[] = []
  let pieces: RemoteDiffPiece[] = []
  let cursor: string | null = null
  do {
    const page: RemoteDiffPage = await changes.diff('s1', { repo, path, limit: 200, ...(cursor ? { cursor } : {}) })
    pages.push(page)
    pieces = addPieces(pieces, page.pieces.items)
    cursor = page.pieces.nextCursor
  } while (cursor)
  return { pages, pieces }
}

describe('remote changes', () => {
  it('pages thousands of changed files, every page under the relay frame', async () => {
    const files = Array.from({ length: 3000 }, (_, i) => file(`src/${'deep/'.repeat(40)}file-${i}.ts`, [], { additions: i, deletions: 1 }))
    const { changes } = setupChanges(review(files))
    const { pages, files: got } = await allFiles(changes)
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) expect(fits(page)).toBe(true)
    expect(got).toHaveLength(3000)
    expect(got[5]).toMatchObject({ repo: 'api', path: files[5]!.path, status: 'modified', additions: 5, deletions: 1 })
    // Never a path on this computer: no repository root, no folder.
    expect(JSON.stringify(pages[0])).not.toContain('/work/api')
  })

  it('pages a huge diff in pieces that each fit the frame, long lines cut', async () => {
    const big = file('src/big.ts', [hugeHunk(2000, 10_000), hugeHunk(3, 10)])
    const { changes } = setupChanges(review([big]))
    const { pages, pieces } = await allPieces(changes, 'api', 'src/big.ts')
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) expect(fits(page)).toBe(true)
    const lines = pieces.flatMap((p) => p.lines)
    expect(lines).toHaveLength(2003)
    expect(lines.every((l) => l.text.length <= DIFF_LINE_MAX)).toBe(true)
    expect(pieces.filter((p) => p.hunk === 0).reduce((n, p) => n + (p.cutLines ?? 0), 0)).toBe(2000)
    // The second hunk starts its own piece with its header.
    expect(pieces.find((p) => p.hunk === 1)).toMatchObject({ start: 0, header: '@@ -0,0 +1,3 @@' })
  })

  it('reads git again on a first page, and answers later pages and diffs from the same read', async () => {
    const { changes, calls } = setupChanges(review(Array.from({ length: 30 }, (_, i) => file(`f${i}.ts`))))
    const first = await changes.changes('s1', { limit: 10 })
    if (!first.ok) throw new Error('not ok')
    await changes.changes('s1', { limit: 10, cursor: first.files.nextCursor })
    await changes.diff('s1', { repo: 'api', path: 'f3.ts' })
    expect(calls).toEqual([{ id: 's1', scope: 'branch' }])
    await changes.changes('s1', { scope: 'uncommitted' })
    expect(calls.at(-1)).toEqual({ id: 's1', scope: 'uncommitted' })
  })

  it('gives a diff only for a file the session’s review lists, never for a path the device names', async () => {
    const { changes, calls } = setupChanges(review([file('src/a.ts', [hugeHunk(2, 5)])], [{ name: 'web', files: [file('index.ts')] }]))
    await expect(changes.diff('s1', { repo: 'api', path: 'src/a.ts' })).resolves.toMatchObject({ file: { path: 'src/a.ts' } })
    await expect(changes.diff('s1', { repo: 'web', path: 'index.ts' })).resolves.toMatchObject({ file: { repo: 'web' } })
    for (const [repo, path] of [
      ['api', '../../etc/passwd'],
      ['api', '/etc/passwd'],
      ['api', 'src/../src/a.ts'],
      ['api', 'index.ts'],
      ['/work/api', 'src/a.ts'],
      ['other', 'src/a.ts']
    ]) {
      await expect(changes.diff('s1', { repo, path })).rejects.toThrow(/not among the session/)
    }
    // A first page not found reads git once more (the list may have moved); it still refuses.
    expect(calls.length).toBeGreaterThan(1)
    await expect(changes.diff('s1', { repo: 'api' })).rejects.toThrow(/required/)
    await expect(changes.diff('gone', { repo: 'api', path: 'src/a.ts' })).rejects.toThrow(/not open/)
    await expect(changes.changes('gone', {})).resolves.toEqual({ ok: false, reason: 'unknownSession' })
  })

  it('lists secret-like and binary files without their content', async () => {
    const secret = file('config/.env', [hugeHunk(3, 20)])
    const key = file('deploy/id_rsa', [hugeHunk(3, 20)], { status: 'added' })
    const binary = file('logo.png', [], { binary: true, note: 'binary' })
    const { changes } = setupChanges(review([secret, key, binary]))
    for (const path of ['config/.env', 'deploy/id_rsa']) {
      const page = await changes.diff('s1', { repo: 'api', path })
      expect(page.file.note).toBe('hidden')
      expect(page.pieces.items).toEqual([])
    }
    const png = await changes.diff('s1', { repo: 'api', path: 'logo.png' })
    expect(png.file.note).toBe('binary')
    expect(png.pieces.items).toEqual([])
  })

  it('names repositories by unique folder names and keeps the desktop’s error text to itself', async () => {
    expect(repoKeys(review([], [{ name: 'api', files: [] }, { name: 'api', files: [] }]))).toEqual(['api', 'api#2', 'api#3'])
    const { changes } = setupChanges({ ok: false, reason: 'failed', detail: 'fatal: /home/someone/private is not a repo' })
    const page = await changes.changes('s1', {})
    expect(page).toEqual({ ok: false, reason: 'failed' })
    await expect(changes.diff('s1', { repo: 'api', path: 'a.ts' })).rejects.toThrow(/could not be read/)
  })

  it('refuses a cursor it did not make', async () => {
    const { changes } = setupChanges(review([file('a.ts')]))
    await expect(changes.changes('s1', { cursor: '!!' })).rejects.toThrow(/cursor/)
  })
})

function aiReview(over: Partial<AiReviewView> = {}): AiReviewView {
  return {
    id: 'dev-1::feature/x',
    devIdentity: 'dev-1',
    profileId: null,
    repoRoot: '/work/api',
    branch: 'feature/x',
    base: 'main',
    baseRef: 'origin/main',
    status: 'paused',
    rounds: [{ n: 1, trigger: 'auto', sha: 'abc', startedAt: 1, reviewerAgentKey: 'codex', uncommitted: false, parsed: true, newFindingIds: ['F1'] }],
    findings: [{ id: 'F1', severity: 'major', title: 'Null check missing', why: '', fix: '', status: 'open', round: 1, reopenCount: 0, sent: true }],
    escalation: { reason: 'maxRounds', detail: 'two blockers open', at: 2 },
    extraRounds: 0,
    userNotes: [],
    awaitingDevReply: false,
    createdAt: 1,
    updatedAt: 2,
    ...over
  }
}

function loop(over: Partial<ReviewLoopView> = {}): ReviewLoopView {
  return {
    id: 'loop-1',
    authorSessionId: 's1',
    reviewerSessionId: 'r1',
    reviewerLabel: 'Codex',
    round: 1,
    maxRounds: 3,
    phase: 'awaitingApproval',
    findings: [
      { id: 'F1', title: 'a.ts:3 off by one', text: 'F1 a.ts:3 off by one' },
      { id: 'F2', title: 'b.ts:9 typo', text: 'F2 b.ts:9 typo' }
    ],
    review: 'F1 … F2 …',
    startedAt: 1,
    updatedAt: 2,
    ...over
  }
}

function setupReview(reviews: AiReviewView[], loops: ReviewLoopView[]) {
  const deps: RemoteReviewDeps = {
    sessions: () => [{ id: 's1', agentSessionId: 'dev-1' } as SessionView, { id: 's2', agentSessionId: 'dev-2' } as SessionView],
    reviews: () => reviews,
    loops: () => loops,
    continueReview: vi.fn(async () => undefined),
    stopReview: vi.fn(async () => undefined),
    approveLoop: vi.fn(() => true),
    stopLoop: vi.fn(async () => undefined)
  }
  return deps
}

describe('remote review loop', () => {
  it('shows the paused review and the waiting loop with the decisions the desktop offers then', () => {
    const deps = setupReview([aiReview()], [loop()])
    const state = readRemoteReview(deps, 's1')
    expect(state.review).toMatchObject({ status: 'paused', round: 1, escalation: { reason: 'maxRounds' }, decisions: ['continue', 'stop'] })
    expect(state.loop).toMatchObject({ phase: 'awaitingApproval', decisions: ['approve', 'stop'] })
    expect(JSON.stringify(state)).not.toContain('/work/api')
    // Nothing waits: no decisions, and the loop's findings are not sent.
    const busy = readRemoteReview(setupReview([aiReview({ status: 'reviewing', escalation: undefined })], [loop({ phase: 'fixing' })]), 's1')
    expect(busy.review?.decisions).toEqual([])
    expect(busy.loop).toMatchObject({ decisions: [] })
    expect(busy.loop?.findings).toBeUndefined()
    expect(readRemoteReview(deps, 's2')).toEqual({})
  })

  it('keeps a review with many long findings under the frame', () => {
    const findings = Array.from({ length: 60 }, (_, i) => ({ id: `F${i + 1}`, title: 'x'.repeat(2_000), text: '"'.repeat(20_000) }))
    const state = readRemoteReview(setupReview([], [loop({ findings, review: 'y'.repeat(200_000) })]), 's1')
    expect(fits(state)).toBe(true)
    expect((state.loop?.findings?.length ?? 0) + (state.loop?.omittedFindings ?? 0)).toBe(60)
  })

  it('takes only a decision offered right now, on the session’s own review or loop', async () => {
    const deps = setupReview([aiReview()], [loop()])
    await expect(decideRemoteReview(deps, 's1', { target: 'review', decision: 'continue' })).resolves.toBe(true)
    expect(deps.continueReview).toHaveBeenCalledWith('dev-1::feature/x')
    await expect(decideRemoteReview(deps, 's1', { target: 'review', decision: 'approve' })).resolves.toBe(false)
    await expect(decideRemoteReview(deps, 's1', { target: 'loop', decision: 'approve', keep: ['F2', 'F9', 'all'], note: ' fix F2 only ' })).resolves.toBe(true)
    expect(deps.approveLoop).toHaveBeenCalledWith('loop-1', ['F2'], 'fix F2 only')
    await expect(decideRemoteReview(deps, 's1', { target: 'loop', decision: 'stop' })).resolves.toBe(true)
    expect(deps.stopLoop).toHaveBeenCalledWith('loop-1')
    // Another session has none waiting; a closed one is refused; no other decision exists.
    await expect(decideRemoteReview(deps, 's2', { target: 'loop', decision: 'stop' })).resolves.toBe(false)
    await expect(decideRemoteReview(deps, 'gone', { target: 'loop', decision: 'stop' })).rejects.toThrow(/not open/)
    await expect(decideRemoteReview(deps, 's1', { target: 'review', decision: 'dismiss' })).rejects.toThrow(/not valid/)
    await expect(decideRemoteReview(deps, 's1', { target: 'loop', decision: 'approve', keep: ['--rm'] })).rejects.toThrow(/not valid/)
    // Not paused any more: Continue and Stop are not offered.
    const moved = setupReview([aiReview({ status: 'awaitingFixes' })], [])
    await expect(decideRemoteReview(moved, 's1', { target: 'review', decision: 'stop' })).resolves.toBe(false)
    expect(moved.stopReview).not.toHaveBeenCalled()
  })
})

describe('remote changes through the hub', () => {
  function hub(caps: RemoteCapability[]) {
    const inner: IpcRegistrar = { handle: () => undefined, on: () => undefined }
    const { ipc, handlers } = recordIpc(inner)
    const { changes } = setupChanges(review([file('src/big.ts', [hugeHunk(2000, 10_000)])]))
    registerRemoteChangesIpc(ipc, changes)
    const deps = setupReview([aiReview()], [loop()])
    registerRemoteReviewIpc(ipc, deps)
    const h = new RemoteHub({ handlers, profileFolders: async () => [], startMode: async () => null })
    const phone: RemoteDevice = { id: 'phone', capabilities: new Set(caps), emit: () => undefined }
    h.attach(phone)
    return { h, deps }
  }

  it('needs the sessions capability for every channel', async () => {
    const { h, deps } = hub(['pullRequests', 'plan', 'health', 'automations'])
    await expect(h.invoke('phone', 'remote:changes', ['s1', {}])).rejects.toThrow(/not available remotely/)
    await expect(h.invoke('phone', 'remote:diff', ['s1', { repo: 'api', path: 'src/big.ts' }])).rejects.toThrow(/not available remotely/)
    await expect(h.invoke('phone', 'remote:review', ['s1'])).rejects.toThrow(/not available remotely/)
    await expect(h.invoke('phone', 'remote:reviewDecide', ['s1', { target: 'loop', decision: 'stop' }])).rejects.toThrow(/not available remotely/)
    expect(deps.stopLoop).not.toHaveBeenCalled()
  })

  it('answers a device with sessions, each answer within one frame', async () => {
    const { h } = hub(['sessions'])
    const list = (await h.invoke('phone', 'remote:changes', ['s1', {}])) as RemoteChangesPage
    expect(list.ok && list.files.items[0]?.path).toBe('src/big.ts')
    const diff = (await h.invoke('phone', 'remote:diff', ['s1', { repo: 'api', path: 'src/big.ts' }])) as RemoteDiffPage
    expect(fits(diff)).toBe(true)
    expect(diff.pieces.nextCursor).not.toBeNull()
    await expect(h.invoke('phone', 'remote:diff', ['s1', { repo: 'api', path: '../secrets.txt' }])).rejects.toThrow(/not among the session/)
    const state = (await h.invoke('phone', 'remote:review', ['s1'])) as RemoteReviewState
    expect(state.loop?.decisions).toEqual(['approve', 'stop'])
  })
})
