import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/**
 * After answering a pinned request: the request whose card takes the focus (the next one, else the
 * one before), or null when none is left and the focus goes to the composer.
 */
export function nextRequestAfter(pending: readonly { requestId: string }[], answered: string): string | null {
  const i = pending.findIndex((p) => p.requestId === answered)
  if (i < 0) return null
  return (pending[i + 1] ?? pending[i - 1])?.requestId ?? null
}

/** The element to focus once the answered card is gone: the next card's first button, else the composer. */
export function pendingFocusTarget(section: ParentNode | null, requestId: string | null, composer: HTMLElement | null): HTMLElement | null {
  if (requestId !== null && section) {
    const card = [...section.querySelectorAll<HTMLElement>('[data-request-id]')].find((el) => el.dataset['requestId'] === requestId)
    const button = card?.querySelector<HTMLElement>('button:not([disabled])')
    if (button) return button
  }
  return composer
}

/**
 * Moves the focus after a pinned request is answered, so a keyboard or screen reader user lands on
 * the next request or back in the composer instead of on a card that just disappeared. Call the
 * returned function with the answered request id, before the answer reaches the store.
 */
export function usePendingFocus(pending: readonly { requestId: string }[], section: RefObject<HTMLElement | null>, composer: RefObject<HTMLElement | null>): (answered: string) => void {
  const list = useRef(pending)
  list.current = pending
  const target = useRef<{ id: string | null } | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const next = target.current
    if (!next) return
    target.current = null
    pendingFocusTarget(section.current, next.id, composer.current)?.focus()
  }, [tick, pending, section, composer])
  return useCallback((answered: string) => {
    target.current = { id: nextRequestAfter(list.current, answered) }
    setTick((n) => n + 1)
  }, [])
}

const answerListeners = new Set<(sessionId: string) => void>()

/** The keyboard asked to answer a session's pending request (the menu's Answer Pending Request): its chat moves the focus there. */
export function requestAnswerFocus(sessionId: string): void {
  for (const l of answerListeners) l(sessionId)
}

export function onAnswerFocus(cb: (sessionId: string) => void): () => void {
  answerListeners.add(cb)
  return () => answerListeners.delete(cb)
}

/** The option a digit key picks on a focused permission card: 1 is the first button; null for any other key. */
export function optionForKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, count: number): number | null {
  if (e.metaKey || e.ctrlKey || e.altKey || !/^[1-9]$/.test(e.key)) return null
  const n = Number(e.key) - 1
  return n < count ? n : null
}
