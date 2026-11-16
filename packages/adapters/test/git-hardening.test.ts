import { beforeEach, describe, expect, it, vi } from 'vitest'

const seen: string[][] = []
vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    seen.push(args)
    cb(null, '', '')
  }
}))

import { GIT_HARDENING } from '../src/git-hardening'
import { GitReview, runGit, type GitRunner } from '../src/git-review'
import { runWorktreeGit } from '../src/git-worktree'

const HARDENING = ['core.fsmonitor=false', 'safe.bareRepository=explicit', 'protocol.ext.allow=never']

/** The `-c key=value` pairs before the subcommand. */
const configOf = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []))

beforeEach(() => {
  seen.length = 0
})

describe('hardened git options', () => {
  it('names the three options that stop a repository config from starting programs', () => {
    expect(GIT_HARDENING).toEqual(['-c', HARDENING[0], '-c', HARDENING[1], '-c', HARDENING[2]])
  })

  it('adds them before the subcommand in the review runner, next to the hooks and pager options', async () => {
    await runGit('/tmp', ['status'])
    expect(seen[0]!.slice(-1)).toEqual(['status'])
    expect(configOf(seen[0]!)).toEqual(expect.arrayContaining(['core.hooksPath=/dev/null', 'core.pager=cat', ...HARDENING]))
  })

  it('adds them in the worktree runner too, which leaves hooks as the repository has them', async () => {
    await runWorktreeGit('/tmp', ['status'])
    expect(configOf(seen[0]!)).toEqual(expect.arrayContaining(HARDENING))
    expect(configOf(seen[0]!).some((c) => c.startsWith('core.hooksPath'))).toBe(false)
  })
})

describe('--end-of-options before anything a user or agent chooses', () => {
  const calls: string[][] = []
  const runner: GitRunner = async (_cwd, args) => {
    calls.push(args)
    return { ok: true, stdout: args[0] === 'remote' ? 'origin\n' : '', stderr: '' }
  }
  const g = new GitReview(runner)
  beforeEach(() => {
    calls.length = 0
  })

  it('puts it between the fetch flags and the remote and base', async () => {
    await g.refreshBase('/r', '--upload-pack=evil')
    const fetch = calls.find((a) => a[0] === 'fetch')!
    expect(fetch.slice(fetch.indexOf('--end-of-options'))).toEqual(['--end-of-options', 'origin', '--upload-pack=evil'])
    expect(fetch.indexOf('--no-tags')).toBeLessThan(fetch.indexOf('--end-of-options'))
  })

  it('puts it before the revisions of diff, log, merge-base and checkout, and keeps the diff flags', async () => {
    await g.diff('/r', '-x', 'HEAD', 100)
    await g.diffStat('/r', '-x', 'HEAD')
    await g.commits('/r', '-x', 'HEAD')
    await g.mergeBase('/r', '-x', 'HEAD')
    await g.isAncestor('/r', '-x', 'HEAD')
    for (const args of calls) {
      const at = args.indexOf('--end-of-options')
      expect(at, args.join(' ')).toBeGreaterThan(0)
      expect(args.slice(0, at).some((a) => a === '-x')).toBe(false)
      expect(args.slice(at + 1).join(' ')).toContain('-x')
      if (args[0] === 'diff') expect(args.slice(0, at)).toEqual(expect.arrayContaining(['--no-ext-diff', '--no-textconv']))
    }
  })
})
