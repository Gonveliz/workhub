import type { TicketFilter } from '@workhub/core'

/** Which tickets the Tickets screen lists: mine, or the team's backlog. */
export type TicketScope = 'mine' | 'backlog'
export const TICKET_SCOPES: readonly TicketScope[] = ['mine', 'backlog']

/** The Tickets screen's view of one profile: the scope and each scope's own filters. */
export interface TicketsView {
  scope: TicketScope
  filters: Record<TicketScope, TicketFilter>
}

export const DEFAULT_TICKETS_VIEW: TicketsView = { scope: 'mine', filters: { mine: {}, backlog: {} } }

const FILTER_KEYS = ['text', 'project', 'assignee', 'status'] as const
const MAX_VALUE = 500

/** Kept per profile in the renderer's localStorage, so the view survives a restart. */
export const ticketsViewKey = (profileId: string): string => `workhub.ticketsView.${profileId}`

function parseFilter(value: unknown): TicketFilter {
  const out: TicketFilter = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const key of FILTER_KEYS) {
    const v = (value as Record<string, unknown>)[key]
    if (typeof v === 'string' && v !== '') out[key] = v.slice(0, MAX_VALUE)
  }
  return out
}

/** A stored view, or the default when it is missing or not one. */
export function parseTicketsView(raw: string | null): TicketsView {
  if (!raw) return DEFAULT_TICKETS_VIEW
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    if (!v || typeof v !== 'object' || Array.isArray(v)) return DEFAULT_TICKETS_VIEW
    const filters = (v['filters'] ?? {}) as Record<string, unknown>
    return {
      scope: TICKET_SCOPES.includes(v['scope'] as TicketScope) ? (v['scope'] as TicketScope) : 'mine',
      filters: { mine: parseFilter(filters['mine']), backlog: parseFilter(filters['backlog']) }
    }
  } catch {
    return DEFAULT_TICKETS_VIEW
  }
}

export function loadTicketsView(profileId: string): TicketsView {
  return typeof localStorage === 'undefined' ? DEFAULT_TICKETS_VIEW : parseTicketsView(localStorage.getItem(ticketsViewKey(profileId)))
}

export function saveTicketsView(profileId: string, view: TicketsView): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(ticketsViewKey(profileId), JSON.stringify(view))
}

/** Whether a filter narrows anything. */
export const isFiltered = (f: TicketFilter): boolean => Boolean(f.text?.trim() || f.project || f.assignee || f.status)
