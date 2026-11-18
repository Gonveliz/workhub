import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/cn'

/** The menu and item classes of a filter chip's dropdown (Pull requests' narrowing bar, Tickets). */
export const FILTER_MENU = 'z-50 max-h-80 min-w-52 animate-fade-in overflow-y-auto rounded-md border border-border bg-surface-raised p-1 shadow-lg'
export const FILTER_ITEM = 'flex h-7 cursor-default select-none items-center gap-2 rounded-sm px-2 text-sm outline-none data-[highlighted]:bg-accent-soft data-[disabled]:opacity-45'

/** A filter's trigger: its name when unset, the chosen value in the accent color when set. */
export function FilterChip({ label, active }: { label: string; active: boolean }) {
  return (
    <span className={cn('inline-flex h-6 max-w-56 items-center gap-1 rounded-full border px-2 text-xs', active ? 'border-accent/50 bg-accent-soft font-medium text-accent' : 'border-border text-muted hover:text-text')}>
      <span className="truncate">{label}</span>
      <ChevronDown className="size-3 shrink-0" aria-hidden />
    </span>
  )
}
