import { describe, expect, it, vi } from 'vitest'
import type { HostLaunch, WslRun } from '@workhub/core'
import type { SessionHost } from '../src/main/hosts'
import { WslHosts, wslDistrosOf, type WslHostsDeps } from '../src/main/wsl-hosts'

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r))
}

function setup(over: Partial<WslHostsDeps> & { failConnect?: string[]; homes?: Record<string, string> } = {}) {
  const homes = over.homes ?? { Ubuntu: '/users/ana', Debian: '/users/ana' }
  const run: WslRun = vi.fn(async (args: string[]) => {
    const home = homes[args[1]!]
    return home ? { code: 0, stdout: `x86_64\n${home}` } : { code: 1, stdout: '', stderr: 'There is no distribution with the supplied name.' }
  })
  const created: { id?: string; launch: HostLaunch; stopped: boolean }[] = []
  const registered: SessionHost[] = []
  const log = { info: vi.fn<(m: string) => void>(), warn: vi.fn<(m: string) => void>(), error: vi.fn<(m: string) => void>() }
  const hosts = new WslHosts({
    platform: 'win32',
    hostVersion: '2.1.0',
    run,
    register: (h) => registered.push(h),
    log,
    createProcess: (options) => {
      const entry = { id: options.id, launch: options.launch!(), stopped: false }
      created.push(entry)
      return {
        connect: async () => {
          if (over.failConnect?.includes(options.id!)) throw new Error('the host process exited (1)')
          return { id: options.id! } as SessionHost
        },
        stop: () => {
          entry.stopped = true
        }
      }
    },
    ...over
  })
  return { hosts, run, created, registered, log }
}

describe('WslHosts', () => {
  it('names each distribution once, in order', () => {
    expect(wslDistrosOf([{ kind: 'local' }, undefined, { kind: 'wsl', distro: 'Ubuntu' }, { kind: 'wsl', distro: 'Debian' }, { kind: 'wsl', distro: 'Ubuntu' }])).toEqual(['Ubuntu', 'Debian'])
  })

  it('starts one host per distribution through wsl.exe, at the payload in its home, and registers it', async () => {
    const { hosts, created, registered, log } = setup()
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }, { kind: 'local' }])
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }])
    await flush()
    expect(created).toEqual([
      {
        id: 'wsl:Ubuntu',
        stopped: false,
        launch: {
          command: 'wsl.exe',
          args: ['-d', 'Ubuntu', '--cd', '~', '-e', '/users/ana/.workhub/host/2.1.0/node/bin/node', '/users/ana/.workhub/host/2.1.0/host.js', '--stdio', '--host-version', '2.1.0'],
          env: { WSLENV: '' }
        }
      }
    ])
    expect(registered.map((h) => h.id)).toEqual(['wsl:Ubuntu'])
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('host wsl:Ubuntu: connected'))

    hosts.ensure([{ kind: 'wsl', distro: 'Debian' }])
    await flush()
    expect(registered.map((h) => h.id)).toEqual(['wsl:Ubuntu', 'wsl:Debian'])
    hosts.stop()
    expect(created.map((c) => c.stopped)).toEqual([true, true])
  })

  it('logs where the host was expected when it cannot connect, and leaves the profiles on this computer', async () => {
    const { hosts, registered, log } = setup({ failConnect: ['wsl:Ubuntu'] })
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }])
    await flush()
    expect(registered).toEqual([])
    expect(log.error).toHaveBeenCalledWith('host wsl:Ubuntu: not available (the host is expected at /users/ana/.workhub/host/2.1.0): the host process exited (1); its profiles run on this computer')
  })

  it('starts nothing for a distribution that cannot be read, and tries it once', async () => {
    const { hosts, created, run, log } = setup({ homes: {} })
    hosts.ensure([{ kind: 'wsl', distro: 'Gone' }])
    hosts.ensure([{ kind: 'wsl', distro: 'Gone' }])
    await flush()
    expect(created).toEqual([])
    expect(run).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/^host wsl:Gone: could not read WSL distribution Gone: exit 1: There is no distribution .*; its profiles run on this computer$/))
  })

  it('starts nothing off Windows, and says so once', async () => {
    const { hosts, created, run, log } = setup({ platform: 'linux' })
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }])
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }])
    await flush()
    expect(created).toEqual([])
    expect(run).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledTimes(1)
  })
})
