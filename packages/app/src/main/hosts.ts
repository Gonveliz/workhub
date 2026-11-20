// The hosts sessions run on: this computer (the `local` host), and the hosts profiles name (a WSL
// distribution, `wsl:<distro>`), whose services reach them through a HostClient. `hostFor` picks
// one from the profile.
import { existsSync } from 'node:fs'
import type { GitRunner } from '@workhub/adapters/git-review'
import { statPath, type HostFileInfo } from '@workhub/adapters/host'
import { hostIdOf, type AgentRuntime, type ProfileHost, type SessionHistorySource, type TranscriptReader } from '@workhub/core'

export type { HostFileInfo }

export type HostId = 'local' | (string & {})

/** The host of this computer: the one every session runs on until profiles name another. */
export const LOCAL_HOST_ID = 'local'

/** What a host is picked by: the profile a session (or a folder) belongs to. */
export interface HostTarget {
  profileId: string | null
}

/** The folder operations the app runs on a session's or profile's folders, where those folders live. */
export interface HostFolders {
  /** Runs git in a folder of the host; never rejects (a failure is `ok: false`). */
  git: GitRunner
  /** Whether a path exists on the host. */
  exists(path: string): Promise<boolean>
  /** A path's size, times and kind on the host; null when it cannot be read (missing, no access). */
  stat(path: string): Promise<HostFileInfo | null>
}

/**
 * What sessions run on, as ports: built in this process (ExecutionServices is one), or reached
 * through a HostClient (the remote proxies).
 */
export interface HostServices {
  runtimes: { native: AgentRuntime; acp: AgentRuntime; terminal: AgentRuntime }
  /** The runtime of consoles and shells (the same as `runtimes.terminal`). */
  terminal: AgentRuntime
  transcripts: TranscriptReader[]
  history: Partial<Record<string, SessionHistorySource>>
  git: GitRunner
}

/** A place sessions run: its agent runtimes, transcript readers, past sessions, and its folders. */
export interface SessionHost extends HostFolders {
  id: HostId
  services: HostServices
}

/** Picks the host of a session or folder. */
export type HostResolver = (target: HostTarget) => SessionHost

/** `stat` on this computer's disk. */
export const localStat: (path: string) => Promise<HostFileInfo | null> = statPath

/** The host of this computer, over services built in this process. */
export function localHost(services: HostServices): SessionHost {
  return {
    id: LOCAL_HOST_ID,
    services,
    git: services.git,
    exists: async (path) => existsSync(path),
    stat: localStat
  }
}

/** The URL of a folder's `origin` remote; null when the folder is not a git repository or has no origin. */
export async function originUrl(git: GitRunner, folder: string): Promise<string | null> {
  const r = await git(folder, ['remote', 'get-url', 'origin'], { timeoutMs: 10_000 })
  return r.ok ? r.stdout.trim() : null
}

/** The host a profile names (`profile.host`); undefined for an unknown profile or one that names none. */
export type ProfileHostLookup = (profileId: string) => ProfileHost | undefined

/** The known hosts, `local` always among them. */
export class HostRegistry {
  private readonly hosts = new Map<HostId, SessionHost>()
  private preferred: HostId | null = null

  constructor(
    readonly local: SessionHost,
    private readonly profileHost: ProfileHostLookup = () => undefined
  ) {
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

  /**
   * Runs the profiles that name no host on this one while it is registered: the development switch
   * `WORKHUB_HOST=child`. Null goes back to this computer. A profile's own `host` always wins.
   */
  prefer(id: HostId | null): void {
    this.preferred = id
  }

  /**
   * The host a session or folder of this profile runs on: the one the profile names, else the
   * preferred one, else this computer. A named host that is not registered (not connected yet, or
   * failed to start) falls back to this computer.
   */
  hostFor(target: HostTarget): SessionHost {
    const named = target.profileId !== null ? this.profileHost(target.profileId) : undefined
    if (named) return this.hosts.get(hostIdOf(named)) ?? this.local
    return (this.preferred !== null ? this.hosts.get(this.preferred) : undefined) ?? this.local
  }
}
