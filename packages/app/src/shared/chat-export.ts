/**
 * "Export conversation": a session's chat as Markdown. Pure, so it is tested without a window; the
 * renderer builds the text from the items it holds, and main only asks where to save it (see
 * `main/chat-export.ts`). User and agent text, one line per tool call, no tool output.
 */

/** The parts of a chat item the export reads (structurally a `ChatItem`; main never sees the items). */
export type ExportItem =
  | { kind: 'user' | 'agent'; text: string; at?: number }
  | { kind: 'error'; text: string; at?: number }
  | { kind: 'tool'; title: string; status: string; at?: number }
  | { kind: 'permission'; title: string; answer?: string; at?: number }
  | { kind: 'compaction'; phase: string; at?: number }
  | { kind: string; at?: number }

export interface ExportLabels {
  user: string
  agent: string
  error: string
  tool: string
  permission: string
  compaction: string
  exported: string
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `2026-11-15 10:30 UTC`: UTC so the same chat exports to the same text on any machine. */
export function exportTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

/**
 * A message body made safe to sit under its own heading: a line that starts with `#` would open a
 * heading of its own in the file, and an unclosed code fence would swallow everything after it.
 */
export function escapeBody(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let fence: string | null = null
  const out = lines.map((line) => {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (m) {
      const mark = m[1]!
      if (fence === null) fence = mark
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null
      return line
    }
    // Inside a fence a `#` is code, not a heading.
    return fence === null ? line.replace(/^( {0,3})#/, '$1\\#') : line
  })
  if (fence !== null) out.push(fence)
  return out.join('\n').trim()
}

/** Text as an inline code span on one line: the fence is longer than any backtick run inside. */
export function inlineCode(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((r) => r.length))
  const fence = '`'.repeat(longest + 1)
  return flat.startsWith('`') || flat.endsWith('`') ? `${fence} ${flat} ${fence}` : `${fence}${flat}${fence}`
}

/** A name on one line, with nothing Markdown could take as formatting at the start. */
function heading(name: string): string {
  return name.replace(/\s+/g, ' ').trim().replace(/^[#>\-+*\d]/, '\\$&')
}

/** A message's heading line: who, and when when known. */
const turn = (label: string, at: number | undefined) => `## ${label}${at === undefined ? '' : ` · ${exportTime(at)}`}`

/** The conversation as Markdown: items in order; tool calls as one line each, grouped as a list. */
export function conversationMarkdown(name: string, items: readonly ExportItem[], labels: ExportLabels, exportedAt: number): string {
  const blocks: string[] = [`# ${heading(name) || labels.agent}`, `${labels.exported}: ${exportTime(exportedAt)}`]
  let list: string[] = []
  const flush = () => {
    if (list.length) blocks.push(list.join('\n'))
    list = []
  }
  for (const item of items) {
    const stamp = item.at === undefined ? '' : `${exportTime(item.at)}: `
    if (item.kind === 'tool') {
      const t = item as Extract<ExportItem, { kind: 'tool' }>
      list.push(`- ${stamp}${labels.tool} ${inlineCode(t.title)} (${t.status.replace(/\s+/g, ' ')})`)
      continue
    }
    if (item.kind === 'permission') {
      const p = item as Extract<ExportItem, { kind: 'permission' }>
      list.push(`- ${stamp}${labels.permission} ${inlineCode(p.title)}${p.answer ? ` → ${p.answer.replace(/\s+/g, ' ')}` : ''}`)
      continue
    }
    if (item.kind === 'compaction') {
      const c = item as Extract<ExportItem, { kind: 'compaction' }>
      if (c.phase === 'done') list.push(`- ${stamp}${labels.compaction}`)
      continue
    }
    if (item.kind === 'user' || item.kind === 'agent' || item.kind === 'error') {
      const m = item as Extract<ExportItem, { kind: 'user' | 'agent' | 'error' }>
      const body = escapeBody(m.text)
      if (!body) continue
      flush()
      blocks.push(`${turn(labels[m.kind], m.at)}\n\n${body}`)
    }
  }
  flush()
  return blocks.join('\n\n') + '\n'
}

const FILE_BAD = /[\\/:*?"<>|\u0000-\u001f]/g

/** `my-session-2026-11-15.md`: the session's name and the date, safe on every file system. */
export function exportFileName(name: string, at: number): string {
  const d = new Date(at)
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const base = name
    .replace(FILE_BAD, ' ')
    .replace(/\s+/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 60)
    .replace(/[.\-]+$/g, '')
  return `${base || 'conversation'}-${date}.md`
}
