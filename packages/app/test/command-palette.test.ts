import { describe, expect, it } from 'vitest'
import { fuzzyScore, rankPalette, type PaletteItem } from '../src/renderer/lib/commandPalette'

describe('fuzzyScore', () => {
  it('matches the query as a subsequence, without case or accents', () => {
    expect(fuzzyScore('prq', 'Pull requests')).not.toBeNull()
    expect(fuzzyScore('notificacion', 'Notificaciones')).not.toBeNull()
    expect(fuzzyScore('PULL', 'pull requests')).not.toBeNull()
    expect(fuzzyScore('xyz', 'Pull requests')).toBeNull()
    expect(fuzzyScore('sl', 'ls')).toBeNull()
  })

  it('scores characters in a row and word starts above scattered ones', () => {
    expect(fuzzyScore('hist', 'History')!).toBeGreaterThan(fuzzyScore('hist', 'Health insights test')!)
    expect(fuzzyScore('pr', 'Pull requests')!).toBeGreaterThan(fuzzyScore('pr', 'Happy rare')!)
  })
})

describe('rankPalette', () => {
  const items: PaletteItem[] = [
    { id: 's1', kind: 'session', label: 'Fix login bug', detail: 'acme-api · Needs an answer' },
    { id: 's2', kind: 'session', label: 'Write docs', detail: 'acme-web · Working' },
    { id: 'home', kind: 'screen', label: 'Home' },
    { id: 'history', kind: 'screen', label: 'Session history' },
    { id: 'new', kind: 'action', label: 'New session' },
    { id: 'theme', kind: 'setting', label: 'Theme', detail: 'General', searchOnly: true }
  ]
  const ids = (q: string) => rankPalette(items, q).map((i) => i.id)

  it('keeps every item, in order, for an empty query', () => {
    expect(ids('  ')).toEqual(['s1', 's2', 'home', 'history', 'new'])
  })

  it('lists search-only items (Settings rows) once something is typed', () => {
    expect(ids('')).not.toContain('theme')
    expect(ids('theme')).toEqual(['theme'])
  })

  it('puts the best label match first', () => {
    expect(ids('home')[0]).toBe('home')
    expect(ids('hist')[0]).toBe('history')
    expect(ids('new s')[0]).toBe('new')
  })

  it('finds a session by its folder or state, after label matches', () => {
    expect(ids('acme-web')).toEqual(['s2'])
    expect(ids('needs')).toEqual(['s1'])
  })

  it('drops what does not match and caps the list', () => {
    expect(ids('zzz')).toEqual([])
    expect(rankPalette(items, '', 2)).toHaveLength(2)
  })
})
