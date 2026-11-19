import { ChevronRight, CircleAlert, Folder, History, MessagesSquare, Search, Settings, SquareTerminal, UserRound } from 'lucide-react'
import { AgentIcon } from '../components/atoms/AgentIcon'
import { ContextMenu } from 'radix-ui'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { groupAutomationHistory, groupHistory, historyId, historyInProfile, listedInHistory, owningProfile, type FolderProfile, type Profile } from '@workhub/core'
import type { HistoryIndexProgress, HistoryItem, HistoryMatch, HistoryResult, SessionView } from '@shared/api'
import { Badge, Button, IconButton, Input, Select, Spinner } from '../components/atoms'
import { Dialog, EmptyState, useToast, RefreshButton } from '../components/molecules'
import { TagsEditor } from '../components/molecules/TagsEditor'
import { HistoryIndexingNote, HistorySnippet, titleSnippetFits } from '../components/molecules/HistorySnippet'
import { useI18n } from '../i18n/I18nProvider'
import { useSessionRows } from '../lib/sessionGroups'
import { folderName } from '../lib/home'
import { resumeInput } from '../lib/links'
import { readPrefs } from '../lib/prefs'
import { errorText } from '../lib/errorText'

export interface HistoryScreenProps {
  profileId: string | null
  /** Every profile, for the profile filter. */
  profiles?: Profile[]
  onOpened: (sessionId: string) => void
  /** False while another screen shows; the list reloads in the background when History comes back. */
  visible?: boolean
  /** Show one session (Usage and reports asked): its id goes in the search and the other filters clear. */
  focus?: { query: string } | null
}

export interface HistoryFilter {
  /** An agent id, or `*` for every agent. */
  agent: string
  /** An account id (`''`: the default folder), or `*` for every account. */
  account: string
  /** Only this profile's sessions (the folders it owns and its accounts); undefined for every profile. */
  profile?: Partial<FolderProfile> & Pick<Profile, 'accountIds'>
  /** Every profile, so a folder goes to the profile that owns it (see `owningProfile`). */
  profiles?: readonly FolderProfile[]
  /** Expands `~` in the profiles' folders. */
  home?: string
  /** The search box: a session's exact id lists it even from a throwaway folder (Usage opens History so). */
  query?: string
}

/** The entries History lists: no throwaway runs in temporary folders (unless the search is the session's id), then the agent, account and profile filters. */
export function visibleHistory(entries: readonly HistoryItem[], filter: HistoryFilter): HistoryItem[] {
  return entries.filter(
    (e) =>
      listedInHistory(e, filter.query) &&
      (filter.agent === ALL || e.agentId === filter.agent) &&
      (filter.account === ALL || (e.accountId ?? '') === filter.account) &&
      (!filter.profile || historyInProfile(e, filter.profile, { profiles: filter.profiles, home: filter.home }))
  )
}

/** The open sessions by `historyId`, so a history row can say "Open" and show it instead of resuming it again. */
export function openSessionsByHistory(views: readonly SessionView[]): Map<string, string> {
  const open = new Map<string, string>()
  for (const v of views) {
    if (v.state === 'stopped' || v.state === 'error' || !v.agentSessionId) continue
    open.set(historyId({ agentId: v.agentId, agentSessionId: v.agentSessionId }), v.id)
  }
  return open
}

/** Accounts present in the history, for the filter: `''` is Claude's default folder. */
export function historyAccounts(entries: HistoryItem[]): { id: string; name: string }[] {
  const seen = new Map<string, string>()
  for (const e of entries) if (!seen.has(e.accountId ?? '')) seen.set(e.accountId ?? '', e.accountName ?? '')
  return [...seen.entries()].map(([id, name]) => ({ id, name }))
}

/** Agents present in the history, for the filter. */
export function historyAgents(entries: HistoryItem[]): { id: string; name: string }[] {
  const seen = new Map<string, string>()
  for (const e of entries) if (!seen.has(e.agentId)) seen.set(e.agentId, e.agentName)
  return [...seen.entries()].map(([id, name]) => ({ id, name }))
}

const ALL = '*'

export interface HistoryToolbarProps {
  query: string
  onQuery: (query: string) => void
  agent: string
  onAgent: (agent: string) => void
  agents: readonly { id: string; name: string }[]
  profile: string
  onProfile: (profile: string) => void
  profiles: readonly { id: string; name: string }[]
  account: string
  onAccount: (account: string) => void
  accounts: readonly { id: string; name: string }[]
  /** Whether the "hide automations" toggle shows (there are automation runs, or it is on). */
  automations: boolean
  hideAutomations: boolean
  onHideAutomations: (hide: boolean) => void
  loading: boolean
  onRefresh: () => void
}

/**
 * The search box and the filters of History. A filter only shows when there is a choice to make
 * (two or more agents, profiles or accounts; automation runs). With any of them showing, the
 * search box takes a line of its own and the filters the next one: on one line they left it too
 * narrow to see what was typed. With none, the search box shares its line with Refresh.
 */
export function HistoryToolbar({ query, onQuery, agent, onAgent, agents, profile, onProfile, profiles, account, onAccount, accounts, automations, hideAutomations, onHideAutomations, loading, onRefresh }: HistoryToolbarProps) {
  const { t } = useI18n()
  const filtered = agents.length > 1 || profiles.length > 1 || accounts.length > 1 || automations
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="history-toolbar">
      <div className={filtered ? 'relative basis-full' : 'relative min-w-0 flex-1'} data-testid="history-search-box">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle" aria-hidden />
        <Input aria-label={t('history.search')} placeholder={t('history.search')} value={query} onChange={(e) => onQuery(e.target.value)} className="pl-8!" spellCheck={false} />
      </div>
      {agents.length > 1 && (
        <div className="w-44 shrink-0">
          <Select aria-label={t('history.agent')} value={agent} onChange={onAgent} options={[{ value: ALL, label: t('history.allAgents') }, ...agents.map((a) => ({ value: a.id, label: a.name }))]} />
        </div>
      )}
      {profiles.length > 1 && (
        <div className="w-44 shrink-0">
          <Select aria-label={t('history.profile')} value={profile} onChange={onProfile} options={[{ value: ALL, label: t('history.allProfiles') }, ...profiles.map((p) => ({ value: p.id, label: p.name }))]} />
        </div>
      )}
      {accounts.length > 1 && (
        <div className="w-48 shrink-0">
          <Select aria-label={t('history.account')} value={account} onChange={onAccount} options={[{ value: ALL, label: t('history.allAccounts') }, ...accounts.map((a) => ({ value: a.id, label: a.name || t('usage.defaultAccount') }))]} />
        </div>
      )}
      {automations && (
        <Button size="md" variant={hideAutomations ? 'primary' : 'secondary'} aria-pressed={hideAutomations} onClick={() => onHideAutomations(!hideAutomations)} data-testid="history-hide-automations">
          {t('history.hideAutomations')}
        </Button>
      )}
      {filtered && <span className="flex-1" />}
      <RefreshButton size="md" iconClassName="size-4" label={t('history.refresh')} loading={loading} onRefresh={onRefresh} />
    </div>
  )
}

/** Every session of every agent that keeps a history, searchable, filterable by agent, grouped by folder. */
export function HistoryScreen({ profileId, profiles = [], onOpened, visible = true, focus }: HistoryScreenProps) {
  const { t, tn, formatDate } = useI18n()
  const toast = useToast()
  // The rows, not every session: History stays mounted, hidden, and must not render for each streamed chunk.
  const rows = useSessionRows()
  const open = useMemo(() => openSessionsByHistory(rows.map((s) => s.view)), [rows])
  // Workhub 1 lists the active profile's sessions unless "All profiles" is picked.
  const [profileFilter, setProfileFilter] = useState(profileId ?? ALL)
  useEffect(() => setProfileFilter(profileId ?? ALL), [profileId])
  const [result, setResult] = useState<HistoryResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  // Grouping and fuzzy matching run on the settled text, so typing never waits for them.
  const deferredQuery = useDeferredValue(query)
  const [account, setAccount] = useState(ALL)
  const [agent, setAgent] = useState(ALL)
  const [error, setError] = useState('')
  const [opening, setOpening] = useState<string | null>(null)
  const [tagging, setTagging] = useState<HistoryItem | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setResult(await window.hub.history.list())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    if (visible) void load()
  }, [load, visible])
  // Accounts with more sessions than the listing went to: list a page further back.
  const loadOlder = async () => {
    setLoading(true)
    setError('')
    try {
      setResult(await window.hub.history.listOlder())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }

  const [home, setHome] = useState<string | undefined>()
  useEffect(() => {
    void window.hub.getDefaultCwd().then(setHome, () => setHome(undefined))
  }, [])
  const filterProfile = profiles.length > 1 ? profiles.find((p) => p.id === profileFilter) : undefined
  // An automation's runs collapse into one row per automation; the other sessions group by folder.
  const [hideAutomations, setHideAutomations] = useState(false)
  useEffect(() => {
    if (!focus) return
    setQuery(focus.query)
    setAgent(ALL)
    setAccount(ALL)
    setProfileFilter(ALL)
    setHideAutomations(false)
  }, [focus])
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const entries = useMemo(() => visibleHistory(result?.entries ?? [], { agent, account, profile: filterProfile, profiles, home, query: deferredQuery }), [result, agent, account, filterProfile, profiles, home, deferredQuery])
  const byAutomation = useMemo(() => groupAutomationHistory(entries, ''), [entries])
  const groups = useMemo(() => groupHistory(byAutomation.rest, ''), [byAutomation])
  const automationGroups = hideAutomations ? [] : byAutomation.groups
  const toggleAutomation = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const accounts = useMemo(() => historyAccounts(result?.entries ?? []), [result])
  const agents = useMemo(() => historyAgents(result?.entries ?? []), [result])
  // Long histories render a page at a time: every row carries a context menu, and one folder can hold hundreds.
  const [limit, setLimit] = useState(HISTORY_PAGE)
  useEffect(() => setLimit(HISTORY_PAGE), [deferredQuery, agent, account, profileFilter, hideAutomations])
  const page = useMemo(() => pageGroups(groups, limit), [groups, limit])

  // Search: the main process ranks the index (conversations included) and adds the plain matches,
  // within the sessions the filters leave (sent as keys, so filtering happens before paging).
  const searching = query.trim() !== ''
  const searchText = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS)
  const scopeKeys = useMemo(() => searchScope(entries, hideAutomations), [entries, hideAutomations])
  const [search, setSearch] = useState<HistorySearchState | null>(null)
  const [moreLoading, setMoreLoading] = useState(false)
  const [progress, setProgress] = useState<HistoryIndexProgress | null>(null)
  const [rerun, setRerun] = useState(0)
  const lastRun = useRef<HistoryIndexProgress | null>(null)
  useEffect(() => {
    void window.hub.history.indexProgress().then(setProgress, () => undefined)
    return window.hub.history.onIndexProgress(setProgress)
  }, [])
  // The index finished, or grew a good deal since the last search: search again.
  useEffect(() => {
    if (progress && shouldSearchAgain(lastRun.current, progress)) setRerun((n) => n + 1)
  }, [progress])
  useEffect(() => {
    if (!searchText || !visible || !result) return
    let current = true
    window.hub.history.search(searchText, { keys: scopeKeys, limit: HISTORY_PAGE }).then(
      (r) => {
        if (!current) return
        lastRun.current = r.progress
        setSearch({ query: searchText, scope: scopeKeys, entries: r.entries, total: r.total, nextCursor: r.nextCursor })
        setProgress(r.progress)
      },
      (e) => current && setError(errorText(e))
    )
    return () => {
      current = false
    }
  }, [searchText, scopeKeys, visible, result, rerun])
  const searched = search && search.query === searchText && search.scope === scopeKeys ? search : null
  const matches = useMemo(() => new Map((searched?.entries ?? []).map((m) => [historyId(m), m])), [searched])
  // Until the search answers, the plain match of the listing shows (newest first).
  const plainMatches = useMemo(() => (searching && !searched ? groupHistory(entries.filter((e) => !hideAutomations || !e.automationId), deferredQuery).flatMap((g) => g.entries).sort((x, y) => y.lastModified - x.lastModified) : []), [searching, searched, entries, hideAutomations, deferredQuery])
  const found: HistoryItem[] = searched ? searched.entries : plainMatches.slice(0, HISTORY_PAGE)
  const loadMore = async () => {
    if (!searched?.nextCursor || moreLoading) return
    setMoreLoading(true)
    try {
      const r = await window.hub.history.search(searched.query, { keys: searched.scope, limit: HISTORY_PAGE, cursor: searched.nextCursor })
      setSearch((prev) => (prev === searched ? { ...prev, entries: [...prev.entries, ...r.entries], total: r.total, nextCursor: r.nextCursor } : prev))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setMoreLoading(false)
    }
  }

  const resume = async (e: HistoryItem, mode: 'app' | 'console') => {
    // One start at a time: the context menu has no disabled state, so the guard lives here.
    if (opening !== null) return
    // Already open: show it rather than start a second copy of the conversation.
    const live = open.get(historyId(e))
    if (live && mode === 'app') return onOpened(live)
    setError('')
    setOpening(`${e.agentSessionId}:${mode}`)
    try {
      // A past session reopens in the profile that owns its folder, else the active one.
      const owner = owningProfile(e.cwd, profiles, home)?.id ?? profileId
      const view = await window.hub.sessions.start(await resumeInput(owner, e, mode, (key) => readPrefs().models[key], () => window.hub.getDefaultCwd()))
      onOpened(view.id)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setOpening(null)
    }
  }

  const revealFolder = async (folder: string) => {
    if (!(await window.hub.history.revealFolder(folder))) toast(t('history.revealFailed'), 'danger')
  }
  const copyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id)
      toast(t('history.copied'))
    } catch (err) {
      toast(errorText(err), 'danger')
    }
  }

  /** One past session: its row, its resume buttons and its menu. */
  const renderEntry = (e: HistoryItem) => {
    const accountName = e.accountName
    const match: HistoryMatch | undefined = matches.get(historyId(e))
    return (
      <ContextMenu.Root key={`${e.agentId}:${e.agentSessionId}`}>
        <ContextMenu.Trigger asChild>
          <li
            className="flex items-center gap-3 px-3.5 py-2.5 select-none"
            data-testid="history-entry"
            onDoubleClick={() => e.resumable && opening === null && void resume(e, 'app')}
          >
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-base">{titleSnippetFits(match?.titleSnippet, e.title) ? <HistorySnippet text={match.titleSnippet} /> : e.title || t('history.untitled')}</span>
                {open.has(historyId(e)) && (
                  <Badge tone="success" className="h-4 shrink-0" title={t('history.openHint')} data-testid="history-open">
                    {t('history.open')}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-subtle">
                <span>{formatDate(e.lastModified, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                {searching && e.cwd && (
                  <span className="truncate font-mono" title={e.cwd}>
                    {folderName(e.cwd)}
                  </span>
                )}
                {e.gitBranch && e.gitBranch !== 'HEAD' && <span className="truncate font-mono">{e.gitBranch}</span>}
                <Badge icon={<AgentIcon agentId={e.agentId} className="size-4 rounded-sm text-[9px]" />} className="h-5" data-testid="history-agent">
                  {e.agentName}
                </Badge>
                {accountName && (
                  <Badge icon={<UserRound className="size-3" aria-hidden />} className="h-4">
                    {accountName}
                  </Badge>
                )}
              </div>
              {match?.snippet && <HistorySnippet text={match.snippet} className="mt-1 line-clamp-2 text-xs text-muted" />}
            </div>
            {e.resumable && (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={opening === `${e.agentSessionId}:app` ? <Spinner className="size-3" /> : <MessagesSquare className="size-3.5" aria-hidden />}
                  disabled={opening !== null}
                  onClick={() => void resume(e, 'app')}
                >
                  {t('history.resume')}
                </Button>
                {e.consoleResumable !== false && (
                  <IconButton
                    label={t('history.resumeConsole')}
                    icon={opening === `${e.agentSessionId}:console` ? <Spinner className="size-3.5" /> : <SquareTerminal className="size-4" />}
                    disabled={opening !== null}
                    onClick={() => void resume(e, 'console')}
                  />
                )}
              </>
            )}
          </li>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={MENU_CONTENT}>
            {e.resumable && (
              <>
                <ContextMenu.Item className={MENU_ITEM} onSelect={() => void resume(e, 'app')}>
                  {t('history.resumeApp')}
                </ContextMenu.Item>
                {e.consoleResumable !== false && (
                  <ContextMenu.Item className={MENU_ITEM} onSelect={() => void resume(e, 'console')}>
                    {t('history.resumeInConsole')}
                  </ContextMenu.Item>
                )}
                <ContextMenu.Separator className="my-1 h-px bg-border" />
              </>
            )}
            {e.cwd && (
              <ContextMenu.Item className={MENU_ITEM} onSelect={() => void revealFolder(e.cwd!)}>
                {t('history.revealFolder')}
              </ContextMenu.Item>
            )}
            <ContextMenu.Item className={MENU_ITEM} onSelect={() => void copyId(e.agentSessionId)}>
              {t('history.copyId')}
            </ContextMenu.Item>
            <ContextMenu.Item className={MENU_ITEM} onSelect={() => setTagging(e)} data-testid="history-tags">
              {t('tags.edit')}
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    )
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-8 py-6">
      <HistoryToolbar
        query={query}
        onQuery={setQuery}
        agent={agent}
        onAgent={setAgent}
        agents={agents}
        profile={profileFilter}
        onProfile={setProfileFilter}
        profiles={profiles}
        account={account}
        onAccount={setAccount}
        accounts={accounts}
        automations={byAutomation.groups.length > 0 || hideAutomations}
        hideAutomations={hideAutomations}
        onHideAutomations={setHideAutomations}
        loading={loading}
        onRefresh={load}
      />
      <HistoryIndexingNote progress={progress} className="-mt-2" />
      {error && (
        <p role="alert" className="flex items-center gap-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          <CircleAlert className="size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      {result?.errors.map((e) => (
        <p key={e.account} role="alert" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
          {t('history.accountFailed', { account: e.account || t('usage.defaultAccount'), message: e.message })}
        </p>
      ))}
      {!result && loading && (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
          <Spinner className="size-4" />
          {t('history.loading')}
        </div>
      )}
      {result && searching && (
        <section aria-label={t('history.results')} className="flex flex-col gap-1.5" data-testid="history-results">
          <p className="text-xs text-subtle">{searched ? tn('history.resultsNote', searched.total) : t('history.resultsPending')}</p>
          {found.length === 0 && searched ? (
            <div className="py-12">
              <EmptyState icon={<History className="size-6" aria-hidden />} title={t('history.noMatch')} description={t('history.emptyDescription')} />
            </div>
          ) : (
            found.length > 0 && <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">{found.map(renderEntry)}</ul>
          )}
          {searched?.nextCursor && (
            <Button variant="secondary" className="self-center" disabled={moreLoading} onClick={() => void loadMore()} data-testid="history-search-more">
              {tn('history.showMore', searched.total - searched.entries.length)}
            </Button>
          )}
        </section>
      )}
      {result && !searching && groups.length === 0 && automationGroups.length === 0 && (
        <div className="py-12">
          <EmptyState icon={<History className="size-6" aria-hidden />} title={query || agent !== ALL || account !== ALL || hideAutomations || filterProfile ? t('history.noMatch') : t('history.empty')} description={t('history.emptyDescription')} />
        </div>
      )}
      {!searching && automationGroups.length > 0 && (
        <section aria-label={t('history.automations')} className="flex flex-col gap-1.5" data-testid="history-automations">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-muted">
            <Settings className="size-3.5 text-subtle" aria-hidden />
            {t('history.automations')}
          </h2>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
            {automationGroups.map((g) => {
              const isOpen = expanded.has(g.automationId)
              const today = g.entries.filter((e) => e.lastModified >= startOfToday()).length
              return (
                <li key={g.automationId} data-testid="history-automation-group">
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-accent-soft/40"
                    aria-expanded={isOpen}
                    onClick={() => toggleAutomation(g.automationId)}
                  >
                    <ChevronRight className={`size-3.5 shrink-0 text-subtle transition-transform ${isOpen ? 'rotate-90' : ''}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-base">{g.name || t('history.untitled')}</div>
                      <div className="text-xs text-subtle" data-testid="history-automation-summary">
                        {tn('history.automationRuns', g.entries.length, { today })} · {t('history.automationLast', { time: formatDate(g.lastModified, { dateStyle: 'medium', timeStyle: 'short' }) })}
                      </div>
                    </div>
                  </button>
                  {isOpen && <ul className="flex flex-col divide-y divide-border border-t border-border bg-surface-raised/40 pl-6">{g.entries.map(renderEntry)}</ul>}
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {!searching && page.groups.map((g) => (
        <section key={g.folder} aria-label={g.folder || t('history.noFolder')} className="flex flex-col gap-1.5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-muted" title={g.folder}>
            <Folder className="size-3.5 text-subtle" aria-hidden />
            {g.folder ? folderName(g.folder) : t('history.noFolder')}
            <span className="truncate font-mono text-xs font-normal text-subtle">{g.folder}</span>
            <span className="ml-auto text-xs font-normal text-subtle tabular-nums">{g.total}</span>
          </h2>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
            {g.entries.map(renderEntry)}
          </ul>
        </section>
      ))}
      {!searching && page.hidden > 0 && (
        <Button variant="secondary" className="self-center" onClick={() => setLimit((n) => n + HISTORY_PAGE)} data-testid="history-show-more">
          {tn('history.showMore', page.hidden)}
        </Button>
      )}
      {result?.truncated?.length && (searching ? searched && !searched.nextCursor : page.hidden === 0) ? (
        <div className="flex flex-col items-center gap-1.5" data-testid="history-older">
          <p className="text-xs text-subtle">{t('history.truncated')}</p>
          <Button variant="secondary" disabled={loading} onClick={() => void loadOlder()}>
            {t('history.loadOlder')}
          </Button>
        </div>
      ) : null}
      {result && (searching ? found.length > 0 : groups.length > 0) && <p className="text-xs text-subtle">{t('history.doubleClick')}</p>}
      <Dialog
        open={tagging !== null}
        onOpenChange={(open) => !open && setTagging(null)}
        title={tagging?.title ? `${t('tags.dialogTitle')} · ${tagging.title}` : t('tags.dialogTitle')}
        description={t('tags.dialogHint')}
        footer={
          <Button variant="primary" onClick={() => setTagging(null)}>
            {t('tags.done')}
          </Button>
        }
      >
        {tagging && <TagsEditor sessionId={tagging.agentSessionId} />}
      </Dialog>
    </div>
  )
}

/** Epoch ms of today's local midnight, for "N today". */
function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Typing pauses this long before the full-text search runs. */
const SEARCH_DEBOUNCE_MS = 200

interface HistorySearchState {
  query: string
  /** The keys the search was limited to (the filters at the time). */
  scope: string[]
  entries: HistoryMatch[]
  total: number
  nextCursor?: string
}

/** The sessions a search may return: the ones the filters leave, by `agentId:agentSessionId`. */
export function searchScope(entries: readonly HistoryItem[], hideAutomations: boolean): string[] {
  return [...new Set(entries.filter((e) => !hideAutomations || !e.automationId).map((e) => `${e.agentId}:${e.agentSessionId}`))]
}

/** Whether the search should run again for the index's progress: it finished, or indexed a tenth more (at least 20 sessions). */
export function shouldSearchAgain(last: HistoryIndexProgress | null, now: HistoryIndexProgress): boolean {
  if (!last) return false
  if (last.indexing && !now.indexing) return true
  return now.indexed - last.indexed >= Math.max(20, Math.ceil(now.total / 10))
}

/** `value` once it stopped changing for `delayMs`. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return settled
}

/** Rows shown before "Show more". */
export const HISTORY_PAGE = 50

/**
 * The first `limit` rows across the folder groups, in order. `total` keeps each folder's real count
 * for its heading; `hidden` is how many rows stay unrendered.
 */
export function pageGroups<E, G extends { entries: E[] }>(groups: readonly G[], limit: number): { groups: (G & { total: number })[]; hidden: number } {
  const out: (G & { total: number })[] = []
  let left = Math.max(0, limit)
  let hidden = 0
  for (const g of groups) {
    const total = g.entries.length
    if (left >= total) {
      out.push({ ...g, total })
      left -= total
    } else {
      if (left > 0) out.push({ ...g, entries: g.entries.slice(0, left), total })
      hidden += total - left
      left = 0
    }
  }
  return { groups: out, hidden }
}

const MENU_CONTENT = 'z-50 min-w-48 animate-fade-in rounded-md border border-border bg-surface-raised p-1 shadow-lg'
const MENU_ITEM = 'flex h-8 cursor-default select-none items-center rounded-sm px-2 text-base outline-none data-[highlighted]:bg-accent-soft'
