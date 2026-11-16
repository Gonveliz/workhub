import { readdir } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { homedir } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { emptySpendCache, repoRootOf, TokenSpendScanner, worktreeAliases, type SpendCache, type SpendFileEntry, type SpendSources, type WorktreeLink } from '@workhub/adapters/token-spend'
import { UNKNOWN_ACCOUNT, type ProjectResolver } from '@workhub/adapters/sqlite-store'
import { aliasPath, attributeFolder, type BackgroundSpend, folderSpend, owningProfile, ownsFolder, parseSpendKey, profileFolderPaths, SPEND_DAYS, spendWindowStart, startOfLocalDay, type SpendBuckets, type WorkhubConfig } from '@workhub/core'
import type { FolderSpendResult } from '../shared/api'
import { usageAccounts } from './agent-usage'
import { profileProjectChildren } from './workspaces'

/** Rescans every 10 minutes; a scan reads only what was appended since the previous one. */
const INTERVAL_MS = 10 * 60_000

export interface TokenSpendDeps {
  config: () => Promise<WorkhubConfig>
  /** Where the scanned state is kept between runs (the `token-spend` key of `kv_state` in `workhub.db`). */
  store: { load(fallback: SpendCache): SpendCache; save(value: SpendCache): void; flush(): void }
  sources: () => Promise<SpendSources>
  /** A scan finished: the renderer asks again for its profile's spend. */
  emit: () => void
  intervalMs?: number
  now?: () => number
  /** Expands `~` in the profiles' folders (the user's home by default). */
  home?: string
  /** Each scan, timed: how long it took and how many files it holds (the main log). */
  onScanned?: (scan: { ms: number; files: number; failed: boolean }) => void
  /** Marks the scan as running work, so an event-loop stall during it names it (see `Activity`). */
  begin?: (label: string) => () => void
  /**
   * After each scan, the same transcripts read for per-turn data (the usage reports); its failure
   * leaves Home's figures alone.
   */
  turns?: (sources: SpendSources) => Promise<unknown>
  /** The model runs Workhub started by itself over the last 7 days ("Workhub background"); they leave no transcript. */
  background?: () => BackgroundSpend
}

/**
 * Token spend per folder of each profile, for Home. Scans the transcripts in the background from
 * start-up and keeps the result cached on disk, so the card is ready when Home opens instead of
 * waiting for sessions to report tokens.
 */
export class TokenSpendService {
  private readonly scanner: TokenSpendScanner
  private buckets: SpendBuckets = {}
  private reads: SpendBuckets = {}
  private scannedAt: number | null = null
  private scanning = false
  private timer: ReturnType<typeof setInterval> | null = null
  private inflight: Promise<void> | null = null
  private queued: Promise<void> | null = null
  /** Linked git worktree of each path looked up (null: none); emptied by each scan. */
  private worktrees = new Map<string, WorktreeLink | null>()

  constructor(private readonly deps: TokenSpendDeps) {
    this.scanner = new TokenSpendScanner(deps.store.load(emptySpendCache()))
    // What the last run found, until the first scan of this run ends.
    this.buckets = this.scanner.cached(spendWindowStart(this.now()))
    this.reads = this.scanner.cacheReads(spendWindowStart(this.now()))
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  start(): void {
    if (this.timer) return
    void this.scanNow()
    this.timer = setInterval(() => void this.scanNow(), this.deps.intervalMs ?? INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.deps.store.flush()
  }

  /**
   * A scan now (the Usage screen's Refresh), never two at once: while one runs, the call waits for
   * it and then runs one more (what it read may predate the turns just written); callers meanwhile
   * share that one.
   */
  scanNow(): Promise<void> {
    if (this.queued) return this.queued
    if (!this.inflight) return this.run()
    this.queued = this.inflight.then(() => {
      this.queued = null
      return this.run()
    })
    return this.queued
  }

  private run(): Promise<void> {
    const scan = this.refresh().finally(() => {
      if (this.inflight === scan) this.inflight = null
    })
    this.inflight = scan
    return scan
  }

  async refresh(): Promise<void> {
    const now = this.now()
    const started = performance.now()
    let failed = false
    const end = this.deps.begin?.('token spend scan')
    this.scanning = true
    let sources: SpendSources | null = null
    try {
      sources = await this.deps.sources()
      this.buckets = await this.scanner.scan(sources, startOfLocalDay(now, SPEND_DAYS - 1), spendWindowStart(now))
      this.reads = this.scanner.cacheReads(spendWindowStart(now))
      this.scannedAt = this.now()
      this.worktrees = new Map()
      this.deps.store.save(this.scanner.snapshot())
    } catch {
      // A failed scan keeps the previous figures; the next one tries again.
      failed = true
    } finally {
      end?.()
      this.scanning = false
      this.deps.onScanned?.({ ms: Math.round(performance.now() - started), files: Object.keys(this.scanner.snapshot().files).length, failed })
      this.deps.emit()
    }
    if (sources && this.deps.turns) {
      const endTurns = this.deps.begin?.('turn scan')
      await this.deps.turns(sources).catch(() => undefined)
      endTurns?.()
    }
  }

  /** What the scanned transcripts `include` picks cost over the last 7 days (see `ApiSpendService`). */
  costs(include: (path: string, entry: SpendFileEntry) => boolean): { usd: SpendBuckets; unpriced: SpendBuckets; tokens: SpendBuckets } {
    return this.scanner.costs(spendWindowStart(this.now()), include)
  }

  /** The spend of one profile's folders over the last 7 days, largest first. */
  async forProfile(profileId: string | null | undefined): Promise<FolderSpendResult> {
    const config = await this.deps.config()
    const profile = config.profiles.find((p) => p.id === (profileId ?? config.activeProfileId)) ?? config.profiles[0]
    if (!profile) return { entries: [], days: SPEND_DAYS, scannedAt: this.scannedAt, scanning: this.scanning, hasFolders: false }
    const home = this.deps.home ?? homedir()
    const folders = profileFolderPaths(profile, home).map((f) => f.path)
    const children = await profileProjectChildren(profile, home)
    const owns = (path: string) => ownsFolder(profile.id, path, config.profiles, home)
    const sinceDay = spendWindowStart(this.now())
    const hasFolders = folders.length > 0 || profile.ownsOutside === true
    // A linked worktree counts for its repository (and so for the profile owning it), wherever it
    // lives: outside the folders, or next to the repository inside one.
    const paths = new Set<string>()
    for (const key of [...Object.keys(this.buckets), ...Object.keys(this.reads)]) {
      const parsed = parseSpendKey(key)
      if (parsed && parsed.day >= sinceDay) paths.add(parsed.path)
    }
    // The child folders too: a removed worktree may be named after a live one (see `folderSpend`).
    for (const [folder, kids] of Object.entries(children)) for (const kid of kids) paths.add(join(folder, kid))
    const aliases = hasFolders ? await worktreeAliases(paths, this.worktrees) : {}
    const entries = folderSpend(this.buckets, folders, { sinceDay, children, owns, aliases, cacheReads: this.reads })
    const background = this.background()
    return { entries, days: SPEND_DAYS, scannedAt: this.scannedAt, scanning: this.scanning, hasFolders, ...(background ? { background } : {}) }
  }

  /** Workhub's own runs, when there were any; a read that fails leaves the card as it was. */
  private background(): BackgroundSpend | null {
    try {
      const spend = this.deps.background?.()
      return spend && spend.runs > 0 ? spend : null
    } catch {
      return null
    }
  }
}

/**
 * Every transcript folder to scan: each Claude and Codex account's folder plus the defaults, the
 * other `~/.claude*` folders (Claude installs Workhub has no account for, as Workhub 1 read), and
 * Kiro's data folder.
 */
export async function spendSources(config: WorkhubConfig, home: string, kiroDir: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<SpendSources> {
  const dirs = (agentId: string, fallback: string) => usageAccounts(config, agentId, home, env).map((a) => resolve(a.configDir ?? join(home, fallback)))
  const claude = new Set(dirs('claude', '.claude'))
  if (!claude.size) claude.add(resolve(env['CLAUDE_CONFIG_DIR'] || join(home, '.claude')))
  for (const e of await readdir(home, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory() && e.name.startsWith('.claude')) claude.add(join(home, e.name))
  }
  const codex = new Set(dirs('codex', '.codex'))
  if (!codex.size) codex.add(resolve(env['CODEX_HOME'] || join(home, '.codex')))
  return { claudeDirs: [...claude], codexHomes: [...codex], kiroDirs: [kiroDir ?? join(home, '.kiro')] }
}

/**
 * Who a transcript belongs to, for the per-turn data: the account whose config folder (Claude) or
 * home (Codex) holds it (null: the default account; `unknown`: a folder no account uses), and the
 * profile owning the folder a session works in.
 */
export function turnOwners(config: WorkhubConfig, home: string, env: NodeJS.ProcessEnv = process.env): { accountOf: (agent: string, dir: string) => string | null; profileOf: (cwd: string) => string | null } {
  const accounts = new Map<string, string | null>()
  for (const agent of ['claude', 'codex']) {
    for (const a of usageAccounts(config, agent, home, env)) accounts.set(`${agent}\u0000${resolve(a.configDir ?? join(home, `.${agent}`))}`, a.accountId)
  }
  return {
    accountOf: (agent, dir) => {
      const key = `${agent}\u0000${resolve(dir)}`
      return accounts.has(key) ? (accounts.get(key) ?? null) : UNKNOWN_ACCOUNT
    },
    profileOf: (cwd) => owningProfile(cwd, config.profiles, home)?.id ?? null
  }
}

/**
 * The project of each folder, as Home rolls spend up (see `folderSpend`): a linked worktree moved to
 * its repository, then the deepest profile project folder holding it (a profile folder, or one of
 * the projects listed in it); outside every profile, the repository root, else the folder itself.
 * The profiles' folders are read once per call of this function (once per scan).
 */
export async function turnProjects(config: WorkhubConfig, home: string, cache: Map<string, WorktreeLink | null> = new Map()): Promise<ProjectResolver> {
  const folders: string[] = []
  const children: Record<string, string[]> = {}
  for (const profile of config.profiles) {
    for (const f of profileFolderPaths(profile, home)) folders.push(f.path)
    Object.assign(children, await profileProjectChildren(profile, home).catch(() => ({})))
  }
  return async (paths) => {
    const aliases = await worktreeAliases(paths, cache)
    const out: Record<string, string> = {}
    for (const p of paths) {
      const moved = aliasPath(p, aliases)
      const place = attributeFolder(moved, folders, children)
      // Aliases and folder children are kept with forward slashes; the stored project keeps the platform's form, as `cwd` does.
      out[p] = normalize(place ? place.path : ((await repoRootOf(moved)) ?? p))
    }
    return out
  }
}

/**
 * Whether the transcript scan for the usage reports may read the user's transcripts: never in a
 * demo (a scenario, or synthetic usage), so a screenshot cannot show real folders.
 */
export function ingestsTranscripts(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return !env['WORKHUB_DEMO_SCENARIO'] && env['WORKHUB_DEMO_USAGE'] !== '1'
}
