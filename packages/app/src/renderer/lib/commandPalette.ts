/**
 * The command palette's list: sessions, screens and a few actions in one place, found by a fuzzy
 * match on their names (and, weaker, on what describes them: a session's folder and state).
 */
import { foldText } from '../screens/settings/settings-index'

export type PaletteKind = 'session' | 'screen' | 'action' | 'setting'

export interface PaletteItem {
  id: string
  kind: PaletteKind
  label: string
  /** What else finds the item and is shown beside it (a folder, a state, where a setting is). */
  detail?: string
  /** Listed only once something is typed (the many rows of the Settings search index). */
  searchOnly?: boolean
}

/**
 * How well `query` matches `text` as a subsequence of its characters, compared without case or
 * accents; null when it does not. Higher is better: characters in a row, at the start of a word
 * and early in the text count more, so "prq" finds "Pull requests" and "home" ranks "Home" first.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = foldText(query).replace(/\s+/g, '')
  if (!q) return 0
  const t = foldText(text)
  let score = 0
  let from = 0
  let prev = -2
  for (const ch of q) {
    const at = t.indexOf(ch, from)
    if (at < 0) return null
    const wordStart = at === 0 || /[^\p{L}\p{N}]/u.test(t[at - 1]!)
    score += 1 + (at === prev + 1 ? 3 : 0) + (wordStart ? 2 : 0)
    prev = at
    from = at + 1
  }
  // A shorter text, and a match that starts earlier, is closer to what was typed.
  return score - t.indexOf(q[0]!) * 0.1 - t.length * 0.01
}

/**
 * The items that match, best first; a match on the label beats one only on the detail. Ties keep
 * the given order (sessions in sidebar order, then screens, then actions). An empty query keeps all
 * but the search-only items.
 */
export function rankPalette<T extends PaletteItem>(items: readonly T[], query: string, limit = 50): T[] {
  if (!query.trim()) return items.filter((i) => !i.searchOnly).slice(0, limit)
  const scored: { item: T; score: number; order: number }[] = []
  items.forEach((item, order) => {
    const onLabel = fuzzyScore(query, item.label)
    const onDetail = item.detail ? fuzzyScore(query, `${item.label} ${item.detail}`) : null
    const score = onLabel !== null ? onLabel + 100 : onDetail
    if (score !== null) scored.push({ item, score, order })
  })
  scored.sort((a, b) => b.score - a.score || a.order - b.order)
  return scored.slice(0, limit).map((s) => s.item)
}
