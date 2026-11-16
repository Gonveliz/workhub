import { describe, expect, it } from 'vitest'
import { StallWatch, type StallInput } from '../src/main/stall-watch'

const MIN = 60_000
const working = (id = 's1'): StallInput => ({ id, working: true, waitingOnUser: false })

describe('the stuck-session watchdog', () => {
  it('flags a working session after the silence limit, not before', () => {
    const w = new StallWatch()
    w.note('s1', 0)
    expect(w.check([working()], 9 * MIN, 10 * MIN).flag).toEqual([])
    expect(w.check([working()], 10 * MIN, 10 * MIN).flag).toEqual([{ id: 's1', since: 0 }])
  })

  it('flags once: not again until an event or Keep waiting', () => {
    const w = new StallWatch()
    w.note('s1', 0)
    expect(w.check([working()], 10 * MIN, 10 * MIN).flag).toHaveLength(1)
    expect(w.check([working()], 20 * MIN, 10 * MIN).flag).toHaveLength(0)
  })

  it('an event from the agent starts the silence over', () => {
    const w = new StallWatch()
    w.note('s1', 0)
    w.note('s1', 8 * MIN)
    expect(w.check([working()], 12 * MIN, 10 * MIN).flag).toEqual([])
    expect(w.check([working()], 18 * MIN, 10 * MIN).flag).toEqual([{ id: 's1', since: 8 * MIN }])
  })

  it('Keep waiting asks again only after another full interval', () => {
    const w = new StallWatch()
    w.note('s1', 0)
    expect(w.check([working()], 10 * MIN, 10 * MIN).flag).toHaveLength(1)
    w.keepWaiting('s1', 11 * MIN)
    expect(w.check([working()], 20 * MIN, 10 * MIN).flag).toEqual([])
    expect(w.check([working()], 21 * MIN, 10 * MIN).flag).toEqual([{ id: 's1', since: 11 * MIN }])
  })

  it('does not count time spent idle, or waiting on the user', () => {
    const w = new StallWatch()
    w.note('s1', 0)
    // Idle for an hour, then a turn starts: the silence counts from the first check that saw it work.
    expect(w.check([{ id: 's1', working: false, waitingOnUser: false }], 60 * MIN, 10 * MIN).flag).toEqual([])
    expect(w.check([working()], 65 * MIN, 10 * MIN).flag).toEqual([])
    // A permission request open for half an hour is not the agent going quiet.
    expect(w.check([{ id: 's1', working: true, waitingOnUser: true }], 95 * MIN, 10 * MIN).flag).toEqual([])
    expect(w.check([working()], 100 * MIN, 10 * MIN).flag).toEqual([])
    expect(w.check([working()], 105 * MIN, 10 * MIN).flag).toEqual([{ id: 's1', since: 95 * MIN }])
  })

  it('a threshold of zero turns it off', () => {
    const w = new StallWatch()
    w.note('s1', 0)
    expect(w.check([working()], 999 * MIN, 0).flag).toEqual([])
  })

  it('watches a session first seen at a check from that moment', () => {
    const w = new StallWatch()
    expect(w.check([working()], 50 * MIN, 10 * MIN).flag).toEqual([])
    expect(w.check([working()], 60 * MIN, 10 * MIN).flag).toHaveLength(1)
  })

  it('forgets sessions that are gone and handles several at once', () => {
    const w = new StallWatch()
    w.note('a', 0)
    w.note('b', 5 * MIN)
    expect(w.check([working('a'), working('b')], 10 * MIN, 10 * MIN).flag).toEqual([{ id: 'a', since: 0 }])
    expect(w.check([working('b')], 15 * MIN, 10 * MIN).flag).toEqual([{ id: 'b', since: 5 * MIN }])
    w.check([], 16 * MIN, 10 * MIN)
    // `a` returns as a new session: counted from its next check.
    expect(w.check([working('a')], 30 * MIN, 10 * MIN).flag).toEqual([])
  })

  it('a clock that went back is no silence', () => {
    const w = new StallWatch()
    w.note('s1', 100 * MIN)
    expect(w.check([working()], 50 * MIN, 10 * MIN).flag).toEqual([])
    expect(w.check([working()], 59 * MIN, 10 * MIN).flag).toEqual([])
    expect(w.check([working()], 60 * MIN, 10 * MIN).flag).toHaveLength(1)
  })
})
