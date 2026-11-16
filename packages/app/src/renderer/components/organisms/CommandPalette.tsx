import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Input } from '../atoms'
import { Dialog } from '../molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { rankPalette, type PaletteItem } from '../../lib/commandPalette'

export interface PaletteEntry extends PaletteItem {
  run: () => void
}

const optionId = (i: number) => `palette-option-${i}`

/**
 * ⌘K: one list of sessions, screens and actions, filtered as you type. Keyboard first: the arrows
 * move through the results, Return runs one, Esc closes. The input is a combobox that points at
 * the highlighted option, so a screen reader follows the arrows.
 */
export function CommandPalette({ open, onOpenChange, items }: { open: boolean; onOpenChange: (open: boolean) => void; items: readonly PaletteEntry[] }) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const results = useMemo(() => rankPalette(items, query), [items, query])
  const index = Math.min(active, Math.max(0, results.length - 1))

  // Every opening starts from an empty query.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
    }
  }, [open])
  useEffect(() => setActive(0), [query])
  useEffect(() => {
    list.current?.querySelector(`#${optionId(index)}`)?.scrollIntoView({ block: 'nearest' })
  }, [index, results])

  const run = (entry: PaletteEntry | undefined) => {
    if (!entry) return
    onOpenChange(false)
    entry.run()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (step && results.length) {
      e.preventDefault()
      setActive((index + step + results.length) % results.length)
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      setActive(e.key === 'Home' ? 0 : Math.max(0, results.length - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(results[index])
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('palette.title')}
      className="w-[min(600px,calc(100vw-48px))]"
      onOpenAutoFocus={(e) => {
        e.preventDefault()
        input.current?.focus()
      }}
    >
      <Input
        ref={input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('palette.placeholder')}
        aria-label={t('palette.placeholder')}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={results.length > 0}
        aria-controls="palette-results"
        aria-activedescendant={results.length ? optionId(index) : undefined}
        data-testid="palette-input"
      />
      {results.length ? (
        <ul ref={list} id="palette-results" role="listbox" aria-label={t('palette.results')} className="mt-2 max-h-80 overflow-y-auto" data-testid="palette-results">
          {results.map((r, i) => (
            <li
              key={r.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === index}
              // Picking keeps the focus in the input.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(r)}
              onMouseMove={() => i !== index && setActive(i)}
              className={cn('flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-sm', i === index && 'bg-accent-soft')}
            >
              <span className="max-w-[60%] min-w-0 truncate font-medium text-text">{r.label}</span>
              {r.detail && <span className="min-w-0 flex-1 truncate text-xs text-muted">{r.detail}</span>}
              <span className="ml-auto shrink-0 text-2xs text-subtle">{t(`palette.kind.${r.kind}`)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p role="status" className="mt-3 text-sm text-muted">
          {t('palette.empty')}
        </p>
      )}
    </Dialog>
  )
}
