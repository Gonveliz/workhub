import { Check, ChevronDown, X } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useRef, type ReactNode } from 'react'
import { cn } from '../../lib/cn'

/** One filter in use, shown as a removable chip under the row that holds the Filters button. */
export interface ActiveFilter {
  key: string
  /** "Project: notes-api". */
  label: string
  /** The full value, as a tooltip, when the label shortens it. */
  title?: string
  onRemove: () => void
}

export interface FiltersPopoverProps {
  /** The button's text ("Filters"); the count follows it ("Filters · 3"). */
  label: string
  /** How many filters are in use: shown on the button, which takes the accent border from one. */
  count: number
  /** The panel's own content, given by each screen. */
  children: ReactNode
  /** `sm` sits in a dense list header (Pull requests), `md` beside form controls (Usage). */
  size?: 'sm' | 'md'
  /** The panel's width in pixels; it never grows past the window. */
  width?: number
  /** Accessible name of the panel. */
  panelLabel?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  'data-testid'?: string
}

/**
 * More than three filters fold into one "Filters · N" button whose popover holds them. The popover
 * is Radix's: anchored to the button, kept inside the window (it shifts, flips and scrolls), closed
 * by Escape or a click outside, with the focus back on the button.
 */
export function FiltersPopover({ label, count, children, size = 'sm', width = 372, panelLabel, open, onOpenChange, ...rest }: FiltersPopoverProps) {
  const active = count > 0
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger
        ref={trigger}
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border text-text transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 data-[state=open]:bg-surface-hover',
          size === 'sm' ? 'h-6 rounded-md px-2 text-sm' : 'h-8 min-w-30 justify-between rounded-md bg-surface px-2.5 text-base shadow-sm',
          active ? 'border-accent' : 'border-border hover:border-border-strong'
        )}
        data-active={active ? 'true' : undefined}
        data-testid={rest['data-testid']}
      >
        <span>{active ? `${label} · ${count}` : label}</span>
        <ChevronDown className={cn('shrink-0 text-muted', size === 'sm' ? 'size-3' : 'size-3.5')} aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={panel}
          align="start"
          sideOffset={6}
          collisionPadding={8}
          // Radix skips the trigger after an "outside" interaction, and a menu of the panel (its
          // own portal) counts as one: the focus goes back to the button unless the user moved it.
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            const now = document.activeElement
            if (!now || now === document.body || !now.isConnected || panel.current?.contains(now)) trigger.current?.focus()
          }}
          aria-label={panelLabel ?? label}
          style={{ width: `min(${width}px, calc(100vw - 16px))` }}
          className="z-50 flex max-h-[var(--radix-popover-content-available-height)] animate-fade-in flex-col overflow-y-auto rounded-lg border border-border-strong bg-surface-raised p-3.5 text-base shadow-lg focus-visible:outline-none"
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** Closes the popover it sits in (a footer's "Done"). */
export const FiltersPopoverClose = Popover.Close

/** The filters in use as chips with an × each, and a "Clear" that drops them all. Nothing when none is in use. */
export function ActiveFilterChips({ filters, clearLabel, removeLabel, onClear, className, ...rest }: { filters: ActiveFilter[]; clearLabel: string; removeLabel: (label: string) => string; onClear: () => void; className?: string; 'data-testid'?: string }) {
  if (filters.length === 0) return null
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)} data-testid={rest['data-testid'] ?? 'active-filters'}>
      {filters.map((f) => (
        <span key={f.key} className="inline-flex h-6 max-w-64 items-center gap-1 rounded-full border border-accent bg-accent-soft pr-1 pl-2.5 text-xs text-text" title={f.title}>
          <span className="truncate">{f.label}</span>
          <button
            type="button"
            onClick={f.onRemove}
            aria-label={removeLabel(f.label)}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <button type="button" onClick={onClear} className="ml-1 rounded-sm px-1 text-xs text-subtle hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" data-testid="active-filters-clear">
        {clearLabel}
      </button>
    </div>
  )
}

/** A toggling option of a filter group in the popover: a check when on, the accent tint. */
export function FilterOption({ label, on, onToggle, title }: { label: string; on: boolean; onToggle: () => void; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      title={title}
      className={cn(
        'inline-flex h-6 max-w-full items-center gap-1 rounded-full border px-2.5 text-xs whitespace-nowrap transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        on ? 'border-accent bg-accent-soft text-text' : 'border-border-strong text-text hover:bg-surface-hover'
      )}
    >
      {on && <Check className="size-3 shrink-0" aria-hidden />}
      <span className="truncate">{label}</span>
    </button>
  )
}
