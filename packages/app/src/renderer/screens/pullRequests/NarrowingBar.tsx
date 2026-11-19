import { ArrowUpDown, Check } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import type { PullRequestItem, PullRequestStatus } from '@workhub/core'
import { FILTER_ITEM, FILTER_MENU, FilterChip } from '../../components/molecules/FilterChip'
import { useI18n } from '../../i18n/I18nProvider'
import {
  clearNarrowing,
  isNarrowed,
  narrowOptions,
  PR_ORDERS,
  TICKET_FILTERS,
  ticketCounts,
  toggleValue,
  type NarrowField,
  type PrNarrowing
} from '../../lib/prNarrowing'
import { STATUS_META } from '../../lib/pullRequests'
import type { MessageKey } from '../../i18n/translate'


const FIELDS: { field: NarrowField; title: MessageKey }[] = [
  { field: 'statuses', title: 'pr.narrow.status' },
  { field: 'bases', title: 'pr.narrow.base' },
  { field: 'repos', title: 'pr.narrow.repo' },
  { field: 'authors', title: 'pr.narrow.author' }
]

/**
 * Workhub 1's narrowing bar: status, target branch, repository and author as multi-select menus
 * with a count per option, the ticket and order pickers, "N of M" and Clear.
 */
export function NarrowingBar({ items, shown, value, onChange }: { items: PullRequestItem[]; shown: number; value: PrNarrowing; onChange: (n: PrNarrowing) => void }) {
  const { t } = useI18n()
  const tickets = ticketCounts(items)
  const optionLabel = (field: NarrowField, v: string) => (field === 'statuses' ? t(STATUS_META[v as PullRequestStatus]?.label ?? 'pr.narrow.status') : v)
  return (
    <div role="group" aria-label={t('pr.narrow.bar')} className="flex flex-wrap items-center gap-1.5">
      {FIELDS.map(({ field, title }) => {
        const options = narrowOptions(items, field)
        const selected = value[field]
        const label = selected.length === 0 ? t(title) : selected.length === 1 ? optionLabel(field, selected[0]!) : t('pr.narrow.selected', { title: t(title), count: selected.length })
        return (
          <DropdownMenu.Root key={field}>
            <DropdownMenu.Trigger className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" disabled={options.length === 0}>
              <FilterChip label={label} active={selected.length > 0} />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="start" sideOffset={4} className={FILTER_MENU}>
                {options.map((o) => (
                  <DropdownMenu.CheckboxItem
                    key={o.value}
                    className={FILTER_ITEM}
                    checked={selected.includes(o.value)}
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={() => onChange(toggleValue(value, field, o.value))}
                  >
                    <span className="flex w-4 justify-center">
                      <DropdownMenu.ItemIndicator>
                        <Check className="size-3.5" aria-hidden />
                      </DropdownMenu.ItemIndicator>
                    </span>
                    <span className="min-w-0 flex-1 truncate">{optionLabel(field, o.value)}</span>
                    <span className="text-xs text-subtle tabular-nums">{o.count}</span>
                  </DropdownMenu.CheckboxItem>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )
      })}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          <FilterChip label={value.ticket === 'any' ? t('pr.narrow.ticket') : t(`pr.narrow.ticket.${value.ticket}`)} active={value.ticket !== 'any'} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={4} className={FILTER_MENU}>
            <DropdownMenu.RadioGroup value={value.ticket} onValueChange={(v) => onChange({ ...value, ticket: v as PrNarrowing['ticket'] })}>
              {TICKET_FILTERS.map((f) => (
                <DropdownMenu.RadioItem key={f} value={f} className={FILTER_ITEM}>
                  <span className="flex w-4 justify-center">
                    <DropdownMenu.ItemIndicator>
                      <Check className="size-3.5" aria-hidden />
                    </DropdownMenu.ItemIndicator>
                  </span>
                  <span className="flex-1">{t(`pr.narrow.ticket.${f}`)}</span>
                  <span className="text-xs text-subtle tabular-nums">{tickets[f]}</span>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          title={t('pr.narrow.order')}
          aria-label={`${t('pr.narrow.order')}: ${t(`pr.narrow.order.${value.order}`)}`}
          className="inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-xs text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <ArrowUpDown className="size-3" aria-hidden />
          {t(`pr.narrow.order.${value.order}`)}
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={4} className={FILTER_MENU}>
            <DropdownMenu.RadioGroup value={value.order} onValueChange={(v) => onChange({ ...value, order: v as PrNarrowing['order'] })}>
              {PR_ORDERS.map((o) => (
                <DropdownMenu.RadioItem key={o} value={o} className={FILTER_ITEM}>
                  <span className="flex w-4 justify-center">
                    <DropdownMenu.ItemIndicator>
                      <Check className="size-3.5" aria-hidden />
                    </DropdownMenu.ItemIndicator>
                  </span>
                  {t(`pr.narrow.order.${o}`)}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {shown !== items.length && <span className="text-xs text-subtle tabular-nums">{t('pr.narrow.shown', { shown, total: items.length })}</span>}
      {isNarrowed(value) && (
        <button type="button" className="text-xs text-accent hover:underline" onClick={() => onChange(clearNarrowing(value))}>
          {t('pr.narrow.clear')}
        </button>
      )}
    </div>
  )
}
