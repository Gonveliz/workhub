// The hosts sessions run on. Every session runs on this computer today (the `local` host); a
// profile that runs elsewhere (a WSL distribution, say) will get a host of its own, whose services
// reach it through a HostClient, and `hostFor` will pick it from the profile.
import type { ExecutionServices } from '@workhub/adapters/host'

export type HostId = 'local' | (string & {})

/** The host of this computer: the one every session runs on until profiles name another. */
export const LOCAL_HOST_ID = 'local'

/** What a host is picked by: the profile a session (or a folder) belongs to. */
export interface HostTarget {
  profileId: string | null
}

/** A place sessions run: its agent runtimes, transcript readers, past sessions and git. */
export interface SessionHost {
  id: HostId
  services: ExecutionServices
}

/** Picks the host of a session or folder. */
export type HostResolver = (target: HostTarget) => SessionHost

/** The host of this computer, over services built in this process. */
export function localHost(services: ExecutionServices): SessionHost {
  return { id: LOCAL_HOST_ID, services }
}

/** The known hosts, `local` always among them. */
export class HostRegistry {
  private readonly hosts = new Map<HostId, SessionHost>()

  constructor(readonly local: SessionHost) {
    if (local.id !== LOCAL_HOST_ID) throw new Error(`the local host must have the id "${LOCAL_HOST_ID}"`)
    this.hosts.set(local.id, local)
  }

  /** Adds a host, or replaces the one with the same id (a restarted host process). Never the local one. */
  register(host: SessionHost): void {
    if (host.id === LOCAL_HOST_ID) throw new Error('the local host cannot be replaced')
    this.hosts.set(host.id, host)
  }

  get(id: HostId): SessionHost | undefined {
    return this.hosts.get(id)
  }

  /** The host a session or folder of this profile runs on: this computer, until profiles can name another. */
  hostFor(_target: HostTarget): SessionHost {
    return this.local
  }
}
