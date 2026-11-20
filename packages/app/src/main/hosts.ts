// The hosts sessions run on. Every session runs on this computer today (the `local` host); a
// profile that runs elsewhere (a WSL distribution, say) will get a host of its own, whose services
// reach it through a HostClient, and `hostFor` will pick it from the profile.
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { GitRunner } from '@workhub/adapters/git-review'
import type { ExecutionServices } from '@workhub/adapters/host'

export type HostId = 'local' | (string & {})

/** The host of this computer: the one every session runs on until profiles name another. */
export const LOCAL_HOST_ID = 'local'

/** What a host is picked by: the profile a session (or a folder) belongs to. */
export interface HostTarget {
  profileId: string | null
}

/** What `stat` tells of a path on a host. */
export interface HostFileInfo {
  size: number
  mtimeMs: number
  mode: number
  isFile: boolean
  isDirectory: boolean
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

/** A place sessions run: its agent runtimes, transcript readers, past sessions, and its folders. */
export interface SessionHost extends HostFolders {
  id: HostId
  services: ExecutionServices
}

/** Picks the host of a session or folder. */
export type HostResolver = (target: HostTarget) => SessionHost

/** `stat` on this computer's disk. */
export async function localStat(path: string): Promise<HostFileInfo | null> {
  const info = await stat(path).catch(() => null)
  return info && { size: info.size, mtimeMs: info.mtimeMs, mode: info.mode, isFile: info.isFile(), isDirectory: info.isDirectory() }
}

/** The host of this computer, over services built in this process. */
export function localHost(services: ExecutionServices): SessionHost {
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
