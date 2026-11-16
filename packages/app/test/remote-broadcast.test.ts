import { describe, expect, it, vi } from 'vitest'
import { broadcastToWindowsAndDevices } from '../src/main/remote'

const win = (destroyed: boolean) => ({ isDestroyed: () => destroyed, webContents: { send: vi.fn() } })

describe('broadcastToWindowsAndDevices', () => {
  it('sends to every live window and taps the hub with the same arguments', () => {
    const live = win(false)
    const dead = win(true)
    const hub = { tap: vi.fn() }
    broadcastToWindowsAndDevices([live, dead], hub, 'planner:changed', 'profile-1')
    expect(live.webContents.send).toHaveBeenCalledWith('planner:changed', 'profile-1')
    expect(dead.webContents.send).not.toHaveBeenCalled()
    expect(hub.tap).toHaveBeenCalledWith('planner:changed', ['profile-1'])
  })

  it('taps the hub even with no window open', () => {
    const hub = { tap: vi.fn() }
    broadcastToWindowsAndDevices([], hub, 'config:changed')
    expect(hub.tap).toHaveBeenCalledWith('config:changed', [])
  })
})
