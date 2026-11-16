import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { IconButton } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { findMatches, stepMatch } from '../../lib/chatFind'
import { onFindRequest, revealItem } from '../../lib/chatReveal'
import type { ChatItem } from '../../store'

/** The text ranges of `needle` (case-insensitive) in an element's text nodes, in document order. */
function rangesIn(el: HTMLElement, needle: string): Range[] {
  const found: Range[] = []
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const hay = (node.nodeValue ?? '').toLowerCase()
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + needle.length)
      found.push(range)
    }
  }
  return found
}

const HIGHLIGHT = 'chat-find'
const HIGHLIGHT_CURRENT = 'chat-find-current'

function clearHighlights(): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return
  CSS.highlights.delete(HIGHLIGHT)
  CSS.highlights.delete(HIGHLIGHT_CURRENT)
}

/**
 * The chat's find bar (⌘F): next, previous, a count, Esc closes. It searches the items in the
 * store, so a match in a part of the list that is not rendered still counts; `revealItem` brings
 * that part into view, then the matches in the DOM are highlighted (CSS Custom Highlight API).
 */
export function ChatFind({ sessionId, items, active, log }: { sessionId: string; items: readonly ChatItem[]; active: boolean; log: RefObject<HTMLElement | null> }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  // Bumped by Enter on a single match, so it scrolls back to it.
  const [tick, setTick] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(
    () =>
      onFindRequest((id) => {
        if (id !== sessionId || !active) return
        setOpen(true)
        // The bar may be mounting now: focus after it renders.
        requestAnimationFrame(() => {
          input.current?.focus()
          input.current?.select()
        })
      }),
    [sessionId, active]
  )

  const matches = useMemo(() => (open ? findMatches(items, query) : []), [open, items, query])
  const current = matches.length === 0 ? -1 : Math.min(index, matches.length - 1)

  const close = () => {
    setOpen(false)
    clearHighlights()
  }
  useEffect(() => clearHighlights, [])

  // Bring the current match into view (the default scrolls; a windowed list renders its part first).
  const match = current >= 0 ? matches[current] : undefined
  const matchKey = match ? `${query}\0${match.itemId}\0${match.occurrence}\0${tick}` : ''
  const scrolled = useRef('')
  useEffect(() => {
    if (!open || !match) return
    revealItem(sessionId, match.itemId)
  }, [open, matchKey, sessionId])

  // Draw the highlights, again whenever the chat changes; the scroll to the match happens once per match.
  useEffect(() => {
    const root = log.current
    if (!open || !root || typeof CSS === 'undefined' || !('highlights' in CSS)) return
    const needle = query.toLowerCase()
    if (!needle) return clearHighlights()
    const draw = () => {
      const all: Range[] = []
      let focused: Range | undefined
      for (const el of root.querySelectorAll<HTMLElement>('[data-chat-item]')) {
        const ranges = rangesIn(el, needle)
        all.push(...ranges)
        if (match && Number(el.dataset['chatItem']) === match.itemId) focused = ranges[Math.min(match.occurrence, ranges.length - 1)]
      }
      CSS.highlights.set(HIGHLIGHT, new Highlight(...all))
      if (focused) CSS.highlights.set(HIGHLIGHT_CURRENT, new Highlight(focused))
      else CSS.highlights.delete(HIGHLIGHT_CURRENT)
      if (focused && scrolled.current !== matchKey) {
        scrolled.current = matchKey
        focused.startContainer.parentElement?.scrollIntoView({ block: 'center' })
      }
    }
    draw()
    // The reveal may render the item on the next frame.
    const frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [open, query, matchKey, items, log])

  if (!open) return null
  const go = (step: 1 | -1) => {
    setIndex(stepMatch(current, matches.length, step))
    setTick((n) => n + 1)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      go(e.shiftKey ? -1 : 1)
    }
  }
  const status = !query ? '' : matches.length === 0 ? t('chat.find.none') : t('chat.find.count', { n: current + 1, total: matches.length })
  return (
    <div role="search" data-testid="chat-find" className="absolute top-2 right-6 z-20 flex items-center gap-1 rounded-lg border border-border bg-surface-raised px-2 py-1 shadow-lg">
      <input
        ref={input}
        type="text"
        value={query}
        autoFocus
        spellCheck={false}
        aria-label={t('chat.find.label')}
        placeholder={t('chat.find.placeholder')}
        data-testid="chat-find-input"
        onChange={(e) => {
          setQuery(e.target.value)
          setIndex(0)
        }}
        onKeyDown={onKey}
        className="h-6 w-44 bg-transparent px-1 text-sm text-text outline-none placeholder:text-subtle"
      />
      <span aria-live="polite" data-testid="chat-find-count" className="min-w-14 text-center text-xs text-subtle tabular-nums">
        {status}
      </span>
      <IconButton size="sm" label={t('chat.find.previous')} icon={<ChevronUp className="size-3.5" />} disabled={matches.length === 0} onClick={() => go(-1)} />
      <IconButton size="sm" label={t('chat.find.next')} icon={<ChevronDown className="size-3.5" />} disabled={matches.length === 0} onClick={() => go(1)} />
      <IconButton size="sm" label={t('chat.find.close')} icon={<X className="size-3.5" />} onClick={close} />
    </div>
  )
}
