import { describe, expect, it } from 'vitest'
import { JobReports } from '../src/main/job-reporter'

function setup() {
  const lines: string[] = []
  const log = { debug() {}, info: (m: string) => lines.push(`info ${m}`), warn: (m: string) => lines.push(`warn ${m}`), error: (m: string) => lines.push(`error ${m}`) }
  let t = 1_000_000
  const reports = new JobReports(() => t)
  reports.attach(log)
  return { reports, lines, tick: (ms: number) => (t += ms) }
}

describe('JobReporter', () => {
  it('logs the first failure of a streak only, then the recovery with its length and count', () => {
    const { reports, lines, tick } = setup()
    const job = reports.job('tickets')
    job.ok()
    tick(1000)
    job.failed(new Error('503 from tracker'))
    tick(60_000)
    job.failed(new Error('503 from tracker'))
    job.failed(new Error('timeout'))
    expect(lines).toEqual(['warn job tickets failed: Error: 503 from tracker'])
    tick(30_000)
    job.ok()
    expect(lines).toEqual(['warn job tickets failed: Error: 503 from tracker', 'info job tickets recovered after 1m 30s, 3 failed runs'])
    job.ok()
    expect(lines).toHaveLength(2)
    job.failed('again')
    expect(lines).toHaveLength(3)
  })

  it('keeps lastRunAt, lastOkAt and lastError, redacted and cut to 300 characters', () => {
    const { reports, tick } = setup()
    const job = reports.job('health')
    job.ok()
    const okAt = reports.table()[0]!.lastOkAt
    tick(5000)
    job.failed(new Error(`bad token sk-ant-api03-abcdefghijklmnop ${'x'.repeat(400)}`))
    const s = reports.table()[0]!
    expect(s.lastOkAt).toBe(okAt)
    expect(s.lastRunAt).toBe(okAt! + 5000)
    expect(s.failures).toBe(1)
    expect(s.lastError).not.toContain('sk-ant')
    expect(s.lastError!.length).toBeLessThanOrEqual(301)
    job.ok()
    expect(reports.table()[0]!.lastError).toBeNull()
  })

  it('lists jobs by name and shares one reporter per name', () => {
    const { reports } = setup()
    reports.job('b').ok()
    reports.job('a').ok()
    expect(reports.job('a')).toBe(reports.job('a'))
    expect(reports.table().map((j) => j.name)).toEqual(['a', 'b'])
  })
})
