import { describe, expect, it } from 'vitest'
import type { AgentQuestion } from '@workhub/core'
import { answersSummary, EMPTY_PICK, questionAnswers, togglePick, typeOther } from '../src/renderer/lib/questions'
import { applyEvent, orphanToolTitle, reconcilePending, UNTITLED_TOOL, withdrawOpenRequests, type SessionData } from '../src/renderer/store'
import { localizeToolTitle } from '../src/renderer/lib/toolTitle'
import { translate, type MessageKey, type Params } from '../src/renderer/i18n/translate'
import { awaitingAnswer } from '../src/renderer/store'

const color: AgentQuestion = { question: 'Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }] }
const extras: AgentQuestion = { question: 'Extras?', header: 'Extras', options: [{ label: 'Cream' }, { label: 'Nuts' }], multiSelect: true }

describe('question answers', () => {
  it('keeps one option on a single-answer question and lets typed words replace it', () => {
    let pick = togglePick(EMPTY_PICK, 'Red', false)
    pick = togglePick(pick, 'Blue', false)
    expect(pick).toEqual({ labels: ['Blue'], other: '' })
    expect(typeOther(pick, 'Green', false)).toEqual({ labels: [], other: 'Green' })
    expect(togglePick({ labels: [], other: 'Green' }, 'Red', false)).toEqual({ labels: ['Red'], other: '' })
  })

  it('toggles options on a multi-select and adds the typed words, in the options\' order', () => {
    let pick = togglePick(EMPTY_PICK, 'Nuts', true)
    pick = togglePick(pick, 'Cream', true)
    pick = typeOther(pick, ' Sprinkles ', true)
    expect(questionAnswers([extras], [pick])).toEqual({ 'Extras?': 'Cream, Nuts, Sprinkles' })
    expect(togglePick(pick, 'Nuts', true).labels).toEqual(['Cream'])
  })

  it('sends nothing until every question has an answer, and sums them up in one line', () => {
    expect(questionAnswers([color, extras], [togglePick(EMPTY_PICK, 'Blue', false), EMPTY_PICK])).toBeNull()
    const answers = questionAnswers([color, extras], [togglePick(EMPTY_PICK, 'Blue', false), typeOther(EMPTY_PICK, 'None', true)])
    expect(answers).toEqual({ 'Which color?': 'Blue', 'Extras?': 'None' })
    expect(answersSummary([color, extras], answers!)).toBe('Color: Blue · Extras: None')
    expect(answersSummary([color], { 'Which color?': 'Red' })).toBe('Red')
  })
})

describe('open requests when the chat ends', () => {
  it('withdraws unanswered questions so the session stops waiting for an answer', () => {
    const empty = { view: {} as SessionData['view'], items: [], monitor: {} } as SessionData
    let n = 0
    const asked = applyEvent(empty, { sessionId: 's', type: 'permission', requestId: 'p1', title: 'Asked you a question', options: [], questions: [color] }, () => ++n)
    expect(awaitingAnswer(asked)).toBe(true)
    const after = withdrawOpenRequests(asked)
    expect(awaitingAnswer(after)).toBe(false)
    expect(after.items[0]).toMatchObject({ kind: 'permission', answer: '—' })
    expect(withdrawOpenRequests(after)).toBe(after)
  })
})

describe('a question answered after the window reloaded', () => {
  it('labels its tool row "Asked you a question", never with the raw tool-use id', () => {
    // After a reload the chat starts empty; the open question comes back from the session view.
    const empty = { view: {} as SessionData['view'], items: [], monitor: {}, awaiting: false } as SessionData
    const reloaded = reconcilePending(empty, [{ requestId: 'p1', title: 'Asked you a question', options: [], questions: [color], at: 1 }])
    const answered: SessionData = { ...reloaded, items: reloaded.items.map((i) => (i.kind === 'permission' ? { ...i, answer: 'Blue', answeredAt: 2 } : i)) }
    let n = 100
    // Only the untitled result reaches the chat: its start went out before the reload.
    const after = applyEvent(answered, { sessionId: 's', type: 'tool', toolCallId: 'toolu_01AbCdEf', status: 'completed' }, () => ++n)
    const row = after.items.at(-1)!
    expect(row).toMatchObject({ kind: 'tool', toolCallId: 'toolu_01AbCdEf', title: 'Asked you a question', status: 'completed' })
    const es = (k: MessageKey, p?: Params) => translate('es', k, p)
    expect(localizeToolTitle(row.kind === 'tool' ? row.title : '', es)).toBe('Te hizo una pregunta')
    // A later update with its own title still wins.
    const titled = applyEvent(after, { sessionId: 's', type: 'tool', toolCallId: 'toolu_01AbCdEf', title: 'Read a file' }, () => ++n)
    expect(titled.items.at(-1)).toMatchObject({ title: 'Read a file' })
  })

  it('gives any other orphan result a generic title', () => {
    expect(orphanToolTitle([])).toBe(UNTITLED_TOOL)
    expect(orphanToolTitle([{ id: 1, kind: 'permission', requestId: 'p', title: 'Run npm test?', options: [], answer: '—' }])).toBe(UNTITLED_TOOL)
    expect(orphanToolTitle([{ id: 1, kind: 'permission', requestId: 'p', title: 'Run npm test?', options: [], answer: 'Allow' }, { id: 2, kind: 'tool', toolCallId: 't', title: 'x', status: 'completed' }])).toBe(UNTITLED_TOOL)
    expect(localizeToolTitle(UNTITLED_TOOL, (k) => translate('es', k))).toBe('Usó una herramienta')
  })
})
