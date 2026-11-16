import { describe, expect, it, vi } from 'vitest'
import { createSessionFiles, SESSION_FILES_TTL_MS } from '../src/main/session-files-ipc'

const listing = { files: ['a.ts'], truncated: false }

describe('session files', () => {
  it('lists the folder of the session it is asked about, and nothing for an unknown one', async () => {
    const list = vi.fn(async () => listing)
    const files = createSessionFiles({ cwdOf: (id) => (id === 's1' ? '/w/acme' : null), list })
    expect(await files('s1')).toEqual(listing)
    expect(list).toHaveBeenCalledWith('/w/acme')
    expect(await files('nope')).toEqual({ files: [], truncated: false })
    expect(await files({ path: '/etc' })).toEqual({ files: [], truncated: false })
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('keeps a listing for a short time, shares a run in flight and lists again after it', async () => {
    let now = 1000
    const list = vi.fn(async () => listing)
    const files = createSessionFiles({ cwdOf: () => '/w/acme', list, now: () => now })
    await Promise.all([files('s1'), files('s1')])
    now += SESSION_FILES_TTL_MS - 1
    await files('s1')
    expect(list).toHaveBeenCalledTimes(1)
    now += 2
    await files('s1')
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('answers an empty listing when the listing fails', async () => {
    const files = createSessionFiles({ cwdOf: () => '/w/acme', list: async () => Promise.reject(new Error('boom')) })
    expect(await files('s1')).toEqual({ files: [], truncated: false })
  })
})
