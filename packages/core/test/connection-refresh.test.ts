import { describe, expect, it } from 'vitest'
import { connectionRefreshMinutes, profileRefreshMs, type Connection } from '../src'

const conn = (id: string, kind: Connection['kind'], minutes?: string): Connection => ({ id, kind, provider: 'github', settings: minutes === undefined ? {} : { refreshMinutes: minutes } })

describe('connection refresh interval', () => {
  it('reads the minutes a connection sets, clamped to 1–60, and the kind default otherwise', () => {
    expect(connectionRefreshMinutes(conn('a', 'codeHost', '2'), 'codeHost')).toBe(2)
    expect(connectionRefreshMinutes(conn('a', 'codeHost', '500'), 'codeHost')).toBe(60)
    expect(connectionRefreshMinutes(conn('a', 'codeHost', '0.4'), 'codeHost')).toBe(1)
    expect(connectionRefreshMinutes(conn('a', 'codeHost', 'soon'), 'codeHost')).toBe(3)
    expect(connectionRefreshMinutes(conn('a', 'codeHost'), 'codeHost')).toBe(3)
    expect(connectionRefreshMinutes(undefined, 'tracker')).toBe(5)
  })

  it("follows the connection a profile picks for the kind", () => {
    const config = {
      connections: [conn('gh', 'codeHost', '10'), conn('jira', 'tracker', '1')],
      profiles: [
        { id: 'work', connections: { codeHost: 'gh', tracker: 'jira' } },
        { id: 'bare', connections: {} }
      ]
    }
    expect(profileRefreshMs(config, 'work', 'codeHost')).toBe(10 * 60_000)
    expect(profileRefreshMs(config, 'work', 'tracker')).toBe(60_000)
    expect(profileRefreshMs(config, 'bare', 'tracker')).toBe(5 * 60_000)
    expect(profileRefreshMs(config, null, 'codeHost')).toBe(3 * 60_000)
  })
})
