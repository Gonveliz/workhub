/**
 * "Reveal item": makes a chat item visible, whether or not it is rendered. The default scrolls to
 * its element when it exists; a chat list that renders only part of its items replaces it with a
 * function that first renders the part holding the item (`setRevealItem`).
 */
export type RevealItem = (sessionId: string, itemId: number) => void

/** The element a chat item renders into (`data-chat-item` on its wrapper in the chat list). */
export function chatItemElement(root: ParentNode, itemId: number): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-chat-item="${itemId}"]`)
}

/** The default: scroll to the item's element in that session's chat log, when it is rendered (item ids repeat across sessions). */
export const scrollToItem: RevealItem = (sessionId, itemId) => {
  const log = document.querySelector(`[data-chat-log="${CSS.escape(sessionId)}"]`)
  if (log) chatItemElement(log, itemId)?.scrollIntoView({ block: 'center' })
}

let reveal: RevealItem = scrollToItem

/** Replaces the hook (returns a function that puts the previous one back). */
export function setRevealItem(fn: RevealItem): () => void {
  const previous = reveal
  reveal = fn
  return () => {
    if (reveal === fn) reveal = previous
  }
}

export function revealItem(sessionId: string, itemId: number): void {
  reveal(sessionId, itemId)
}

const findListeners = new Set<(sessionId: string) => void>()

/** The menu's Find (⌘F) asked for a session's find bar: its chat opens it. */
export function requestFind(sessionId: string): void {
  for (const l of findListeners) l(sessionId)
}

export function onFindRequest(cb: (sessionId: string) => void): () => void {
  findListeners.add(cb)
  return () => findListeners.delete(cb)
}
