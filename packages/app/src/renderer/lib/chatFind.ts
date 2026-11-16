/**
 * Find in conversation: the matcher works on the session's items (not on the DOM), so it still
 * finds text in a part of the list that is not rendered. Pure; the find bar (`ChatFind.tsx`)
 * turns a match into a scroll and a highlight.
 */
import type { ChatItem } from '../store'

/** One occurrence: the item it is in and its ordinal among that item's occurrences. */
export interface ChatMatch {
  itemId: number
  occurrence: number
}

/** What a find searches in an item: the text the chat shows as such (not collapsed thinking or tool output). */
export function itemSearchText(item: ChatItem): string {
  switch (item.kind) {
    case 'user':
    case 'agent':
    case 'error':
      return item.text
    case 'tool':
      return item.title
    case 'permission':
      return item.title
    default:
      return ''
  }
}

/** Every case-insensitive occurrence of `query` in the items, in chat order. An empty query matches nothing. */
export function findMatches(items: readonly ChatItem[], query: string): ChatMatch[] {
  const needle = query.toLowerCase()
  if (!needle) return []
  const found: ChatMatch[] = []
  for (const item of items) {
    const hay = itemSearchText(item).toLowerCase()
    if (!hay) continue
    let occurrence = 0
    // Occurrences do not overlap: "aa" in "aaaa" is two, as the highlight draws them.
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) found.push({ itemId: item.id, occurrence: occurrence++ })
  }
  return found
}

/** The match after (1) or before (-1) `index`, wrapping around; -1 when there is no match. */
export function stepMatch(index: number, count: number, step: 1 | -1): number {
  if (count <= 0) return -1
  if (index < 0 || index >= count) return step === 1 ? 0 : count - 1
  return (index + step + count) % count
}
