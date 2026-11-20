import { describe, expect, it, vi } from 'vitest'
import { wslHostPayload, type HostLaunch, type WslRun } from '@workhub/core'
import type { SessionHost } from '../src/main/hosts'
import { WSL_HELLO_TIMEOUT_MS, WslHosts, wslDistrosOf, type WslHostInstall, type WslHostsDeps } from '../src/main/wsl-hosts'

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r))
}

function setup(over: Partial<WslHostsDeps> & { failConnect?: string[]; homes?: Record<string, string>; machine?: string } = {}) {
  const homes = over.homes ?? { Ubuntu: '/users/ana', Debian: '/users/ana' }
  const run: WslRun = vi.fn(async (args: string[]) => {
    const home = homes[args[1]!]
    return home ? { code: 0, stdout: `${over.machine ?? 'x86_64'}\n${home}` } : { code: 1, stdout: '', stderr: 'There is no distribution with the supplied name.' }
  })
  const install = vi.fn<WslHostInstall>(async ({ home }) => wslHostPayload(home, '2.1.0'))
  const created: { id?: string; launch: HostLaunch; stopped: boolean; helloTimeoutMs?: number }[] = []
  const registered: SessionHost[] = []
  const log = { info: vi.fn<(m: string) => void>(), warn: vi.fn<(m: string) => void>(), error: vi.fn<(m: string) => void>() }
  const hosts = new WslHosts({
    platform: 'win32',
    hostVersion: '2.1.0',
    run,
    install,
    register: (h) => registered.push(h),
    log,
    createProcess: (options) => {
      const entry = { id: options.id, launch: options.launch!(), stopped: false, helloTimeoutMs: options.helloTimeoutMs }
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
  return { hosts, run, install, created, registered, log }
}

describe('WslHosts', () => {
  it('names each distribution once, in order', () => {
    expect(wslDistrosOf([{ kind: 'local' }, undefined, { kind: 'wsl', distro: 'Ubuntu' }, { kind: 'wsl', distro: 'Debian' }, { kind: 'wsl', distro: 'Ubuntu' }])).toEqual(['Ubuntu', 'Debian'])
  })

  it('installs the host, starts one per distribution through wsl.exe with the Linux flags, and registers it', async () => {
    const { hosts, created, registered, log, install } = setup()
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }, { kind: 'local' }])
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }])
    await flush()
    expect(created).toEqual([
      {
        id: 'wsl:Ubuntu',
        stopped: false,
        helloTimeoutMs: WSL_HELLO_TIMEOUT_MS,
        launch: {
          command: 'wsl.exe',
          args: [
            '-d',
            'Ubuntu',
            '--cd',
            '~',
            '-e',
            '/users/ana/.workhub/host/2.1.0/node/bin/node',
            '/users/ana/.workhub/host/2.1.0/host.js',
            '--stdio',
            '--host-version',
            '2.1.0',
            '--fallback-path',
            '/users/ana/.workhub/host/2.1.0/bridge/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64',
            '--extra-path',
            '/users/ana/.workhub/host/2.1.0/bridge/node_modules/.bin',
            '--extra-path',
            '/users/ana/.workhub/host/2.1.0/node/bin'
          ],
          env: { WSLENV: '' }
        }
      }
    ])
    expect(install).toHaveBeenCalledWith({ distro: 'Ubuntu', home: '/users/ana', arch: 'x64' })
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

  it('starts nothing when the install fails, and says why', async () => {
    const install = vi.fn<WslHostInstall>(async () => {
      throw new Error('could not unpack the host into Ubuntu (exit 2: tar: Unexpected EOF)')
    })
    const { hosts, created, registered, log } = setup({ install })
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }])
    await flush()
    expect(created).toEqual([])
    expect(registered).toEqual([])
    expect(log.error).toHaveBeenCalledWith('host wsl:Ubuntu: could not unpack the host into Ubuntu (exit 2: tar: Unexpected EOF); its profiles run on this computer')
  })

  it('installs nothing in a distribution whose processor has no host build', async () => {
    const { hosts, created, install, log } = setup({ machine: 'riscv64' })
    hosts.ensure([{ kind: 'wsl', distro: 'Ubuntu' }])
    await flush()
    expect(install).not.toHaveBeenCalled()
    expect(created).toEqual([])
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('no host is built for its processor (riscv64)'))
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
