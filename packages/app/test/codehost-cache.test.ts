import { describe, expect, it, vi } from 'vitest'
import { emptyConfig, type WorkhubConfig } from '@workhub/core'
import { CodeHostService } from '../src/main/codehost'

function demoService(onListsChanged?: () => void) {
  const service = new CodeHostService(async () => emptyConfig() as WorkhubConfig, { demo: true, onListsChanged })
  const host = (service as unknown as { demoHost: { status: () => Promise<unknown> } }).demoHost
  const status = vi.spyOn(host, 'status')
  return { service, status }
}

describe('code host lists', () => {
  it('shares one read among concurrent callers', async () => {
    const { service, status } = demoService()
    const [a, b] = await Promise.all([service.lists(null), service.lists(null, true)])
    expect(status).toHaveBeenCalledTimes(1)
    expect(b).toBe(a)
  })

  it('hands out the cached lists without reading the host, and null when there are none', async () => {
    const changed = vi.fn()
    const { service, status } = demoService(changed)
    expect(await service.cachedLists(null)).toBeNull()
    expect(status).not.toHaveBeenCalled()
    const read = await service.lists(null)
    expect(changed).toHaveBeenCalledTimes(1)
    status.mockClear()
    expect(await service.cachedLists(null)).toBe(read)
    expect(status).not.toHaveBeenCalled()
  })

  it('tells the tray only when a read changed the lists', async () => {
    const changed = vi.fn()
    const { service } = demoService(changed)
    await service.lists(null)
    await service.lists(null, true)
    expect(changed).toHaveBeenCalledTimes(1)
  })
})
