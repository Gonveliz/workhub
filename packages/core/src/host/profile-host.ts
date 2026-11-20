// Where a profile's sessions and folders live: this computer, or a WSL distribution (whose folders
// are POSIX paths inside it). A profile without one runs on this computer.
import type { Profile } from '../domain/profile'

export type ProfileHost = { kind: 'local' } | { kind: 'wsl'; distro: string }

/** The host a profile runs on; this computer when it names none. */
export function hostOfProfile(profile: Pick<Profile, 'host'>): ProfileHost {
  return profile.host ?? { kind: 'local' }
}

/** A stable id for a host, the one the app registers it under: `local`, or `wsl:<distro>`. */
export function hostIdOf(host: ProfileHost): string {
  return host.kind === 'wsl' ? `wsl:${host.distro}` : 'local'
}
