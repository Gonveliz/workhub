import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function fakeStorage() {
  const map = new Map<string, string>()
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), map }
}

describe('stored composer drafts', () => {
  let storage: ReturnType<typeof fakeStorage>
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    storage = fakeStorage()
    vi.stubGlobal('localStorage', storage)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('writes after typing pauses and reads back after a remount', async () => {
    const { saveStoredDraft, loadStoredDraft } = await import('../src/renderer/lib/drafts')
    saveStoredDraft('s1', 'hel')
    saveStoredDraft('s1', 'hello')
    expect(storage.map.size).toBe(0)
    vi.advanceTimersByTime(500)
    expect(storage.map.size).toBe(1)
    vi.resetModules()
    const again = await import('../src/renderer/lib/drafts')
    expect(again.loadStoredDraft('s1')).toBe('hello')
    expect(loadStoredDraft('s2')).toBe('')
  })

  it('flushes at once on unmount and keeps other sessions apart', async () => {
    const { saveStoredDraft, flushStoredDrafts, loadStoredDraft } = await import('../src/renderer/lib/drafts')
    saveStoredDraft('s1', 'one')
    saveStoredDraft('s2', 'two')
    flushStoredDrafts()
    vi.resetModules()
    const again = await import('../src/renderer/lib/drafts')
    expect(again.loadStoredDraft('s1')).toBe('one')
    expect(again.loadStoredDraft('s2')).toBe('two')
    expect(loadStoredDraft('s1')).toBe('one')
  })

  it('clears a draft when it is sent or its session is removed', async () => {
    const { saveStoredDraft, flushStoredDrafts, clearStoredDraft, loadStoredDraft } = await import('../src/renderer/lib/drafts')
    saveStoredDraft('s1', 'one')
    flushStoredDrafts()
    clearStoredDraft('s1')
    expect(loadStoredDraft('s1')).toBe('')
    vi.resetModules()
    expect((await import('../src/renderer/lib/drafts')).loadStoredDraft('s1')).toBe('')
  })

  it('survives corrupt storage, and the one-shot hand-over still works', async () => {
    storage.setItem('workhub.composerDrafts', '{nope')
    const { loadStoredDraft, setComposerDraft, takeComposerDraft } = await import('../src/renderer/lib/drafts')
    expect(loadStoredDraft('s1')).toBe('')
    setComposerDraft('s1', 'pushed')
    expect(takeComposerDraft('s1')).toBe('pushed')
    expect(takeComposerDraft('s1')).toBeUndefined()
  })
})
