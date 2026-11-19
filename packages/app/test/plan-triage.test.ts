import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CalendarEvent, InboxItem } from '@workhub/core'
import { TooltipProvider } from '../src/renderer/components/atoms'
import { meetingDay, minutesUntil, withinWeek } from '../src/renderer/lib/plan'
import { inboxDecisionKey, INBOX_DECISION_KEYS, stepSelection, triageSelection } from '../src/renderer/lib/planner'
import { DecisionBar, TriageDetail, TriageRow } from '../src/renderer/screens/plan/InboxTriage'
import { MeetingRow, PersonHeader, TopicRow } from '../src/renderer/screens/plan/PeopleTab'

const noop = () => {}
const item = (patch: Partial<InboxItem> = {}): InboxItem => ({
  id: 'i1',
  kind: 'bug',
  title: 'Checkout errors jump',
  detail: 'Line one\nLine two\nLine three\nLine four, never cut',
  source: { type: 'alert', label: 'Checkout errors' },
  area: 'Payments',
  criticality: 'High',
  people: ['ana'],
  status: 'pending',
  createdAt: Date.now() - 2 * 3_600_000,
  ...patch
})
const people = [{ id: 'ana', name: 'Ana Lopez', emails: ['ana@example.com'] }]
const wrap = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(TooltipProvider, null, el))

describe('the inbox triage selection', () => {
  const ids = ['a', 'b', 'c']

  it('keeps the selected item while it is listed', () => {
    expect(triageSelection(ids, 'b', 1)).toBe('b')
  })

  it('shows the item that took the place of one decided, and the last one at the end of the list', () => {
    expect(triageSelection(['a', 'c'], 'b', 1)).toBe('c')
    expect(triageSelection(['a', 'b'], 'c', 2)).toBe('b')
    expect(triageSelection([], 'c', 2)).toBeNull()
    expect(triageSelection(ids, null, 0)).toBe('a')
  })

  it('moves up and down and stays at the ends', () => {
    expect(stepSelection(ids, 'a', 1)).toBe('b')
    expect(stepSelection(ids, 'c', 1)).toBe('c')
    expect(stepSelection(ids, 'a', -1)).toBe('a')
    expect(stepSelection(ids, 'gone', -1)).toBe('c')
    expect(stepSelection([], 'a', 1)).toBeNull()
  })

  it('takes create, local task and dismiss with 1, 2 and 3', () => {
    expect(INBOX_DECISION_KEYS).toEqual({ '1': 'approve', '2': 'keep', '3': 'discard' })
    expect(inboxDecisionKey('keep')).toBe('2')
    expect(inboxDecisionKey('done')).toBeUndefined()
  })
})

describe('the inbox triage panes', () => {
  it('lists a row with kind, due date, criticality, title and source with the people', () => {
    const html = wrap(createElement('ul', null, createElement(TriageRow, { item: item({ due: '2026-11-21' }), people, levels: [{ name: 'High', priority: 2 }], current: true, onPick: noop, checked: false, selecting: false, onCheck: noop })))
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('Checkout errors jump')
    expect(html).toContain('Checkout errors · Ana Lopez')
    expect(html).toContain('High')
    expect(html).toMatch(/due|vence/)
  })

  it('shows the whole body, the facts and "Pick a milestone" instead of a warning tag', () => {
    const html = wrap(createElement(TriageDetail, { item: item(), people, milestones: [], profileId: 'p', now: Date.now(), onOpenMilestone: noop, footer: null }))
    expect(html).toContain('Line four, never cut')
    expect(html).not.toContain('line-clamp')
    expect(html).toContain('Payments')
    expect(html).toContain('Ana Lopez')
    expect(html).toContain('Pick a milestone')
    expect(html).not.toContain('No milestone')
  })

  it('offers the decisions with their keys, one filled, and waits for a tracker to create a ticket', () => {
    const html = wrap(createElement(DecisionBar, { item: item(), canCreate: false, busy: false, onAction: noop }))
    expect(html).toContain('What is it?')
    expect(html.match(/aria-keyshortcuts="(\d)"/g)).toEqual(['aria-keyshortcuts="1"', 'aria-keyshortcuts="2"', 'aria-keyshortcuts="3"'])
    expect(html.match(/bg-accent text-accent-fg/g)).toHaveLength(1)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-keyshortcuts="1"/)
    // A decision is only recorded: no tracker needed.
    const decision = wrap(createElement(DecisionBar, { item: item({ kind: 'decision' }), canCreate: false, busy: false, onAction: noop }))
    expect(decision).toContain('Record')
    expect(decision).not.toMatch(/<button[^>]*disabled=""[^>]*aria-keyshortcuts="1"/)
  })
})

describe('meeting times on the People tab', () => {
  const now = new Date(2026, 10, 18, 20, 0).getTime()

  it('names today and tomorrow and leaves other days to the date', () => {
    expect(meetingDay(new Date(2026, 10, 18, 23, 0).getTime(), now)).toBe('today')
    expect(meetingDay(new Date(2026, 10, 19, 0, 5).getTime(), now)).toBe('tomorrow')
    expect(meetingDay(new Date(2026, 10, 21, 9, 0).getTime(), now)).toBeNull()
  })

  it('counts the minutes only for a meeting starting within the hour', () => {
    expect(minutesUntil({ start: now + 12 * 60_000, allDay: false }, now)).toBe(12)
    expect(minutesUntil({ start: now + 2 * 3_600_000, allDay: false }, now)).toBeNull()
    expect(minutesUntil({ start: now - 60_000, allDay: false }, now)).toBeNull()
  })

  it('keeps the meetings of the next seven days', () => {
    expect(withinWeek([{ start: now + 86_400_000 }, { start: now + 8 * 86_400_000 }], now)).toEqual([{ start: now + 86_400_000 }])
  })
})

describe('the People tab', () => {
  const now = Date.now()
  const event = (id: string, minutes: number, title: string): CalendarEvent => ({ id, uid: id, title, start: now + minutes * 60_000, end: now + (minutes + 30) * 60_000, allDay: false, attendees: [{ email: 'ana@example.com' }], calendarId: 'c', recurring: false })

  it('shows Join and Prepare 1:1 once, the second the filled one, and the rest behind the menu', () => {
    const html = wrap(createElement(PersonHeader, { person: people[0]!, facts: ['Next meeting today 21:05', '2 meetings together in 7 days'], joinUrl: 'https://meet.example.com/x', preparing: false, onJoin: noop, onOneOnOne: noop, onEdit: noop, onRemove: noop }))
    expect(html).toContain('>AL<')
    expect(html).toContain('Next meeting today 21:05 · 2 meetings together in 7 days')
    expect(html.match(/>Join</g)).toHaveLength(1)
    expect(html).toMatch(/bg-accent text-accent-fg[^>]*>.*Prepare 1:1/)
    expect(html).toContain('More for Ana Lopez')
    // No call link: no Join.
    expect(wrap(createElement(PersonHeader, { person: people[0]!, facts: [], preparing: false, onJoin: noop, onOneOnOne: noop, onEdit: noop, onRemove: noop }))).not.toContain('>Join<')
  })

  it('gives a meeting together only an icon for its brief, and "in N min" to the one about to start', () => {
    const later = wrap(createElement('ul', null, createElement(MeetingRow, { event: event('e2', 24 * 60, 'Roadmap check-in'), now, busy: false, onBrief: noop })))
    expect(later).toContain('aria-label="Prepare brief"')
    expect(later).not.toContain('>Prepare brief<')
    expect(later).not.toContain('Join')
    const soon = wrap(createElement('ul', null, createElement(MeetingRow, { event: event('e1', 12, '1:1 Ana / Alex'), now, busy: false, onBrief: noop })))
    expect(soon).toMatch(/in 1[12] min/)
  })

  it('ticks a topic done only when it can be: a pending item is decided on the Inbox first', () => {
    const row = (patch: Partial<InboxItem>) => wrap(createElement('ul', null, createElement(TopicRow, { item: item(patch), busy: false, onDone: noop, onOpen: noop })))
    expect(row({ status: 'local' })).toMatch(/<input[^>]*aria-label="Mark “Checkout errors jump” done"/)
    expect(row({ status: 'pending' })).toMatch(/<input[^>]*disabled=""[^>]*aria-label="Decide what it is on the Inbox tab first"/)
    expect(row({ status: 'pending' })).toContain('Checkout errors · High')
  })
})
