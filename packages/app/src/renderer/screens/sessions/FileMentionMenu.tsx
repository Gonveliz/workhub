import { useEffect, useRef } from 'react'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'

/** The option's element id, for the composer's `aria-activedescendant`. */
export const mentionOptionId = (sessionId: string, index: number) => `mention-${sessionId}-${index}`

/**
 * The composer's `@` menu: the session's files that match what follows the `@`, as relative paths
 * (the name first, its folder after it). Same keys as the `/` menu: arrows, Enter or Tab, Esc; a
 * click picks an entry.
 */
export function FileMentionMenu({
  sessionId,
  paths,
  selected,
  onPick,
  onHover
}: {
  sessionId: string
  paths: readonly string[]
  selected: number
  onPick: (path: string) => void
  onHover: (index: number) => void
}) {
  const { t } = useI18n()
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    list.current?.querySelector(`#${CSS.escape(mentionOptionId(sessionId, selected))}`)?.scrollIntoView({ block: 'nearest' })
  }, [sessionId, selected])
  return (
    <ul
      ref={list}
      id={`mention-${sessionId}`}
      role="listbox"
      aria-label={t('mention.menu')}
      data-testid="mention-menu"
      className="mx-2 mt-2 max-h-64 overflow-y-auto rounded-lg border border-border bg-surface-raised p-1 text-sm shadow-md"
    >
      {paths.map((path, i) => {
        const cut = path.lastIndexOf('/')
        return (
          <li
            key={path}
            id={mentionOptionId(sessionId, i)}
            role="option"
            aria-selected={i === selected}
            data-testid="mention-option"
            // Picking keeps the focus in the composer.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(path)}
            onMouseMove={() => i !== selected && onHover(i)}
            className={cn('flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1', i === selected && 'bg-accent-soft')}
          >
            <span className="shrink-0 font-semibold text-text">{path.slice(cut + 1)}</span>
            {cut > 0 && <span className="min-w-0 truncate text-xs text-muted">{path.slice(0, cut)}</span>}
          </li>
        )
      })}
    </ul>
  )
}
