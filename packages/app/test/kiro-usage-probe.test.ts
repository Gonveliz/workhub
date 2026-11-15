import { describe, expect, it } from 'vitest'
import { kiroUsageProbeEnabled } from '../src/main/kiro-usage-probe'

describe('kiroUsageProbeEnabled', () => {
  it('always reads Kiro plan usage in a packaged app', () => {
    expect(kiroUsageProbeEnabled(true, {})).toBe(true)
    expect(kiroUsageProbeEnabled(true, { WORKHUB_KIRO_USAGE: '0' })).toBe(true)
  })

  it('leaves it off in development and tests unless WORKHUB_KIRO_USAGE=1', () => {
    expect(kiroUsageProbeEnabled(false, {})).toBe(false)
    expect(kiroUsageProbeEnabled(false, { WORKHUB_KIRO_USAGE: 'true' })).toBe(false)
    expect(kiroUsageProbeEnabled(false, { WORKHUB_KIRO_USAGE: '1' })).toBe(true)
  })
})
