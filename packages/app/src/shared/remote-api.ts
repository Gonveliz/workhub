// Remote access (a phone or browser paired with this desktop): what a device may do, by capability,
// and what Settings → Remote access shows and does.

import type { BackgroundTaskSummary, HistoryMessage, PullRequestItem, SubagentSummary } from '@workhub/core'
import type { CodeHostLists } from './codehost-api'

/** A group of `hub` calls and events a paired device can be granted. */
export type RemoteCapability = 'sessions' | 'pullRequests' | 'automations' | 'health' | 'plan'

export const REMOTE_CAPABILITIES: readonly RemoteCapability[] = ['sessions', 'pullRequests', 'automations', 'health', 'plan']

export function isRemoteCapability(value: unknown): value is RemoteCapability {
  return typeof value === 'string' && (REMOTE_CAPABILITIES as readonly string[]).includes(value)
}

export type RemoteDevicePlatform = 'ios' | 'android' | 'web' | 'other'

export interface RemoteDeviceView {
  id: string
  /** The fingerprint as people compare it (groups of four). */
  fingerprint: string
  name: string
  platform: RemoteDevicePlatform
  capabilities: RemoteCapability[]
  pairedAt: number
  lastSeenAt?: number
  online: boolean
}

export type RemoteConnectionState = 'off' | 'connecting' | 'online' | 'error'

export interface RemoteStatusView {
  enabled: boolean
  /** The relay as the person typed it (https://relay.example.com). */
  relayUrl: string
  desktopName: string
  /** This desktop's identity, once made. */
  desktopId: string | null
  fingerprint: string | null
  connection: RemoteConnectionState
  error?: string
  /** Whether the relay can push notifications to devices that are offline. */
  pushAvailable: boolean
  devices: RemoteDeviceView[]
  /** A QR being shown (its link and when it expires). */
  pairing: { link: string; expiresAt: number } | null
  /** A device that answered the QR and waits for the person to confirm it. */
  request: { deviceId: string; fingerprint: string; name: string; platform: RemoteDevicePlatform } | null
}

export interface RemoteApi {
  status(): Promise<RemoteStatusView>
  setEnabled(enabled: boolean): Promise<RemoteStatusView>
  setRelayUrl(url: string): Promise<RemoteStatusView>
  setDesktopName(name: string): Promise<RemoteStatusView>
  startPairing(): Promise<RemoteStatusView>
  cancelPairing(): Promise<RemoteStatusView>
  acceptPairing(deviceId: string, capabilities: RemoteCapability[]): Promise<RemoteStatusView>
  rejectPairing(deviceId: string): Promise<RemoteStatusView>
  setCapabilities(deviceId: string, capabilities: RemoteCapability[]): Promise<RemoteStatusView>
  revoke(deviceId: string): Promise<RemoteStatusView>
  onChanged(cb: (status: RemoteStatusView) => void): () => void
}

/** A file inside a session's folder, as a device reads it (an image the agent made, a log). */
export interface RemoteFile {
  name: string
  size: number
  mime: string
  /** base64 of the content. */
  data: string
}

/** A page of an open session's stored conversation (`remote:history`): messages `start`.. of `total`. */
export interface RemoteHistoryPage {
  messages: HistoryMessage[]
  start: number
  total: number
}

/**
 * What the desktop says it understands when a device connects (`ready.features`). A phone asks for
 * paged lists or session activity only when the desktop names the feature; an older desktop gets
 * the calls it always had.
 */
export const REMOTE_FEATURES = { away: 'away', paging: 'paging', activity: 'activity' } as const

/** A page of a long list a device asks for (`remote:sessions`, `remote:pullRequests`, `remote:automations`, `remote:automationRuns`). */
export interface RemotePageRequest {
  /** Items wanted (1 to 200; 50 when omitted). A page also stops early to stay under the relay's frame. */
  limit?: number
  /** `nextCursor` of the previous page; omitted for the first page. */
  cursor?: string | null
}

/** One page: `nextCursor` is null on the last one. `total` counts the whole list as of this page. */
export interface RemotePage<T> {
  items: T[]
  nextCursor: string | null
  total: number
}

/** Which of the two pull request lists a row belongs to. */
export type RemotePullRequestList = 'mine' | 'toReview'

/** `remote:pullRequests`: without `list`, the first page of each list; with it, the page of that list after `cursor`. */
export interface RemotePullRequestsRequest extends RemotePageRequest {
  list?: RemotePullRequestList
}

/**
 * A page of the profile's pull requests (`remote:pullRequests`): the lists' state, how many each
 * list holds, and a page of the list asked for (of both on a first read). Rows without a link are
 * left out.
 */
export interface RemotePullRequestsPage {
  lists: Omit<CodeHostLists, 'mine' | 'toReview'>
  counts: Record<RemotePullRequestList, number>
  mine?: RemotePage<PullRequestItem>
  toReview?: RemotePage<PullRequestItem>
}

/** `remote:automationRuns`: the run history, newest first; `automationId` keeps one automation's runs. */
export interface RemoteRunsRequest extends RemotePageRequest {
  automationId?: string
}

/**
 * What a session has going on besides its reply (`remote:activity`, with one session id or a list): its sub-agents and the
 * background tasks it left running, as the desktop's monitor last saw them. A device gets these
 * live through `session:event` too; this is for one that connected after they started.
 */
export interface RemoteSessionActivity {
  subagents: SubagentSummary[]
  backgroundTasks: BackgroundTaskSummary[]
}

/** `remote:activity` with a list of session ids: the activity of each one still open, by id. */
export type RemoteActivityById = Record<string, RemoteSessionActivity>
