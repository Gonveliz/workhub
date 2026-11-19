import { Route, RotateCcw, Settings, Star } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { flowAlertsOf, moduleScreens, type FlowMap, type Profile } from '@workhub/core'
import type { FlowMapState, FlowMapSummary, HealthEnvironmentView } from '@shared/health-api'
import { Badge, Button, Spinner, StateDot } from '../../components/atoms'
import { EmptyState } from '../../components/molecules'
import { useHealth } from '../../healthStore'
import { useI18n } from '../../i18n/I18nProvider'
import { errorText } from '../../lib/errorText'
import { cn } from '../../lib/cn'
import { flowMapDigest, flowMapStanding, splitFlowFavorites, toggleFlowFavorite, type FlowMapDigest, type FlowStanding } from '../../lib/flowMapCards'
import { HEALTH_LABEL, HEALTH_TONE } from '../../lib/health'
import { setPrefs, usePrefs } from '../../lib/prefs'
import { FlowMapList, groupFlowMaps, type FlowMapCardDetail } from './FlowMapList'
import { FlowMapView, type FlowMenuItem } from './FlowMapView'
import { Segmented } from './Segmented'

export interface FlowMapsScreenProps {
  profile: Profile | undefined
  onOpenSettings: (tab?: string) => void
  /** Opens a new Claude session with the draft in its composer; it is never sent. */
  onInvestigate: (draft: string, folder: string | undefined) => Promise<void> | void
}

/**
 * Flow maps (⌘7): one header row (title, the environments of the active profile, Reload and
 * Settings), the stored maps for the chosen environment as a column of cards (the starred ones
 * first), and the opened map beside it. Without Health the maps are still listed and drawn,
 * without numbers.
 */
export function FlowMapsScreen({ profile, onOpenSettings, onInvestigate }: FlowMapsScreenProps) {
  const { t } = useI18n()
  const modules = profile ? moduleScreens(profile.modules) : []
  const enabled = modules.includes('flowMaps')
  const healthOn = modules.includes('health')
  const { view, loading, error, refresh } = useHealth(profile?.id, enabled && healthOn)
  const [selected, setSelected] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)
  // Remembered, so the screen comes back as it was left.
  const onlyFavorites = usePrefs().flowMapsFavoritesOnly
  const setOnlyFavorites = (only: boolean) => setPrefs({ flowMapsFavoritesOnly: only })
  // The opened map puts its window, refresh and menu here, so the header is one row of controls.
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null)
  const environments = enabled && healthOn ? (view?.environments ?? []) : []
  const current = environments.find((e) => e.id === selected) ?? environments[0]
  useEffect(() => {
    if (selected && !environments.some((e) => e.id === selected)) setSelected(null)
  }, [selected, environments])

  const ready = view?.state === 'ready' || view?.state === 'demo'
  // Health off, or on but not usable yet: the maps are drawn without numbers.
  const healthOff = enabled && (!healthOn || (view !== undefined && view !== null && (!ready || environments.length === 0)))

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-3 px-6 py-5">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-[22px] font-semibold tracking-tight">{t('nav.flowMaps')}</h1>
        {current && (
          <Segmented
            tabs
            label={t('flowMaps.environments')}
            value={current.id}
            onChange={setSelected}
            options={environments.map((e) => ({ value: e.id, label: e.name, icon: <StateDot tone={HEALTH_TONE[e.snapshot.state]} />, tooltip: t(HEALTH_LABEL[e.snapshot.state]) }))}
          />
        )}
        {healthOff && <Badge tone="warning">{t('flowMaps.healthOff.badge')}</Badge>}
        {view?.state === 'demo' && <Badge tone="info">{t('health.demo')}</Badge>}
        <span className="flex-1" />
        {enabled && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-pressed={onlyFavorites}
              onClick={() => setOnlyFavorites(!onlyFavorites)}
              className={cn('inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors', onlyFavorites ? 'border-accent bg-accent-soft text-text' : 'border-border-strong text-muted hover:text-text')}
              data-testid="flow-only-favorites"
            >
              <Star className={cn('size-3', onlyFavorites ? 'fill-current text-warning' : 'fill-current')} aria-hidden />
              {t('flowMaps.onlyFavorites')}
            </button>
            <div ref={setToolbar} className="flex items-center gap-1.5" data-testid="flow-toolbar" />
          </div>
        )}
      </header>

      {error && healthOn && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3">
          <p className="min-w-0 flex-1 break-words text-sm text-danger">{t('health.loadFailed', { message: error })}</p>
          <Button size="sm" icon={loading ? <Spinner /> : <RotateCcw className="size-3.5" aria-hidden />} disabled={loading} onClick={() => void refresh()}>
            {t('health.retry')}
          </Button>
        </div>
      )}

      {enabled && healthOn && !view && !error && (
        <p className="flex items-center gap-2 py-10 text-sm text-muted" role="status">
          <Spinner /> {t('health.loading')}
        </p>
      )}

      {!enabled && (
        <EmptyState
          icon={<Route className="size-6" aria-hidden />}
          title={t('flowMaps.status.moduleOff.title')}
          description={`${t('flowMaps.subtitle')} ${t('flowMaps.status.moduleOff.hint')}`}
          action={
            <Button variant="primary" onClick={() => onOpenSettings('flowMaps')}>
              {t('flowMaps.openSettings')}
            </Button>
          }
        />
      )}

      {(current || healthOff) && (
        <MapsForEnvironment key={current?.id ?? ''} env={current ?? null} demo={view?.state === 'demo'} reloads={reloads} onReload={() => setReloads((n) => n + 1)} onlyFavorites={onlyFavorites} toolbar={toolbar} profileId={profile?.id ?? null} onInvestigate={onInvestigate} onOpenSettings={onOpenSettings} />
      )}
    </div>
  )
}

/** The hours a card's numbers and trend cover. */
const CARD_HOURS = 24

/** The maps that name this environment (or none; all of them without Health): the column of cards, and the one opened next to it. */
function MapsForEnvironment({
  env,
  demo,
  reloads,
  onReload,
  onlyFavorites,
  toolbar,
  profileId,
  onInvestigate,
  onOpenSettings
}: {
  env: HealthEnvironmentView | null
  demo: boolean
  reloads: number
  /** Reads the stored maps and the opened map again. */
  onReload: () => void
  onlyFavorites: boolean
  /** The header's slot for the opened map's controls. */
  toolbar: HTMLElement | null
  profileId: string | null
  onInvestigate: FlowMapsScreenProps['onInvestigate']
  onOpenSettings: (tab?: string) => void
}) {
  const { t } = useI18n()
  const [maps, setMaps] = useState<FlowMapSummary[] | null>(null)
  const [states, setStates] = useState<Record<string, FlowMapState>>({})
  const [over, setOver] = useState<Record<string, ReadonlySet<string>>>({})
  const [cards, setCards] = useState<Record<string, { map?: FlowMap; digest?: FlowMapDigest | null; standing?: FlowStanding | null }>>({})
  const favorites = usePrefs().favoriteFlowMaps
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  useEffect(() => {
    let alive = true
    window.hub.health
      .flowMaps(profileId)
      .then((m) => {
        if (!alive) return
        setMaps(m)
        setError(undefined)
      })
      .catch((e: unknown) => alive && setError(errorText(e)))
    if (!env) return () => void (alive = false)
    // The dots and counts come from the stored history only: listing the maps never reads the cluster.
    window.hub.health
      .flowMapStates(profileId, env.id)
      .then(async (s) => {
        if (!alive) return
        setStates(s)
        const parts: Record<string, ReadonlySet<string>> = {}
        await Promise.all(
          Object.entries(s)
            .filter(([, state]) => state === 'alert')
            .map(async ([id]) => {
              const r = await window.hub.health.flowMap(profileId, env.id, id, 1, false, true).catch(() => null)
              if (r?.ok && r.reading) parts[id] = new Set(flowAlertsOf(r.map, r.reading, env).map((a) => `${a.part.of}:${a.part.key}`))
            })
        )
        if (alive) setOver(parts)
      })
      .catch(() => alive && setStates({}))
    return () => void (alive = false)
  }, [profileId, env?.id, reloads]) // eslint-disable-line react-hooks/exhaustive-deps
  const listed = useMemo(() => (maps ?? []).filter((m) => !env || !m.environmentId || m.environmentId === env.id), [maps, env?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // The cards' picture and numbers: the stored day of each map (never the cluster; the demo's numbers are
  // made up on the spot, so they are simply asked for), or the map alone without Health.
  useEffect(() => {
    let alive = true
    const valid = listed.filter((m) => !m.error)
    void Promise.all(
      valid.map(async (m) => {
        if (!env) {
          const map = await window.hub.flowMaps.get(m.id).catch(() => null)
          return [m.id, map ? { map } : {}] as const
        }
        const r = await window.hub.health.flowMap(profileId, env.id, m.id, CARD_HOURS, false, !demo).catch(() => null)
        return [m.id, r?.ok ? { map: r.map, digest: flowMapDigest(r.map, r.reading), standing: flowMapStanding(r.map, r.reading) } : {}] as const
      })
    ).then((entries) => alive && setCards(Object.fromEntries(entries)))
    return () => void (alive = false)
  }, [listed, profileId, env?.id, demo, reloads]) // eslint-disable-line react-hooks/exhaustive-deps
  const alerts = useMemo(() => Object.fromEntries(Object.entries(over).map(([id, parts]) => [id, parts.size])), [over])
  const details = useMemo(() => {
    const out: Record<string, FlowMapCardDetail> = {}
    for (const [id, c] of Object.entries(cards)) out[id] = { ...c, ...(over[id] ? { over: over[id] } : {}) }
    return out
  }, [cards, over])
  // One map opens by itself; otherwise the one picked, or the first valid one in the list's order (the starred ones first).
  const { starred, rest } = splitFlowFavorites(listed, favorites)
  const first = [...starred, ...(onlyFavorites ? [] : groupFlowMaps(rest).flatMap((g) => g.maps))].find((m) => !m.error)
  const menuExtra: FlowMenuItem[] = [
    { key: 'reload', label: t('flowMaps.reload'), icon: <RotateCcw className="size-3.5" aria-hidden />, onSelect: onReload },
    { key: 'settings', label: t('flowMaps.settingsButton'), icon: <Settings className="size-3.5" aria-hidden />, onSelect: () => onOpenSettings('flowMaps') }
  ]
  const opened = open ?? first?.id ?? null
  const current = listed.find((m) => m.id === opened)
  return (
    <div className="flex flex-col gap-3" data-testid="flow-maps">
      {/* Without an opened map nothing fills the header's slot: Reload and Settings go there themselves. */}
      {toolbar && !(current && !current.error) && createPortal(
        <>
          <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" aria-hidden />} onClick={onReload}>
            {t('flowMaps.reload')}
          </Button>
          <Button size="sm" variant="ghost" icon={<Settings className="size-3.5" aria-hidden />} onClick={() => onOpenSettings('flowMaps')}>
            {t('flowMaps.settingsButton')}
          </Button>
        </>,
        toolbar
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      {maps && listed.length === 0 && (
        <EmptyState
          compact
          icon={<Route className="size-5" aria-hidden />}
          title={t('flowMaps.noMaps')}
          description={`${t('flowMaps.subtitle')} ${t('flowMaps.empty')}`}
          action={<Button onClick={() => onOpenSettings('flowMaps')}>{t('flowMaps.openSettings')}</Button>}
        />
      )}
      {listed.length > 0 && (
        <div className="flex items-start gap-4">
          <FlowMapList
            maps={listed}
            states={states}
            alerts={alerts}
            details={details}
            favorites={favorites}
            onFavorite={(id) => setPrefs({ favoriteFlowMaps: toggleFlowFavorite(favorites, id) })}
            onlyFavorites={onlyFavorites}
            opened={opened}
            query={query}
            onQuery={setQuery}
            onOpen={setOpen}
          />
          <div className="min-w-0 flex-1">
            {current && !current.error && (
              <FlowMapView
                key={`${env?.id ?? ''}:${current.id}:${reloads}`}
                env={env}
                profileId={profileId}
                mapId={current.id}
                file={current.file}
                layout="split"
                toolbar={toolbar}
                menuExtra={menuExtra}
                favorite={favorites.includes(current.id)}
                onFavorite={() => setPrefs({ favoriteFlowMaps: toggleFlowFavorite(favorites, current.id) })}
                onOpenSettings={onOpenSettings}
                onAsk={(draft, folder) => void onInvestigate(draft, folder)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
