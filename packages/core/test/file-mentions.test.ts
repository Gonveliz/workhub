import { describe, expect, it } from 'vitest'
import { insertMention, mentionText, mentionTrigger, rankFiles } from '../src'

describe('mentionTrigger', () => {
  it('opens on an @ at the start, after a space, a line break or an opening bracket', () => {
    expect(mentionTrigger('@src', 4)).toEqual({ start: 0, query: 'src' })
    expect(mentionTrigger('look at @src/a', 14)).toEqual({ start: 8, query: 'src/a' })
    expect(mentionTrigger('first\n@', 7)).toEqual({ start: 6, query: '' })
    expect(mentionTrigger('(see @a', 7)).toEqual({ start: 5, query: 'a' })
  })

  it('does not open inside an email address or any word', () => {
    expect(mentionTrigger('mail me@example.com', 19)).toBeNull()
    expect(mentionTrigger('me@', 3)).toBeNull()
    expect(mentionTrigger('a@@b', 4)).toBeNull()
  })

  it('does not open once the word ended or without an @', () => {
    expect(mentionTrigger('@src and more', 13)).toBeNull()
    expect(mentionTrigger('no mention here', 15)).toBeNull()
    expect(mentionTrigger('@src', 0)).toBeNull()
    expect(mentionTrigger('@src', 99)).toBeNull()
  })

  it('reads only up to the caret when it sits inside the word', () => {
    expect(mentionTrigger('@chatpane rest', 5)).toEqual({ start: 0, query: 'chat' })
  })
})

describe('rankFiles', () => {
  const files = ['docs/chat.md', 'src/renderer/ChatPane.tsx', 'src/main/chat-ipc.ts', 'README.md', 'src/a/b/c/notes.txt', 'test/chat/pane.test.ts']

  it('puts names that start with the query first, then names and paths that contain it', () => {
    expect(rankFiles(files, 'chat')).toEqual(['docs/chat.md', 'src/main/chat-ipc.ts', 'src/renderer/ChatPane.tsx', 'test/chat/pane.test.ts'])
    expect(rankFiles(files, 'main')).toEqual(['src/main/chat-ipc.ts'])
  })

  it('matches letters in order, tighter spans first, and drops the rest', () => {
    expect(rankFiles(files, 'cpane')).toEqual(['src/renderer/ChatPane.tsx', 'test/chat/pane.test.ts'])
    expect(rankFiles(files, 'zzz')).toEqual([])
  })

  it('is case insensitive and caps the result', () => {
    expect(rankFiles(files, 'READ')).toEqual(['README.md'])
    expect(rankFiles(files, 'c', 2)).toHaveLength(2)
  })

  it('lists the shallowest files for an empty query', () => {
    expect(rankFiles(files, '', 2)).toEqual(['README.md', 'docs/chat.md'])
  })
})

describe('insertMention', () => {
  it('replaces the @word with the path and a space, and moves the caret after it', () => {
    const t = mentionTrigger('read @cha please', 9)!
    expect(insertMention('read @cha please', 9, t, 'src/ChatPane.tsx')).toEqual({ text: 'read src/ChatPane.tsx please', caret: 22 })
  })

  it('does not double a space that is already there, and adds one at the end', () => {
    expect(insertMention('@a', 2, mentionTrigger('@a', 2)!, 'a.ts')).toEqual({ text: 'a.ts ', caret: 5 })
  })

  it('quotes a path with spaces in backticks', () => {
    expect(mentionText('docs/my notes.md')).toBe('`docs/my notes.md`')
    expect(mentionText('docs/notes.md')).toBe('docs/notes.md')
    expect(insertMention('@my', 3, mentionTrigger('@my', 3)!, 'my notes.md').text).toBe('`my notes.md` ')
  })
})
