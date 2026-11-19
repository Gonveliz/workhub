import { Check, Search } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { UNASSIGNED, type FacetValue, type TicketFacets, type TicketFilter } from '@workhub/core'
import { Input } from '../../components/atoms'
import { FILTER_ITEM, FILTER_MENU, FilterChip } from '../../components/molecules/FilterChip'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { TICKET_SCOPES, chipLabel, isFiltered, toggleValue, type TicketScope } from '../../lib/ticketsView'

export interface TicketFilterBarProps {
  /** The scope switch; left out when the tracker has no backlog view. */
  scope?: { value: TicketScope; onChange: (scope: TicketScope) => void; counts: Partial<Record<TicketScope, number>> }
  filter: TicketFilter
  onChange: (filter: TicketFilter) => void
  facets: TicketFacets
  /** The assignee filter: only in the backlog, where tickets belong to different people. */
  showAssignee: boolean
  shown: number
  total: number
}

/**
 * The Tickets screen's toolbar: the scope switch and the search on one line; under them, the
 * project, assignee and status chips (Pull requests' narrowing bar), "N of M" and Clear. Each chip
 * takes several values: its menu stays open while they are ticked, and "All" unticks them. A chip
 * with a single value to pick is left out unless it is set.
 */
export function TicketFilterBar({ scope, filter, onChange, facets, showAssignee, shown, total }: TicketFilterBarProps) {
  const { t } = useI18n()
  const set = (patch: Partial<TicketFilter>) => onChange({ ...filter, ...patch })
  const assignees: FacetValue[] = [...facets.assignees, ...(facets.unassigned > 0 ? [{ value: UNASSIGNED, count: facets.unassigned }] : [])]
  const assigneeLabel = (v: string) => (v === UNASSIGNED ? t('tickets.filter.unassigned') : v)
  const chips = [
    { key: 'project', title: t('tickets.filter.project'), all: t('tickets.filter.allProjects'), values: facets.projects, value: filter.project, label: (v: string) => v, show: true },
    { key: 'assignee', title: t('tickets.filter.assignee'), all: t('tickets.filter.anyone'), values: assignees, value: filter.assignee, label: assigneeLabel, show: showAssignee },
    { key: 'status', title: t('tickets.filter.status'), all: t('tickets.filter.allStatuses'), values: facets.statuses, value: filter.status, label: (v: string) => v, show: true }
  ] as const
  const visible = chips.filter((c) => c.show && (c.values.length > 1 || c.value?.length))
  const filtered = isFiltered(filter)

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-3">
        {scope && (
          <div role="radiogroup" aria-label={t('tickets.scope')} className="flex gap-1 rounded-md bg-surface-hover p-0.5">
            {TICKET_SCOPES.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={scope.value === s}
                onClick={() => scope.onChange(s)}
                className={cn('h-7 whitespace-nowrap rounded-sm px-3 text-sm transition-colors duration-150', scope.value === s ? 'bg-surface-raised font-semibold text-text shadow-sm' : 'text-muted hover:text-text')}
              >
                {t(s === 'mine' ? 'tickets.scope.mine' : 'tickets.scope.backlog')}
                {scope.counts[s] !== undefined && <span className="ml-1.5 text-xs font-normal tabular-nums text-subtle">{scope.counts[s]}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-subtle" aria-hidden />
          <Input type="search" value={filter.text ?? ''} onChange={(e) => set({ text: e.target.value || undefined })} placeholder={t('tickets.filter.search')} aria-label={t('tickets.filter.search')} className="pl-8" spellCheck={false} />
        </div>
      </div>
      {(visible.length > 0 || filtered) && (
        <div role="group" aria-label={t('tickets.filter.bar')} className="flex flex-wrap items-center gap-1.5">
          {visible.map((c) => (
            <DropdownMenu.Root key={c.key}>
              <DropdownMenu.Trigger aria-label={c.value?.length ? `${c.title}: ${c.value.map(c.label).join(', ')}` : c.title} className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" data-testid={`ticket-filter-${c.key}`}>
                <FilterChip label={c.value?.length ? chipLabel(c.value, c.label) : c.title} active={Boolean(c.value?.length)} />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="start" sideOffset={4} className={FILTER_MENU}>
                  <DropdownMenu.CheckboxItem checked={!c.value?.length} onCheckedChange={() => set({ [c.key]: undefined })} className={cn(FILTER_ITEM, 'group')}>
                    <Tick />
                    <span className="min-w-0 flex-1 truncate">{c.all}</span>
                    <span className="text-xs tabular-nums text-subtle">{total}</span>
                  </DropdownMenu.CheckboxItem>
                  <DropdownMenu.Separator className="my-1 h-px bg-border" />
                  {c.values.map((o) => (
                    <DropdownMenu.CheckboxItem
                      key={o.value}
                      checked={Boolean(c.value?.includes(o.value))}
                      // Ticking a value keeps the menu open, so several can be picked in a row.
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={() => set({ [c.key]: toggleValue(c.value, o.value) })}
                      className={cn(FILTER_ITEM, 'group')}
                    >
                      <Tick />
                      <span className={cn('min-w-0 flex-1 truncate', o.value === UNASSIGNED && 'italic')}>{c.label(o.value)}</span>
                      <span className="text-xs tabular-nums text-subtle">{o.count}</span>
                    </DropdownMenu.CheckboxItem>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          ))}
          {filtered && (
            <>
              <span className="ml-1 text-xs tabular-nums text-subtle">{t('tickets.filter.showing', { shown, total })}</span>
              <button type="button" className="text-xs text-accent hover:underline focus-visible:outline-none focus-visible:underline" onClick={() => onChange({})}>
                {t('tickets.filter.clear')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** The box of a value in a filter menu: ticked when the value is chosen. */
function Tick() {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center rounded-sm border border-border-strong group-data-[state=checked]:border-accent group-data-[state=checked]:bg-accent group-data-[state=checked]:text-bg">
      <DropdownMenu.ItemIndicator>
        <Check className="size-3" aria-hidden strokeWidth={3} />
      </DropdownMenu.ItemIndicator>
    </span>
  )
}
