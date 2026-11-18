import { describe, expect, it } from 'vitest'
import { DEFAULT_TICKETS_VIEW, isFiltered, parseTicketsView, ticketsViewKey } from '../src/renderer/lib/ticketsView'

describe('tickets view', () => {
  it('reads a stored view: the scope and each scope its own filters', () => {
    const raw = JSON.stringify({ scope: 'backlog', filters: { mine: { status: 'To Do' }, backlog: { text: 'login', project: 'ABC', assignee: ':unassigned' } } })
    expect(parseTicketsView(raw)).toEqual({ scope: 'backlog', filters: { mine: { status: 'To Do' }, backlog: { text: 'login', project: 'ABC', assignee: ':unassigned' } } })
  })

  it('falls back to the default for missing or broken data, and drops unknown or empty fields', () => {
    expect(parseTicketsView(null)).toEqual(DEFAULT_TICKETS_VIEW)
    expect(parseTicketsView('{not json')).toEqual(DEFAULT_TICKETS_VIEW)
    expect(parseTicketsView('[1]')).toEqual(DEFAULT_TICKETS_VIEW)
    expect(parseTicketsView(JSON.stringify({ scope: 'everyone', filters: { mine: { project: '', status: 3, other: 'x' } } }))).toEqual(DEFAULT_TICKETS_VIEW)
  })

  it('keys the view by profile and knows when a filter narrows', () => {
    expect(ticketsViewKey('work')).toBe('workhub.ticketsView.work')
    expect(isFiltered({})).toBe(false)
    expect(isFiltered({ text: '  ' })).toBe(false)
    expect(isFiltered({ status: 'Done' })).toBe(true)
  })
})
