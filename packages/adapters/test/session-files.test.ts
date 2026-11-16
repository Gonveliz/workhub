import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listSessionFiles } from '../src/session-files'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
const put = (root: string, rel: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), 'x\n')
}

describe('listSessionFiles', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'workhub-session-files-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

  it('lists tracked and untracked files of a repository, not the ignored ones', async () => {
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '--quiet', '-b', 'main')
    put(repo, 'src/a.ts')
    put(repo, 'my notes.md')
    put(repo, '.gitignore')
    writeFileSync(join(repo, '.gitignore'), 'dist/\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '--quiet', '-m', 'init')
    put(repo, 'src/new.ts')
    put(repo, 'dist/out.js')
    const r = await listSessionFiles(repo)
    expect(r.files.sort()).toEqual(['.gitignore', 'my notes.md', 'src/a.ts', 'src/new.ts'])
    expect(r.truncated).toBe(false)
  })

  it('lists paths relative to a folder inside the repository', async () => {
    const r = await listSessionFiles(join(dir, 'repo', 'src'))
    expect(r.files.sort()).toEqual(['a.ts', 'new.ts'])
  })

  it('cuts a listing at the cap and says so', async () => {
    const r = await listSessionFiles(join(dir, 'repo'), undefined, 2)
    expect(r.files).toHaveLength(2)
    expect(r.truncated).toBe(true)
  })

  it('walks a folder that is not a repository, skipping dot folders and node_modules', async () => {
    const plain = join(dir, 'plain')
    put(plain, 'top.txt')
    put(plain, 'lib/deep/file.ts')
    put(plain, 'node_modules/pkg/index.js')
    put(plain, '.cache/x')
    put(plain, '.hidden')
    const r = await listSessionFiles(plain)
    expect(r.files.sort()).toEqual(['lib/deep/file.ts', 'top.txt'])
    expect(r.truncated).toBe(false)
  })

  it('stops the walk at the cap', async () => {
    const big = join(dir, 'big')
    for (let i = 0; i < 6; i++) put(big, `f${i}.txt`)
    const r = await listSessionFiles(big, undefined, 3)
    expect(r.files).toHaveLength(3)
    expect(r.truncated).toBe(true)
  })
})
