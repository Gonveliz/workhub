import { describe, expect, it } from 'vitest'
import { generateIdentity, PUSH_MAX_AGE_MS, verifyPermissionAnswer, type PushPayload } from '@workhub/protocol'
import { answerMessage, askOf, notificationActions, readAsk, tapOutcome, type NotificationAsk } from '../src/web/notification-answer'

const NOW = 1_800_000_000_000
const TEXT = { allow: 'Allow', deny: 'Deny' }
const ask: NotificationAsk = { desktop: 'a'.repeat(32), session: 's1', request: 'r1', ticket: 'T'.repeat(43), answers: ['deny'], ts: NOW }

describe('the buttons a pushed notification shows', () => {
  it('shows the answers the desktop offered where the platform draws buttons', () => {
    expect(notificationActions(ask, 2, TEXT)).toEqual([{ action: 'deny', title: 'Deny' }])
    expect(notificationActions({ ...ask, answers: ['deny', 'allow'] }, 2, TEXT).map((a) => a.action)).toEqual(['allow', 'deny'])
    expect(notificationActions({ ...ask, answers: ['deny', 'allow'] }, 1, TEXT).map((a) => a.action)).toEqual(['allow'])
  })

  it('shows none without an ask or where buttons are not drawn, so the notification behaves as before', () => {
    expect(notificationActions(undefined, 2, TEXT)).toEqual([])
    expect(notificationActions(ask, 0, TEXT)).toEqual([])
    expect(notificationActions(ask, undefined, TEXT)).toEqual([])
  })

  it('keeps what the payload carried and reads back only a well-formed ask', () => {
    const payload = { v: 1, kind: 'needsAnswer', title: 't', body: 'b', ts: NOW, desktop: ask.desktop, sig: 'S'.repeat(86), ask: { session: 's1', request: 'r1', ticket: ask.ticket, answers: ['deny'], sig: 'S'.repeat(86) } } as PushPayload
    expect(askOf(payload)).toEqual(ask)
    expect(askOf({ ...payload, ask: undefined })).toBeUndefined()
    expect(readAsk(JSON.parse(JSON.stringify(ask)))).toEqual(ask)
    expect(readAsk({ ...ask, answers: ['approve'] })).toBeUndefined()
    expect(readAsk({ ...ask, ts: 'now' })).toBeUndefined()
    expect(readAsk(null)).toBeUndefined()
  })
})

describe('what a tap does', () => {
  it('answers with a button the desktop offered while the notification is recent', () => {
    expect(tapOutcome('deny', ask, NOW + 60_000)).toEqual({ kind: 'answer', answer: 'deny', ask })
  })

  it('opens the session for the body, an answer not offered, no ask, or a stale notification', () => {
    expect(tapOutcome('', ask, NOW)).toEqual({ kind: 'open' })
    expect(tapOutcome('allow', ask, NOW)).toEqual({ kind: 'open' })
    expect(tapOutcome('deny', undefined, NOW)).toEqual({ kind: 'open' })
    expect(tapOutcome('deny', ask, NOW + PUSH_MAX_AGE_MS + 1)).toEqual({ kind: 'open' })
  })

  it('sends the exact request and ticket, signed with this device key', () => {
    const me = generateIdentity()
    const message = answerMessage(me, ask, 'deny', NOW)
    expect(message).toMatchObject({ t: 'permission-answer', desktop: ask.desktop, device: me.id, session: 's1', request: 'r1', ticket: ask.ticket, answer: 'deny', ts: NOW })
    expect(verifyPermissionAnswer(message, me.public, NOW)).toBe(true)
    expect(verifyPermissionAnswer({ ...message, request: 'r2' }, me.public, NOW)).toBe(false)
    expect(verifyPermissionAnswer(message, generateIdentity().public, NOW)).toBe(false)
  })
})
