import { describe, expect, it } from 'vitest'
import { DEFAULT_TICKETS_VIEW, chipLabel, isFiltered, parseTicketsView, ticketsViewKey, toggleValue } from '../src/renderer/lib/ticketsView'

describe('tickets view', () => {
  it('reads a stored view: the scope and each scope its own filters', () => {
    const raw = JSON.stringify({ scope: 'backlog', filters: { mine: { status: ['To Do', 'In Progress'] }, backlog: { text: 'login', project: ['ABC'], assignee: [':unassigned', 'Dana'] } } })
    expect(parseTicketsView(raw)).toEqual({ scope: 'backlog', filters: { mine: { status: ['To Do', 'In Progress'] }, backlog: { text: 'login', project: ['ABC'], assignee: [':unassigned', 'Dana'] } } })
  })

  it('reads a view saved with one value per filter as a list of one', () => {
    const raw = JSON.stringify({ scope: 'mine', filters: { mine: { status: 'To Do', project: 'ABC' }, backlog: {} } })
    expect(parseTicketsView(raw).filters.mine).toEqual({ status: ['To Do'], project: ['ABC'] })
  })

  it('drops empty, repeated and non-text values from a list', () => {
    const raw = JSON.stringify({ scope: 'mine', filters: { mine: { status: ['To Do', '', 3, 'To Do'], project: [] }, backlog: {} } })
    expect(parseTicketsView(raw).filters.mine).toEqual({ status: ['To Do'] })
  })

  it('ticks and unticks values, and names a chip by its first value and how many more', () => {
    expect(toggleValue(undefined, 'ABC')).toEqual(['ABC'])
    expect(toggleValue(['ABC'], 'WEB')).toEqual(['ABC', 'WEB'])
    expect(toggleValue(['ABC', 'WEB'], 'ABC')).toEqual(['WEB'])
    expect(toggleValue(['ABC'], 'ABC')).toBeUndefined()
    expect(chipLabel(['ABC'], (v) => v)).toBe('ABC')
    expect(chipLabel(['To Do', 'Done', 'Review'], (v) => v)).toBe('To Do +2')
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
    expect(isFiltered({ status: ['Done'] })).toBe(true)
    expect(isFiltered({ status: [] })).toBe(false)
  })
})
