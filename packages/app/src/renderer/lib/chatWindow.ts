import { scrollToItem, setRevealItem, type RevealItem } from './chatReveal'

/**
 * The part of a chat that is rendered. A long live chat would otherwise mount thousands of blocks
 * (main's journal caps a rebuilt chat, not one that keeps growing): the pane renders the newest
 * `CHAT_WINDOW_ITEMS` items, cut where a turn begins, and "Show earlier messages" reveals the next
 * chunk above. The window is kept as the id of its first item, so it stays put as items arrive.
 */

/** Items rendered at first, and revealed by each "Show earlier messages". */
export const CHAT_WINDOW_ITEMS = 200

type Item = { id: number; kind: string }

/**
 * The index where a window that should begin at `from` begins: moved back to the start of its turn
 * (the user message before it), so a turn is not cut in half. A turn longer than `size` items is
 * cut where `from` is, or one turn would mount the whole chat.
 */
export function turnStart(items: readonly Item[], from: number, size = CHAT_WINDOW_ITEMS): number {
  const at = Math.min(Math.max(0, from), items.length)
  for (let i = at; i >= 0 && at - i <= size; i--) if (i < items.length && items[i]!.kind === 'user') return i
  return at
}

/**
 * The index of the first rendered item. `startId` undefined: the newest window, which follows the
 * chat as it grows; an id that is no longer in the chat (rebuilt, cleared) falls back to it too.
 */
export function windowStart(items: readonly Item[], startId: number | undefined, size = CHAT_WINDOW_ITEMS): number {
  if (startId !== undefined) {
    const at = items.findIndex((i) => i.id === startId)
    if (at >= 0) return at
  }
  return items.length <= size ? 0 : turnStart(items, items.length - size, size)
}

/** The id of the first item once the next chunk above `start` is revealed (undefined when there is nothing above). */
export function revealEarlier(items: readonly Item[], start: number, size = CHAT_WINDOW_ITEMS): number | undefined {
  if (start <= 0) return undefined
  return items[turnStart(items, start - size, size)]?.id
}

/**
 * The id of the first item of a window that shows `itemId` and everything after it (find in the
 * conversation, a jump to an earlier message); null when the item is not in the chat. An item
 * already rendered keeps the window as it is.
 */
export function revealItemStart(items: readonly Item[], start: number, itemId: number, size = CHAT_WINDOW_ITEMS): number | null {
  const at = items.findIndex((i) => i.id === itemId)
  if (at < 0) return null
  return items[at < start ? turnStart(items, at, size) : start]!.id
}

/**
 * The window after the reader scrolled. Leaving the bottom freezes it where it is, so items arriving
 * below do not slide away what is being read; coming back to the bottom lets it follow the chat
 * again (what was revealed above is let go, out of view).
 */
export function windowAfterScroll(startId: number | undefined, currentStartId: number | undefined, atBottom: boolean): number | undefined {
  if (atBottom) return undefined
  return startId ?? currentStartId
}

/** Whether "Jump to latest" shows: the reader scrolled up while the agent is writing a reply. */
export function showJumpToLatest(atBottom: boolean, state: string): boolean {
  return !atBottom && state === 'busy'
}

type RevealListener = (sessionId: string, itemId: number) => boolean
const revealListeners = new Set<RevealListener>()

/**
 * Renders a chat item that may be outside the window and scrolls it into view (find in the
 * conversation, export). True when a chat of that session on this window showed it.
 */
export function revealChatItem(sessionId: string, itemId: number): boolean {
  let shown = false
  for (const l of revealListeners) if (l(sessionId, itemId)) shown = true
  return shown
}

/** A chat pane answers `revealChatItem` for its session. */
export function onRevealChatItem(cb: RevealListener): () => void {
  revealListeners.add(cb)
  return () => revealListeners.delete(cb)
}

/**
 * Find in the conversation reveals its matches through chatReveal's hook: a chat pane of that
 * session renders the window that holds the item and scrolls to it; with no pane answering, the
 * default scroll is the fallback.
 */
export const revealThroughWindow: RevealItem = (sessionId, itemId) => {
  if (!revealChatItem(sessionId, itemId)) scrollToItem(sessionId, itemId)
}

setRevealItem(revealThroughWindow)
