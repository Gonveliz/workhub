import { useLayoutEffect, useRef, type RefObject } from 'react'

/** The nearest ancestor that scrolls vertically (the page itself when none does). */
export function scrollParentOf(el: HTMLElement): Element | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return document.scrollingElement
}

/**
 * For a table whose rows open: keeps the row a press opened where it was on screen. Opening it
 * closes another one, and when that one was above, everything under it moves up; the page then
 * scrolls by the same amount, so the row stays under the pointer. When the open row changes
 * without a press (picked somewhere else), `reveal` is brought into view instead.
 *
 * `ref(key)` goes on each row, `mark(key)` is called in its press handler before the change.
 */
export function useRowAnchor(openKey: string, options: { enabled?: boolean; reveal?: RefObject<HTMLElement | null> } = {}) {
  const rows = useRef(new Map<string, HTMLElement>())
  const pressed = useRef<{ key: string; top: number } | null>(null)
  useLayoutEffect(() => {
    if (options.enabled === false) return
    const press = pressed.current
    pressed.current = null
    const el = press ? rows.current.get(press.key) : undefined
    if (press && el) {
      const delta = el.getBoundingClientRect().top - press.top
      if (Math.abs(delta) > 0.5) scrollParentOf(el)?.scrollBy({ top: delta })
    } else if (openKey) {
      options.reveal?.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [openKey]) // eslint-disable-line react-hooks/exhaustive-deps
  return {
    ref: (key: string) => (el: HTMLElement | null) => void (el ? rows.current.set(key, el) : rows.current.delete(key)),
    mark: (key: string) => {
      const el = rows.current.get(key)
      pressed.current = el ? { key, top: el.getBoundingClientRect().top } : null
    }
  }
}
