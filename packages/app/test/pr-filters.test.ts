import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Popover } from 'radix-ui'
import type { PullRequestItem } from '@workhub/core'
import { TooltipProvider } from '../src/renderer/components/atoms'
import { ActiveFilterChips, FilterOption, FiltersPopover } from '../src/renderer/components/molecules/FiltersPopover'
import { narrowingCount, NO_NARROWING, panelOptions, toggleTicket, toggleValue } from '../src/renderer/lib/prNarrowing'
import { NarrowingBar, PrActiveFilters, PrFilterPanel } from '../src/renderer/screens/pullRequests/NarrowingBar'

const render = (el: ReactElement) => renderToStaticMarkup(createElement(TooltipProvider, null, el))

const item = (n: number, over: { repo?: string; base?: string; author?: string; status?: PullRequestItem['status']; tickets?: string[] } = {}): PullRequestItem =>
  ({
    pr: { url: `https://example.com/acme/${over.repo ?? 'web'}/pull/${n}`, repo: over.repo ?? 'web', number: n, base: over.base ?? 'main', author: over.author ?? 'ana', updatedAt: n },
    status: over.status ?? 'waitingReview',
    stale: false,
    ticketKeys: over.tickets ?? []
  }) as unknown as PullRequestItem

const items = [item(1, { repo: 'storefront', tickets: ['PAY-123'] }), item(2, { repo: 'billing', author: 'luis', base: 'develop' }), item(3, { repo: 'storefront', status: 'approved' })]

describe('PR filters helpers', () => {
  it('counts every value in use and the ticket choice', () => {
    expect(narrowingCount(NO_NARROWING)).toBe(0)
    const n = toggleValue(toggleValue({ ...NO_NARROWING, ticket: 'with' }, 'repos', 'storefront'), 'authors', 'luis')
    expect(narrowingCount(n)).toBe(3)
  })

  it('keeps the ticket filter single-choice: picking the choice in use goes back to any', () => {
    const withTicket = toggleTicket(NO_NARROWING, 'with')
    expect(withTicket.ticket).toBe('with')
    expect(toggleTicket(withTicket, 'without').ticket).toBe('without')
    expect(toggleTicket(withTicket, 'with').ticket).toBe('any')
  })

  it('lists a picked value the tab no longer has, so it can be turned off', () => {
    const n = toggleValue(NO_NARROWING, 'repos', 'gone')
    expect(panelOptions(items, n, 'repos').map((o) => o.value)).toEqual(['storefront', 'billing', 'gone'])
  })
})

describe('PR filters panel', () => {
  const panel = (value = NO_NARROWING, initialQuery = '', shown = 3) =>
    render(createElement(Popover.Root, { open: true }, createElement(PrFilterPanel, { items, shown, value, onChange: () => undefined, initialQuery })))

  it('folds the five filters into one Filters button beside the order, with no chips while none is in use', () => {
    const html = render(createElement(NarrowingBar, { items, shown: 3, value: NO_NARROWING, onChange: () => undefined }))
    expect(html).toContain('data-testid="pr-filters"')
    expect(html).toContain('<span>Filters</span>')
    expect(html).toContain('Newest update')
    expect(html).not.toContain('data-testid="pr-active-filters"')
    // The status, branch, repository, author and ticket menus are in the panel, not in the row.
    expect(html).not.toContain('Into')
  })

  it('shows the count on the button and the values in use as chips with Clear', () => {
    const value = { ...toggleValue(toggleValue(NO_NARROWING, 'repos', 'storefront'), 'statuses', 'approved'), ticket: 'with' as const }
    const bar = render(createElement(NarrowingBar, { items, shown: 1, value, onChange: () => undefined }))
    expect(bar).toContain('<span>Filters · 3</span>')
    expect(bar).toContain('data-active="true"')
    const chips = render(createElement(PrActiveFilters, { value, onChange: () => undefined }))
    expect(chips).toContain('Status: Approved')
    expect(chips).toContain('Repo: storefront')
    expect(chips).toContain('Ticket: With ticket')
    expect(chips).toContain('aria-label="Remove Repo: storefront"')
    expect(chips).toContain('>Clear<')
  })

  it('has one group per filter with toggling options, and how many PRs match', () => {
    const html = panel(toggleValue(NO_NARROWING, 'repos', 'storefront'), '', 2)
    for (const title of ['Status', 'Into', 'Repo', 'Author', 'Ticket']) expect(html).toContain(`aria-label="${title}"`)
    expect(html).toContain('placeholder="Filter by…"')
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(html).toContain('With ticket')
    expect(html).toContain('Without ticket')
    expect(html).toContain('2 of 3 pull requests')
  })

  it('narrows the options to those whose name or group matches what is typed', () => {
    const byOption = panel(NO_NARROWING, 'store')
    expect(byOption).toContain('storefront')
    expect(byOption).not.toContain('billing')
    expect(byOption).not.toContain('aria-label="Author"')
    const byGroup = panel(NO_NARROWING, 'auth')
    expect(byGroup).toContain('aria-label="Author"')
    expect(byGroup).toContain('luis')
    expect(panel(NO_NARROWING, 'zzz')).toContain('No filter matches “zzz”')
  })
})

describe('Filters popover molecule', () => {
  it('shows the count only when a filter is in use, with the accent border', () => {
    const off = render(createElement(FiltersPopover, { label: 'Filters', count: 0, children: null }))
    expect(off).toContain('<span>Filters</span>')
    expect(off).toContain('border-border')
    expect(off).toContain('aria-haspopup="dialog"')
    const on = render(createElement(FiltersPopover, { label: 'Filters', count: 2, children: null }))
    expect(on).toContain('<span>Filters · 2</span>')
    expect(on).toContain('border-accent')
  })

  it('renders nothing for no active filter, and one chip with its remove button for each', () => {
    expect(render(createElement(ActiveFilterChips, { filters: [], clearLabel: 'Clear', removeLabel: (l: string) => `Remove ${l}`, onClear: () => undefined }))).toBe('')
    const html = render(createElement(ActiveFilterChips, { filters: [{ key: 'a', label: 'Agent: Codex', onRemove: () => undefined }], clearLabel: 'Clear', removeLabel: (l: string) => `Remove ${l}`, onClear: () => undefined }))
    expect(html).toContain('aria-label="Remove Agent: Codex"')
    expect(html).toContain('data-testid="active-filters-clear"')
  })

  it('marks an option on with aria-pressed', () => {
    expect(render(createElement(FilterOption, { label: 'main', on: true, onToggle: () => undefined }))).toContain('aria-pressed="true"')
    expect(render(createElement(FilterOption, { label: 'main', on: false, onToggle: () => undefined }))).toContain('aria-pressed="false"')
  })
})
