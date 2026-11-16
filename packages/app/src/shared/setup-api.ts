import type { InstallerId, InstallPlanEntry, ManagedFailure, ManagedToolId, SetupItem } from '@workhub/core'

/** The windows the setup flow opens (hash routes of the renderer: `#welcome`, `#setup`, `#howitworks`). */
export type SetupPage = 'welcome' | 'check' | 'help'

export interface SetupApi {
  /** Runs every check; the commands run with a timeout each. */
  run(): Promise<SetupItem[]>
  /** Installs a missing tool with the main process's own method for that installer; resolves when it ends. */
  install(installer: InstallerId): Promise<{ ok: boolean; output: string; reason?: ManagedFailure }>
  /** What installing these would download, from where and how large, in the order it would run (Node.js added first when needed). */
  installPlan(installers: InstallerId[]): Promise<InstallPlanEntry[]>
  /** Starts "Install what is missing" with the plan's installers; progress comes through `onInstallProgress`. */
  installMany(installers: InstallerId[]): Promise<InstallQueueSnapshot>
  installState(): Promise<InstallQueueSnapshot>
  retryInstall(installer: InstallerId): Promise<InstallQueueSnapshot>
  cancelInstalls(): void
  onInstallProgress(cb: (snapshot: InstallQueueSnapshot) => void): () => void
  /** What the check would find changed outside this window: a sign-in finished, or a tool was removed in Settings. */
  onChanged(cb: () => void): () => void
  /** The tools Workhub installed into its own folder (Settings), and where that folder is. */
  tools(): Promise<{ folder: string; tools: ManagedToolView[] }>
  removeTool(id: ManagedToolId): Promise<{ ok: true } | { ok: false; reason: ManagedFailure; detail: string }>
  /** Opens (or focuses) a setup window. */
  openWindow(page: SetupPage): void
  /** Opens the Settings window on a tab (used by the fix buttons of the setup windows). */
  openSettings(tab: string): void
  /** The welcome flow is done: it does not open again on its own. */
  completeWelcome(): Promise<void>
  /** The person's home and Documents folders: where the welcome's folder step starts. */
  folders(): Promise<{ home: string; documents: string }>
}

export type InstallItemState = 'pending' | 'downloading' | 'verifying' | 'unpacking' | 'installing' | 'done' | 'failed' | 'canceled'

/** One line of "Install what is missing": where the install is, and why it failed. */
export interface InstallItemView {
  installer: InstallerId
  state: InstallItemState
  received?: number
  total?: number
  reason?: ManagedFailure
  /** The tail of what the installer printed, for a failure. */
  detail?: string
}

export interface InstallQueueSnapshot {
  running: boolean
  items: InstallItemView[]
}

/** A tool in Workhub's tools folder, as Settings lists it. */
export interface ManagedToolView {
  id: ManagedToolId
  version: string
  bytes: number
}

/** Per-profile session environment variables: the values live in the secret store and never come back. */
export interface ProfileEnvApi {
  /** Names of the variables that have a stored value. */
  stored(profileId: string): Promise<string[]>
  /** Stores the given values and forgets the removed names. */
  save(profileId: string, values: Record<string, string>, removed: string[]): Promise<void>
}

export interface SystemNotificationsStatus {
  /** The OS shows this app's notifications: supported, and on macOS allowed in System Settings → Notifications. */
  supported: boolean
}

/** What the OS said about a test notification: shown, refused (with its reason), or nothing in time. */
export type NotificationTestResult = { outcome: 'shown' } | { outcome: 'failed'; error: string } | { outcome: 'timeout' }

export interface SystemNotificationsApi {
  status(): Promise<SystemNotificationsStatus>
  /** Opens the OS page where notifications for the app are turned on. */
  openSystemSettings(): void
  /** Shows one notification through the OS with this body, and reports what the OS said. */
  test(body: string): Promise<NotificationTestResult>
}
