import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitWorktrees } from '../src/git-worktree'
import { includePatterns } from '../src/git-worktree/include'

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim()
const write = (root: string, rel: string, text = 'x\n') => {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), text)
}

describe('includePatterns', () => {
  it('keeps patterns, drops comments, blanks and anything that leaves the repository', () => {
    expect(includePatterns('# secrets\n.env\n\n  config/*.local  \n!config/keep.local\n../outside\nsub/../x\n!../y\nC:\\x\n~/z\n')).toEqual(['.env', 'config/*.local', '!config/keep.local'])
  })
})

describe('.worktreeinclude on a real repository', () => {
  let dir: string
  let repo: string
  let n = 0
  const w = new GitWorktrees()

  beforeAll(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'workhub-include-')))
    repo = join(dir, 'acme')
    mkdirSync(repo)
    git(repo, 'init', '--quiet', '-b', 'main')
    // Worktrees share this config. A Windows runner defaults to autocrlf=true, which would turn the
    // LF text these tests compare into CRLF on checkout.
    git(repo, 'config', 'core.autocrlf', 'false')
    write(repo, '.gitignore', '.env\n*.local\nsecrets/\nbuild/\nnode_modules/\n')
    write(repo, 'a.txt')
    write(repo, 'config/tracked.local', 'tracked\n')
    git(repo, 'add', '-f', '.')
    git(repo, 'commit', '--quiet', '-m', 'init')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const fresh = async () => {
    const path = join(dir, `wt-${++n}`)
    await w.create(repo, { path, branch: `b${n}` })
    return path
  }

  it('does nothing without a .worktreeinclude', async () => {
    write(repo, '.env', 'SECRET=1\n')
    const path = await fresh()
    expect(await w.copyIncluded(repo, path)).toMatchObject({ found: false, copied: [] })
    expect(existsSync(join(path, '.env'))).toBe(false)
  })

  it('copies the ignored files that match, nested and by directory, and leaves the rest', async () => {
    write(repo, '.env', 'SECRET=1\n')
    write(repo, 'config/dev.local', 'dev\n')
    write(repo, 'config/skip.local', 'skip\n')
    write(repo, 'secrets/key.pem', 'pem\n')
    write(repo, 'build/out.js', 'out\n')
    write(repo, 'notes.txt', 'untracked, not ignored\n')
    write(repo, '.worktreeinclude', '# local files\n.env\nconfig/*.local\n!config/skip.local\nsecrets/\nnotes.txt\n../elsewhere\n')
    const path = await fresh()
    const r = await w.copyIncluded(repo, path)
    expect(r.found).toBe(true)
    expect(r.copied.sort()).toEqual(['.env', 'config/dev.local', 'secrets/key.pem'])
    expect(readFileSync(join(path, '.env'), 'utf8')).toBe('SECRET=1\n')
    expect(existsSync(join(path, 'config/skip.local'))).toBe(false)
    expect(existsSync(join(path, 'build/out.js'))).toBe(false)
    // Matches the list but git does not ignore it: not copied.
    expect(existsSync(join(path, 'notes.txt'))).toBe(false)
    expect(git(path, 'status', '--porcelain')).toBe('')
  })

  it('never overwrites a tracked file, even one the main checkout ignores and has changed', async () => {
    // `config/tracked.local` is tracked in the branch and matches an ignore rule in main.
    write(repo, 'config/tracked.local', 'changed in main\n')
    write(repo, '.worktreeinclude', 'config/*.local\n')
    const path = await fresh()
    const r = await w.copyIncluded(repo, path)
    expect(readFileSync(join(path, 'config/tracked.local'), 'utf8')).toBe('tracked\n')
    expect(r.copied).not.toContain('config/tracked.local')
    // A file the worktree tracks that the main checkout has untracked and ignored.
    const maker = await fresh()
    git(maker, 'checkout', '--quiet', '-b', 'with-env')
    write(maker, '.env', 'from branch\n')
    git(maker, 'add', '-f', '.env')
    git(maker, 'commit', '--quiet', '-m', 'track env')
    git(maker, 'checkout', '--quiet', '--detach')
    write(repo, '.worktreeinclude', '.env\n')
    const second = join(dir, 'wt-tracked')
    await w.create(repo, { path: second, branch: 'with-env' })
    const again = await w.copyIncluded(repo, second)
    expect(readFileSync(join(second, '.env'), 'utf8')).toBe('from branch\n')
    expect(again.skipped).toContainEqual({ path: '.env', reason: 'tracked' })
  })

  it('skips a symlink that points outside the repository and copies one that stays inside', async () => {
    write(dir, 'outside.txt', 'private\n')
    symlinkSync(join(dir, 'outside.txt'), join(repo, 'out.local'))
    write(repo, 'real.local', 'real\n')
    symlinkSync(join(repo, 'real.local'), join(repo, 'link.local'))
    write(repo, '.worktreeinclude', '*.local\n')
    const path = await fresh()
    const r = await w.copyIncluded(repo, path)
    expect(r.skipped).toContainEqual({ path: 'out.local', reason: 'symlink-outside' })
    expect(existsSync(join(path, 'out.local'))).toBe(false)
    expect(r.copied).toContain('link.local')
    expect(readFileSync(join(path, 'link.local'), 'utf8')).toBe('real\n')
  })

  it('stops at the file and size caps', async () => {
    for (const f of ['c1.local', 'c2.local', 'c3.local']) write(repo, f, '12345')
    write(repo, '.worktreeinclude', 'c?.local\n')
    const byCount = await new GitWorktrees(undefined, { maxFiles: 2, maxBytes: 1000 }).copyIncluded(repo, await fresh())
    expect(byCount.copied).toEqual(['c1.local', 'c2.local'])
    expect(byCount.skipped).toContainEqual({ path: 'c3.local', reason: 'too-many' })
    const bySize = await new GitWorktrees(undefined, { maxFiles: 10, maxBytes: 10 }).copyIncluded(repo, await fresh())
    expect(bySize.copied).toEqual(['c1.local', 'c2.local'])
    expect(bySize.bytes).toBe(10)
    expect(bySize.skipped).toContainEqual({ path: 'c3.local', reason: 'too-big' })
  })
})
