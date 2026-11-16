import type { TimelinePrEvent } from '@workhub/adapters/sqlite-store'
import { detectPrEvents, EMPTY_PR_EVENT_STATE, profileRefreshMs, type PrEventState, type PrEventStore, type PullRequest, type WorkhubConfig } from '@workhub/core'
import type { CodeHostLists } from '../shared/codehost-api'
import type { PrEventBatch, PrNotification } from '../shared/pr-events-api'
import type { IpcRegistrar } from './ipc-guard'
import { jobReports } from './job-reporter'

/** How often the service checks which profiles are due; each profile syncs at its code host connection's interval (3 minutes by default, as Workhub 1). */
export const PR_SYNC_TICK_MS = 30_000

/** `owner/repo#12` (lower case) of a pull or merge request URL, as the detector's event ids start; the URL itself otherwise. */
export function prSlug(url: string): string {
  const m = /^https?:\/\/[^/]+\/(.+?)\/(?:-\/)?(?:pull|pulls|merge_requests)\/(\d+)/.exec(url)
  return m ? `${m[1]!.toLowerCase()}#${m[2]}` : url
}

/** The part of the code host service the sync reads through. */
export interface PrEventSource {
  lists(profileId: string | null, force: boolean): Promise<CodeHostLists>
  stateOf(profileId: string | null, url: string): Promise<PullRequest | null>
}

export interface PrEventServiceDeps {
  source: PrEventSource
  store: PrEventStore
  config: () => Promise<WorkhubConfig>
  /** Delivers a batch to the renderer; called only once the renderer is listening. */
  emit: (batch: PrEventBatch) => void
  /**
   * Appends to the pull request timeline (once each; a failure is ignored): the events a sync
   * detected, `opened` the first time a PR of mine is seen open, and `reviewed` when a PR leaves
   * my review queue.
   */
  record?: (profileId: string, events: readonly TimelinePrEvent[]) => void
  /** Demo mode: only the active profile syncs, and `advance` moves the demo one step on. */
  demo?: { advance: () => number }
  now?: () => number
}

/**
 * Syncs the pull requests of each profile with a code host, compares them with the last sync and
 * hands the new events to the renderer (which words and shows the notification). The memory is
 * persisted per profile, so an event is handled once and an upgrade or a first run only seeds it.
 */
export class PrEventService {
  private state: PrEventState = { ...EMPTY_PR_EVENT_STATE, profiles: {} }
  private loaded = false
  private timer: ReturnType<typeof setInterval> | undefined
  private running: Promise<void> | undefined
  private readonly job = jobReports.job('pull request events')
  private listening = false
  private buffered: PrEventBatch[] = []
  private readonly now: () => number
  /** When each profile last synced, so each one follows its own connection's interval. */
  private readonly syncedAt = new Map<string, number>()

  constructor(private readonly deps: PrEventServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  start(): void {
    if (this.timer) return
    void this.sync()
    this.timer = setInterval(() => void this.syncDue(), PR_SYNC_TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** The renderer subscribed: deliver what was found before that. */
  rendererReady(): void {
    this.listening = true
    const pending = this.buffered
    this.buffered = []
    for (const batch of pending) this.deps.emit(batch)
  }

  private deliver(batch: PrEventBatch): void {
    if (this.listening) this.deps.emit(batch)
    else this.buffered.push(batch)
  }

  /** One sync of every profile with a code host; calls made while one runs share it. */
  sync(): Promise<void> {
    this.running ??= this.syncAll(false).finally(() => (this.running = undefined))
    return this.running
  }

  /** Syncs only the profiles whose code host interval has passed since their last sync. */
  syncDue(): Promise<void> {
    this.running ??= this.syncAll(true).finally(() => (this.running = undefined))
    return this.running
  }

  private async syncAll(onlyDue: boolean): Promise<void> {
    if (!this.loaded) {
      this.state = await this.deps.store.load().catch(() => ({ ...EMPTY_PR_EVENT_STATE, profiles: {} }))
      this.loaded = true
    }
    const config = await this.deps.config()
    const profiles = config.profiles.filter((p) => (this.deps.demo ? p.id === config.activeProfileId : Boolean(p.connections.codeHost)))
    let failure: { error: unknown } | undefined
    for (const profile of profiles) {
      const last = this.syncedAt.get(profile.id)
      if (onlyDue && last !== undefined && this.now() - last < profileRefreshMs(config, profile.id, 'codeHost')) continue
      this.syncedAt.set(profile.id, this.now())
      try {
        await this.syncProfile(profile.id)
      } catch (err) {
        // A failed sync keeps the memory as it was; the next one tries again.
        failure ??= { error: err }
      }
    }
    if (failure) this.job.failed(failure.error)
    else this.job.ok()
  }

  private async syncProfile(profileId: string): Promise<void> {
    const lists = await this.deps.source.lists(profileId, true)
    // Not connected, signed out or a list that failed (its old figures would pass for fresh ones): keep the memory.
    if (lists.state !== 'ready' || lists.message) return
    const mine = lists.mine.map((i) => i.pr)
    const toReview = lists.toReview.map((i) => i.pr)
    const previous = this.state.profiles[profileId]
    const open = new Set(mine.map((p) => p.url))
    const left: Record<string, PullRequest> = {}
    for (const url of Object.keys(previous?.mine ?? {})) {
      if (open.has(url)) continue
      const pr = await this.deps.source.stateOf(profileId, url)
      if (pr) left[url] = pr
    }
    const now = this.now()
    const result = detectPrEvents({ previous, mine, toReview, left, now })
    this.state = { ...this.state, profiles: { ...this.state.profiles, [profileId]: result.state } }
    // Persist before announcing: a crash after the notification must not announce the same event again.
    await this.deps.store.save(this.state).catch(() => undefined)
    if (this.deps.record) {
      const timeline: TimelinePrEvent[] = [...result.events]
      for (const p of mine) if (!previous?.mine[p.url]) timeline.push({ id: `${prSlug(p.url)}|opened`, kind: 'opened', url: p.url, title: p.title, name: `${p.repo}#${p.number}`, at: now })
      if (previous?.requested) {
        const still = new Set(toReview.map((p) => p.url))
        for (const url of previous.requested) if (!still.has(url)) timeline.push({ id: `${prSlug(url)}|reviewed|${now}`, kind: 'reviewed', url, title: '', name: url, at: now })
      }
      try {
        if (timeline.length) this.deps.record(profileId, timeline)
      } catch {
        // The timeline is a record: the notification goes out anyway.
      }
    }
    if (result.events.length) this.deliver({ profileId, events: result.events })
  }

  /** Demo mode: advance the demo and sync now. */
  async demoAdvance(): Promise<number | null> {
    if (!this.deps.demo) return null
    const step = this.deps.demo.advance()
    await this.sync()
    return step
  }
}

export interface PrEventsIpcDeps {
  service: PrEventService
  /** Shows an OS notification whose click opens the pull request. */
  notify: (n: PrNotification) => void
  /** Whether a connected code host recognizes the URL; a notification for any other URL is dropped. */
  recognizes: (profileId: string | null, url: string) => Promise<boolean>
}

export function registerPrEventsIpc(ipc: IpcRegistrar, { service, notify, recognizes }: PrEventsIpcDeps): void {
  ipc.on('prEvents:ready', () => service.rendererReady())
  // The URL comes from the renderer and a click opens a window on it: only a pull request URL of a connected host.
  ipc.on('prEvents:notify', (_e, n: PrNotification) => {
    if (!n || typeof n.title !== 'string' || typeof n.url !== 'string' || typeof n.profileId !== 'string') return
    void recognizes(n.profileId || null, n.url).then(
      (known) => {
        if (known) notify(n)
      },
      () => undefined
    )
  })
  ipc.handle('prEvents:demoAdvance', () => service.demoAdvance())
}

