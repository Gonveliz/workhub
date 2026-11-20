// The hosts sessions run on. Every session runs on this computer today (the `local` host); a
// profile that runs elsewhere (a WSL distribution, say) will get a host of its own, whose services
// reach it through a HostClient, and `hostFor` will pick it from the profile.
import { existsSync } from 'node:fs'
import type { GitRunner } from '@workhub/adapters/git-review'
import { statPath, type HostFileInfo } from '@workhub/adapters/host'
import type { AgentRuntime, SessionHistorySource, TranscriptReader } from '@workhub/core'

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

/** The known hosts, `local` always among them. */
export class HostRegistry {
  private readonly hosts = new Map<HostId, SessionHost>()
  private preferred: HostId | null = null

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

  /**
   * Runs every profile on this host while it is registered (`WORKHUB_HOST=child`); null goes back
   * to this computer. A stopgap until profiles name their own host.
   */
  prefer(id: HostId | null): void {
    this.preferred = id
  }

  /** The host a session or folder of this profile runs on: the preferred one, else this computer. */
  hostFor(_target: HostTarget): SessionHost {
    return (this.preferred !== null ? this.hosts.get(this.preferred) : undefined) ?? this.local
  }
}
