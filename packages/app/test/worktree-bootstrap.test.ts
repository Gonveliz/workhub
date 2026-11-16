import { describe, expect, it, vi } from 'vitest'
import type { IncludeCopyResult } from '@workhub/core'
import { bootstrapWorktree, lastLines, type SetupRunner } from '../src/main/worktree-bootstrap'

const copy = (over: Partial<IncludeCopyResult> = {}): IncludeCopyResult => ({ copied: [], skipped: [], bytes: 0, found: false, ...over })
// Keys with their params make the assertions independent of the wording.
const t = (key: string, params?: Record<string, string | number>) => `${key}${params ? ` ${JSON.stringify(params)}` : ''}`
const input = { repoRoot: '/r', path: '/r-wt', env: { WORKHUB_SESSION: 's1' } }

describe('bootstrapWorktree', () => {
  it('does nothing without a .worktreeinclude or a setup command', async () => {
    const run = vi.fn()
    expect(await bootstrapWorktree({ worktrees: { copyIncluded: async () => copy() }, t, run }, input)).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('reports the copy and a successful setup command, run in the worktree with the session environment', async () => {
    const run: SetupRunner = vi.fn(async () => ({ exitCode: 0, output: 'added 5 packages\n', timedOut: false }))
    const log = vi.fn()
    const r = await bootstrapWorktree({ worktrees: { copyIncluded: async () => copy({ found: true, copied: ['.env'], bytes: 20 }) }, t, run, log }, { ...input, command: ' npm ci ' })
    expect(run).toHaveBeenCalledWith('npm ci', { cwd: '/r-wt', env: { WORKHUB_SESSION: 's1' }, timeoutMs: 5 * 60_000 })
    expect(r?.failed).toBe(false)
    expect(r?.text).toContain('worktreeBootstrap.copied')
    expect(r?.text).toContain('worktreeBootstrap.setupOk')
    expect(r?.text).toContain('added 5 packages')
    expect(log.mock.calls.flat().join('\n')).toContain('.env')
  })

  it('reports a failing command with the last lines of its output, and does not throw', async () => {
    const output = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n')
    const run: SetupRunner = async () => ({ exitCode: 2, output, timedOut: false })
    const r = await bootstrapWorktree({ worktrees: { copyIncluded: async () => copy() }, t, run }, { ...input, command: 'make' })
    expect(r?.failed).toBe(true)
    expect(r?.text).toContain('worktreeBootstrap.setupFailed {"code":2}')
    expect(r?.text).toContain('line 50')
    expect(r?.text).not.toContain('line 29\n')
    expect(r?.output).toBe(output)
  })

  it('reports a command that timed out, passing the timeout to the runner', async () => {
    const run: SetupRunner = vi.fn(async () => ({ exitCode: null, output: 'still going', timedOut: true }))
    const r = await bootstrapWorktree({ worktrees: { copyIncluded: async () => copy() }, t, run, timeoutMs: 120_000 }, { ...input, command: 'sleep 999' })
    expect(run).toHaveBeenCalledWith('sleep 999', expect.objectContaining({ timeoutMs: 120_000 }))
    expect(r?.failed).toBe(true)
    expect(r?.text).toContain('worktreeBootstrap.setupTimeout {"minutes":2}')
    expect(r?.text).toContain('still going')
  })

  it('survives a runner that throws and a copy that fails, still running the command', async () => {
    const run: SetupRunner = vi.fn(async () => Promise.reject(new Error('spawn ENOENT')))
    const r = await bootstrapWorktree({ worktrees: { copyIncluded: async () => Promise.reject(new Error('git broke')) }, t, run }, { ...input, command: 'x' })
    expect(run).toHaveBeenCalled()
    expect(r?.failed).toBe(true)
    expect(r?.text).toContain('git broke')
    expect(r?.text).toContain('spawn ENOENT')
  })

  it('mentions what was left out of the copy', async () => {
    const r = await bootstrapWorktree({ worktrees: { copyIncluded: async () => copy({ found: true, skipped: [{ path: 'big.bin', reason: 'too-big' }] }) }, t }, input)
    expect(r?.text).toContain('worktreeBootstrap.notCopied {"count":1')
  })
})

describe('lastLines', () => {
  it('keeps the tail, drops blanks and color codes', () => {
    expect(lastLines('a\n\n\u001b[31mb\u001b[0m\nc\n', 2)).toBe('b\nc')
  })
})
