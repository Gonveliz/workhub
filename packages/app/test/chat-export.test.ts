import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/docs' }, dialog: {} }))

import { createConversationExporter, parseConversationExport } from '../src/main/chat-export'
import { conversationMarkdown, escapeBody, exportFileName, exportTime, inlineCode, type ExportItem, type ExportLabels } from '../src/shared/chat-export'

const labels: ExportLabels = { user: 'You', agent: 'Agent', error: 'Error', tool: 'Tool call:', permission: 'Permission:', compaction: 'Compacted', exported: 'Exported' }
const at = Date.UTC(2026, 10, 15, 10, 30)
const NOW = Date.UTC(2026, 10, 15, 12, 0)

describe('conversation Markdown', () => {
  it('lists user and agent text in order, with timestamps, under a title and the export time', () => {
    const items: ExportItem[] = [
      { kind: 'user', text: 'Fix the bug', at },
      { kind: 'agent', text: 'Done.', at: at + 60_000 }
    ]
    expect(conversationMarkdown('Fix login', items, labels, NOW)).toBe(
      ['# Fix login', 'Exported: 2026-11-15 12:00 UTC', '## You · 2026-11-15 10:30 UTC\n\nFix the bug', '## Agent · 2026-11-15 10:31 UTC\n\nDone.'].join('\n\n') + '\n'
    )
  })

  it('writes a tool call as one line with no output, and groups calls between messages as a list', () => {
    const items: ExportItem[] = [
      { kind: 'user', text: 'Go' },
      { kind: 'tool', title: 'Read src/a.ts', status: 'completed', at, detail: 'SECRET OUTPUT', result: { text: 'SECRET OUTPUT' } } as ExportItem,
      { kind: 'tool', title: 'Run `npm test`\nnow', status: 'failed' },
      { kind: 'agent', text: 'Two things ran.' }
    ]
    const md = conversationMarkdown('s', items, labels, NOW)
    expect(md).not.toContain('SECRET')
    expect(md).toContain('- 2026-11-15 10:30 UTC: Tool call: `Read src/a.ts` (completed)\n- Tool call: ``Run `npm test` now`` (failed)\n\n## Agent')
  })

  it('shows permissions with the answer, errors, and skips thinking, turn ends and empty messages', () => {
    const items: ExportItem[] = [
      { kind: 'permission', title: 'Run rm', answer: 'Allow' },
      { kind: 'error', text: 'boom' },
      { kind: 'thought', text: 'hidden' } as ExportItem,
      { kind: 'turnEnd' },
      { kind: 'agent', text: '   ' },
      { kind: 'compaction', phase: 'running' },
      { kind: 'compaction', phase: 'done' }
    ]
    const md = conversationMarkdown('s', items, labels, NOW)
    expect(md).toContain('- Permission: `Run rm` → Allow')
    expect(md).toContain('## Error\n\nboom')
    expect(md).toContain('- Compacted')
    expect(md).not.toMatch(/hidden|## Agent/)
    expect(md.match(/Compacted/g)).toHaveLength(1)
  })

  it('escapes what would break the file: headings in a message, an unclosed fence, a title that looks like Markdown', () => {
    expect(escapeBody('# not a title\ntext\n   ## nor this')).toBe('\\# not a title\ntext\n   \\## nor this')
    expect(escapeBody('```ts\n# comment\nconst a = 1')).toBe('```ts\n# comment\nconst a = 1\n```')
    expect(escapeBody('```\ncode\n```\n# after')).toBe('```\ncode\n```\n\\# after')
    expect(escapeBody('a\r\nb')).toBe('a\nb')
    expect(inlineCode('a ``` b')).toBe('````a ``` b````')
    expect(inlineCode('`x`')).toBe('`` `x` ``')
    expect(conversationMarkdown('# Heading\nsecond line', [], labels, NOW).split('\n')[0]).toBe('# \\# Heading second line')
  })

  it('formats times in UTC so a chat exports the same anywhere', () => {
    expect(exportTime(Date.UTC(2026, 0, 2, 3, 4))).toBe('2026-01-02 03:04 UTC')
  })
})

describe('export file name', () => {
  it('comes from the session name and the date, safe on every file system', () => {
    const day = new Date(2026, 10, 5, 9).getTime()
    expect(exportFileName('Fix login', day)).toBe('Fix-login-2026-11-05.md')
    expect(exportFileName('a/b:c*?"<>|\\d', day)).toBe('a-b-c-d-2026-11-05.md')
    expect(exportFileName('  ..  ', day)).toBe('conversation-2026-11-05.md')
    expect(exportFileName('x'.repeat(200), day).length).toBeLessThanOrEqual(60 + '-2026-11-05.md'.length)
  })
})

describe('conversation export in main', () => {
  it('refuses a malformed request', () => {
    expect(() => parseConversationExport(null)).toThrow('name')
    expect(() => parseConversationExport({ name: 'a', markdown: 1 })).toThrow('markdown')
    expect(parseConversationExport({ name: 'a', markdown: 'b', path: '/etc/passwd' })).toEqual({ name: 'a', markdown: 'b' })
  })

  it('names the file in the dialog, writes where the dialog says and never uses a renderer path', async () => {
    const pick = vi.fn(async (_default: string) => '/chosen/out.md')
    const write = vi.fn(async () => undefined)
    const run = createConversationExporter({ window: () => null, folder: () => '/docs', now: () => new Date(2026, 10, 5, 9).getTime(), pick, write })
    expect(await run({ name: 'Fix login', markdown: '# x', path: '/etc/passwd' })).toEqual({ ok: true, path: '/chosen/out.md' })
    expect(pick.mock.calls[0]![0]).toMatch(/Fix-login-2026-11-05\.md$/)
    expect(write).toHaveBeenCalledWith('/chosen/out.md', '# x')
  })

  it('a canceled dialog is not an error and a failed write is reported', async () => {
    const write = vi.fn(async () => undefined)
    expect(await createConversationExporter({ window: () => null, folder: () => '/d', pick: async () => undefined, write })({ name: 'a', markdown: 'b' })).toEqual({ ok: false, canceled: true })
    expect(write).not.toHaveBeenCalled()
    const failing = createConversationExporter({ window: () => null, folder: () => '/d', pick: async () => '/x.md', write: async () => Promise.reject(new Error('disk full')) })
    expect(await failing({ name: 'a', markdown: 'b' })).toEqual({ ok: false, canceled: false, error: 'disk full' })
  })
})
