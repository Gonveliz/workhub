import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { AgentEvent } from '@workhub/core'
import { SessionWindows } from '../src/main/session-windows'
import { routeSessionEvent, terminalSessionOf } from '../src/main/terminal-routing'

const out = (sessionId: string, data = 'x'): AgentEvent => ({ sessionId, type: 'output', data })

function recorder() {
  const got: string[] = []
  const targets = {
    everywhere: (e: AgentEvent) => got.push(`everywhere ${e.sessionId}`),
    main: (e: AgentEvent) => got.push(`main ${e.sessionId}`),
    sessionWindow: (id: string, e: AgentEvent) => got.push(`window(${id}) ${e.sessionId}`),
    devices: (e: AgentEvent) => got.push(`devices ${e.sessionId}`)
  }
  return { got, targets }
}

describe('terminal output routing', () => {
  it('finds the session of a terminal channel, and none for a session event', () => {
    expect(terminalSessionOf(out('s1:console'))).toBe('s1')
    expect(terminalSessionOf(out('s1:shell'))).toBe('s1')
    expect(terminalSessionOf({ sessionId: 's1', type: 'message', role: 'agent', text: 'hi' })).toBeNull()
  })

  it("sends a channel's output to the main window, the session's own window and devices only", () => {
    const { got, targets } = recorder()
    routeSessionEvent(out('s1:console'), targets)
    expect(got).toEqual(['main s1:console', 'window(s1) s1:console', 'devices s1:console'])
  })

  it("routes a channel's exit like its output, so it never overtakes it", () => {
    const { got, targets } = recorder()
    routeSessionEvent({ sessionId: 's1:shell', type: 'exit', code: 0 }, targets)
    expect(got).toEqual(['main s1:shell', 'window(s1) s1:shell', 'devices s1:shell'])
  })

  it('sends every other session event everywhere', () => {
    const { got, targets } = recorder()
    routeSessionEvent({ sessionId: 's1', type: 'message', role: 'agent', text: 'hi' }, targets)
    expect(got).toEqual(['everywhere s1'])
  })
})

class FakeWindow extends EventEmitter {
  readonly sent: unknown[][] = []
  readonly webContents = { send: (...args: unknown[]) => this.sent.push(args), isDestroyed: () => false }
  isDestroyed() {
    return false
  }
  getBounds() {
    return { x: 0, y: 0, width: 980, height: 760 }
  }
}

describe('SessionWindows.sendToSession', () => {
  it("reaches only that session's window, and nothing when the session has none", () => {
    const created = new Map<string, FakeWindow>()
    const windows = new SessionWindows({
      create: (hash) => {
        const w = new FakeWindow()
        created.set(hash, w)
        return w as unknown as BrowserWindow
      },
      mainWindow: () => null,
      showMain: () => undefined,
      exists: () => true
    })
    windows.open('s1')
    windows.open('s2')
    const [w1, w2] = [...created.values()]
    w1!.sent.length = 0
    w2!.sent.length = 0
    windows.sendToSession('s1', 'session:event', [out('s1:console', 'a')])
    windows.sendToSession('s3', 'session:event', [out('s3:console', 'b')])
    expect(w1!.sent).toEqual([['session:event', out('s1:console', 'a')]])
    expect(w2!.sent).toEqual([])
  })
})
