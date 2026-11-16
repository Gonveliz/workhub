/**
 * `@file` mentions in the chat composer: where the menu opens, how the session's files are ranked
 * against what was typed, and what a pick writes into the draft. Pure: the composer and its tests
 * use it.
 */

/** How many matches the menu shows. */
export const MENTION_RESULTS = 30

export interface MentionTrigger {
  /** Index of the `@`. */
  start: number
  /** What was typed after it, up to the caret. */
  query: string
}

/**
 * The `@word` the caret is in the middle or at the end of, or null. The `@` must start the draft or
 * follow a space, a line break or an opening bracket or quote, so an email address (`me@example.com`)
 * never opens the menu; the word holds no whitespace.
 */
export function mentionTrigger(text: string, caret: number): MentionTrigger | null {
  if (caret < 1 || caret > text.length) return null
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]!
    if (/\s/.test(ch)) return null
    if (ch !== '@') continue
    const before = i === 0 ? '' : text[i - 1]!
    return before === '' || /[\s([{"'`]/.test(before) ? { start: i, query: text.slice(i + 1, caret) } : null
  }
  return null
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** Rank of one path for a lowercase query: lower is better; null when it does not match. */
function score(path: string, q: string): [number, number] | null {
  const lower = path.toLowerCase()
  const base = baseName(lower)
  if (base.startsWith(q)) return [0, 0]
  if (base.includes(q)) return [1, 0]
  if (lower.includes(q)) return [2, 0]
  // Fuzzy: the query's letters in order, from whichever occurrence of the first one gives the
  // tightest match; the letters skipped in between are what ranks.
  let best = -1
  for (let from = lower.indexOf(q[0]!); from >= 0; from = lower.indexOf(q[0]!, from + 1)) {
    let at = from
    for (let k = 1; k < q.length && at >= 0; k++) at = lower.indexOf(q[k]!, at + 1)
    if (at < 0) break
    const skipped = at - from + 1 - q.length
    if (best < 0 || skipped < best) best = skipped
  }
  return best < 0 ? null : [3, best]
}

/**
 * The files that match `query`, best first: names that start with it, names that contain it, paths
 * that contain it, then paths holding its letters in order (`cpane` finds `ChatPane.tsx`). Ties go
 * to the shorter path, then alphabetical. Without a query, the shallowest files come first.
 */
export function rankFiles(files: readonly string[], query: string, limit = MENTION_RESULTS): string[] {
  const q = query.toLowerCase()
  const byPath = (a: string, b: string) => a.length - b.length || a.localeCompare(b)
  if (!q) return files.slice().sort((a, b) => a.split('/').length - b.split('/').length || byPath(a, b)).slice(0, limit)
  const ranked: { path: string; rank: [number, number] }[] = []
  for (const path of files) {
    const rank = score(path, q)
    if (rank) ranked.push({ path, rank })
  }
  return ranked
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || byPath(a.path, b.path))
    .slice(0, limit)
    .map((r) => r.path)
}

/** What a pick writes: the path as it is, in backticks when it has spaces, so the agent reads it as one reference. */
export function mentionText(path: string): string {
  return /\s/.test(path) ? `\`${path}\`` : path
}

/** The draft with the `@word` of `trigger` replaced by the path and a space after it; the caret goes after that space. */
export function insertMention(text: string, caret: number, trigger: MentionTrigger, path: string): { text: string; caret: number } {
  const inserted = `${mentionText(path)} `
  // A space that already follows the word is reused, not doubled.
  const rest = text.slice(caret)
  const tail = rest.startsWith(' ') ? rest.slice(1) : rest
  return { text: text.slice(0, trigger.start) + inserted + tail, caret: trigger.start + inserted.length }
}
