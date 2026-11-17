import { describe, expect, it } from 'vitest'
import { closeAsks, offersWorktreeRemoval, requestSessionClose } from '../src/renderer/lib/closeSession'

const worktree = { repoRoot: '/w/acme', path: '/w/_worktrees/acme-x', branch: 'x' }
const ask = { id: 'p', worktrees: { enabled: true, location: '', branchPrefix: '', baseRef: '', onClose: 'ask' as const } }
const keep = { id: 'k', worktrees: { ...ask.worktrees, onClose: 'keep' as const } }

describe('closing a session', () => {
  it('asks for a working session, or one in a worktree whose profile asks', () => {
    expect(closeAsks({ profileId: 'p' }, false, [ask])).toBe(false)
    expect(closeAsks({ profileId: 'p' }, true, [ask])).toBe(true)
    expect(closeAsks({ profileId: 'p', worktree }, false, [ask])).toBe(true)
    expect(closeAsks({ profileId: 'k', worktree }, false, [keep])).toBe(false)
    // A profile without settings asks (the default).
    expect(offersWorktreeRemoval({ profileId: null, worktree }, [])).toBe(true)
    expect(offersWorktreeRemoval({ profileId: 'k', worktree }, [keep])).toBe(false)
  })
})

describe('requesting a close (the shortcut, the menu and /exit share it)', () => {
  /** Deps that record what happened; `close` rejects when told to. */
  function deps(profiles: () => Promise<typeof ask[]> = async () => [ask], closeFails = false) {
    const log: string[] = []
    return {
      log,
      profiles,
      ask: () => log.push('ask'),
      close: async () => {
        if (closeFails) throw new Error('already gone')
        log.push('close')
      },
      fail: (e: unknown) => log.push(`fail ${(e as Error).message}`)
    }
  }

  it('asks first for a working session or a worktree to keep or remove, else closes at once', async () => {
    const working = deps()
    await requestSessionClose({ profileId: 'p' }, true, working)
    const inWorktree = deps()
    await requestSessionClose({ profileId: 'p', worktree }, false, inWorktree)
    const idle = deps()
    await requestSessionClose({ profileId: 'p' }, false, idle)
    expect([working.log, inWorktree.log, idle.log]).toEqual([['ask'], ['ask'], ['close']])
  })

  it('counts profiles that cannot be read as none, and hands a failed close to `fail`', async () => {
    // No profile settings means the default, which asks about a worktree.
    const unreadable = deps(async () => Promise.reject(new Error('no config')))
    await requestSessionClose({ profileId: 'p', worktree }, false, unreadable)
    const plain = deps(async () => Promise.reject(new Error('no config')))
    await requestSessionClose({ profileId: 'p' }, false, plain)
    expect([unreadable.log, plain.log]).toEqual([['ask'], ['close']])
    const failing = deps(undefined, true)
    await requestSessionClose({ profileId: 'p' }, false, failing)
    expect(failing.log).toEqual(['fail already gone'])
  })

  it('rejects when `fail` rethrows, so a caller can report the failure itself', async () => {
    const rethrowing = {
      ...deps(undefined, true),
      fail: (e: unknown) => {
        throw e
      }
    }
    await expect(requestSessionClose({ profileId: 'p' }, false, rethrowing)).rejects.toThrow('already gone')
  })
})
