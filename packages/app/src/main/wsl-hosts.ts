// The hosts of the WSL distributions profiles name (`profile.host`): one `workhub host` per
// distribution, started through `wsl.exe` on Windows the first time a profile names it, and
// registered as `wsl:<distro>`. Until it connects, or when it cannot (no WSL, the host not
// installed in the distribution yet), the sessions of those profiles run on this computer.
import { hostIdOf, probeWslDistro, wslHostLaunch, wslHostPayload, type HostLaunch, type ProfileHost, type WslRun } from '@workhub/core'
import type { Logger } from './log-file'
import type { SessionHost } from './hosts'
import type { HostProcessOptions } from './host-process'

/** The parts of a HostProcess this uses (faked in tests). */
export interface WslHostProcess {
  connect(): Promise<SessionHost>
  stop(): void
}

export interface WslHostsDeps {
  platform: NodeJS.Platform
  /** The host build this app expects inside the distribution. */
  hostVersion: string
  run: WslRun
  register(host: SessionHost): void
  log: Pick<Logger, 'info' | 'warn' | 'error'>
  /** A HostProcess with these options. */
  createProcess(options: Pick<HostProcessOptions, 'id' | 'launch' | 'hostVersion' | 'onRestart'>): WslHostProcess
}

/** The distributions these hosts name, once each, in order. */
export function wslDistrosOf(hosts: Iterable<ProfileHost | undefined>): string[] {
  const out: string[] = []
  for (const h of hosts) if (h?.kind === 'wsl' && !out.includes(h.distro)) out.push(h.distro)
  return out
}

export class WslHosts {
  /** Distributions already asked for (started, starting or failed): each is tried once per run of the app. */
  private readonly asked = new Set<string>()
  private readonly processes: WslHostProcess[] = []
  private warnedPlatform = false
  private stopped = false

  constructor(private readonly deps: WslHostsDeps) {}

  /** Starts the host of every distribution these profile hosts name that has none yet. */
  ensure(hosts: Iterable<ProfileHost | undefined>): void {
    const distros = wslDistrosOf(hosts).filter((d) => !this.asked.has(d))
    if (distros.length === 0 || this.stopped) return
    if (this.deps.platform !== 'win32') {
      if (!this.warnedPlatform) this.deps.log.warn(`host: WSL hosts run only on Windows; the profiles of ${distros.join(', ')} run on this computer`)
      this.warnedPlatform = true
      return
    }
    for (const distro of distros) {
      this.asked.add(distro)
      void this.start(distro)
    }
  }

  /** Ends every host process (the app quits). */
  stop(): void {
    this.stopped = true
    for (const p of this.processes.splice(0)) p.stop()
  }

  private async start(distro: string): Promise<void> {
    const id = hostIdOf({ kind: 'wsl', distro })
    const fallback = 'its profiles run on this computer'
    let launch: HostLaunch
    let dir: string
    try {
      const { home } = await probeWslDistro(this.deps.run, distro)
      const payload = wslHostPayload(home, this.deps.hostVersion)
      dir = payload.dir
      launch = wslHostLaunch({ distro, nodePath: payload.nodePath, entry: payload.entry, hostVersion: this.deps.hostVersion })
    } catch (err) {
      this.deps.log.error(`host ${id}: ${message(err)}; ${fallback}`)
      return
    }
    if (this.stopped) return
    const hostProcess = this.deps.createProcess({ id, hostVersion: this.deps.hostVersion, launch: () => launch, onRestart: (host) => this.deps.register(host) })
    this.processes.push(hostProcess)
    try {
      const host = await hostProcess.connect()
      if (this.stopped) return
      this.deps.register(host)
      this.deps.log.info(`host ${id}: connected; its profiles' sessions run in ${distro}`)
    } catch (err) {
      this.deps.log.error(`host ${id}: not available (the host is expected at ${dir}): ${message(err)}; ${fallback}`)
    }
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
