import { Search, Star } from 'lucide-react'
import { formatMs, type FlowMap } from '@workhub/core'
import type { FlowMapState, FlowMapSummary } from '@shared/health-api'
import { Input, StateDot } from '../../components/atoms'
import type { Tone } from '../../components/atoms/Badge'
import { Sparkline } from '../../components/molecules/Sparkline'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { splitFlowFavorites, type FlowMapDigest, type FlowStanding, type FlowTone } from '../../lib/flowMapCards'
import { FlowMiniMap } from './FlowMiniMap'
import { StandingBadge } from './FlowSplitParts'

export interface FlowMapGroup {
  /** The map's `group`, or null for the maps without one (listed last). */
  name: string | null
  maps: FlowMapSummary[]
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/**
 * The maps under their headings, headings and maps by name; `query` keeps the maps whose name,
 * group, description or id contains every word of it (accents and case ignored).
 */
export function groupFlowMaps(maps: readonly FlowMapSummary[], query = ''): FlowMapGroup[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  const matches = (m: FlowMapSummary) => {
    const text = fold([m.name, m.group ?? '', m.description ?? '', m.id].join(' '))
    return words.every((w) => text.includes(w))
  }
  const byGroup = new Map<string | null, FlowMapSummary[]>()
  for (const m of maps) {
    if (!matches(m)) continue
    const key = m.group?.trim() || null
    byGroup.set(key, [...(byGroup.get(key) ?? []), m])
  }
  const named = [...byGroup.keys()].filter((k): k is string => k !== null).sort((a, b) => a.localeCompare(b))
  const order: (string | null)[] = byGroup.has(null) ? [...named, null] : named
  return order.map((name) => ({ name, maps: [...byGroup.get(name)!].sort((a, b) => a.name.localeCompare(b.name)) }))
}

const STATE_TONE: Record<FlowMapState, Tone> = { ok: 'success', alert: 'danger', unknown: 'neutral' }

/** What a card draws beyond the map's name: its picture and the flow's own numbers, as they come in. */
export interface FlowMapCardDetail {
  /** The parsed map, for the small picture. */
  map?: FlowMap
  /** The flow's numbers over the last stored day; null when nothing is stored yet. */
  digest?: FlowMapDigest | null
  /** The parts over their limits in the last stored hour, keyed `nodes:<id>` or `edges:<id>`. */
  over?: ReadonlySet<string>
  /** How the flow stands over that day, as a word on the card; nothing while it has no numbers. */
  standing?: FlowStanding | null
}

const NUMBER_TONE: Record<FlowTone, string> = { ok: '', warn: 'text-warning', bad: 'text-danger' }
const TREND_TONE: Record<FlowTone, string> = { ok: 'text-success', warn: 'text-warning', bad: 'text-danger' }

export interface FlowMapListProps {
  maps: readonly FlowMapSummary[]
  states: Record<string, FlowMapState>
  /** Parts over their limits in the last stored hour, by map id (only the maps that have some). */
  alerts?: Record<string, number>
  /** The picture and numbers of each map, by map id; a map without an entry shows its name and state only. */
  details?: Record<string, FlowMapCardDetail>
  /** The starred maps (ids), listed first under Favorites. */
  favorites?: readonly string[]
  /** Stars or unstars a map; without it the cards have no star. */
  onFavorite?: (id: string) => void
  /** Only the starred maps are listed. */
  onlyFavorites?: boolean
  opened: string | null
  query: string
  onQuery: (query: string) => void
  onOpen: (id: string) => void
}

const HEADING = 'px-1 text-[11px] font-medium uppercase tracking-wide text-muted'

/**
 * The side list of the Flow maps screen: a search box and one card per map, the starred ones first
 * and the rest under their headings. A card carries the map's state (no dot while nothing fresh is
 * known), how many parts are over their limits, a small picture of the flow and its own numbers.
 */
export function FlowMapList({ maps, states, alerts = {}, details = {}, favorites = [], onFavorite, onlyFavorites = false, opened, query, onQuery, onOpen }: FlowMapListProps) {
  const { t, tn } = useI18n()
  const matching = groupFlowMaps(maps, query).flatMap((g) => g.maps)
  const { starred, rest } = splitFlowFavorites(matching, favorites)
  const groups = onlyFavorites ? [] : groupFlowMaps(rest)
  const card = (m: FlowMapSummary) => {
    const state = states[m.id] ?? 'unknown'
    const over = m.error ? 0 : (alerts[m.id] ?? 0)
    const detail = m.error ? undefined : details[m.id]
    const digest = detail?.digest
    const standing = detail?.standing ?? null
    const tone = standing?.tone ?? (state === 'alert' ? 'bad' : 'ok')
    const isFavorite = favorites.includes(m.id)
    const starLabel = t(isFavorite ? 'flowMaps.card.unstar' : 'flowMaps.card.star', { name: m.name })
    return (
      <li key={m.id} className="group/map relative">
        <button
          type="button"
          disabled={Boolean(m.error)}
          aria-current={opened === m.id ? 'true' : undefined}
          title={m.error ? t('flowMaps.invalid', { error: m.error }) : m.description ?? m.file}
          onClick={() => onOpen(m.id)}
          className={cn(
            'flex w-full flex-col gap-2 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors',
            m.error ? 'border-danger/40 text-danger' : opened === m.id ? 'border-accent bg-surface-raised ring-1 ring-accent' : 'border-border bg-surface hover:bg-surface-hover'
          )}
        >
          <span className={cn('flex w-full items-center gap-2', onFavorite && 'pl-6')}>
            <span className="min-w-0 flex-1 truncate font-semibold">{m.name}</span>
            {over > 0 && (
              <span className="shrink-0 rounded-full bg-danger-soft px-1.5 text-[11px] font-medium tabular-nums text-danger" title={tn('flowMaps.list.over', over)} data-testid="flow-map-over">
                {over}
              </span>
            )}
            {standing ? <StandingBadge standing={standing} className="shrink-0" /> : m.error || state !== 'unknown' ? <StateDot tone={m.error ? 'danger' : STATE_TONE[state]} /> : <span aria-hidden className="inline-flex size-2 shrink-0" data-testid="flow-map-no-state" />}
            <span className="sr-only">{m.error ? t('flowMaps.invalidShort') : t(`flowMaps.state.${state}`)}{over > 0 ? ` · ${tn('flowMaps.list.over', over)}` : ''}</span>
          </span>
          {detail?.map && <FlowMiniMap map={detail.map} over={detail.over} />}
          {digest && (
            <span className="flex w-full items-end gap-3 text-xs" data-testid="flow-map-numbers">
              <span className="whitespace-nowrap">
                <span className="text-muted">p95 </span>
                <span className={cn('text-[15px] font-semibold tabular-nums', standing?.label !== 'errors' && NUMBER_TONE[tone])}>{formatMs(digest.p95Ms)}</span>
              </span>
              {digest.errorRate !== undefined && (
                <span className="whitespace-nowrap">
                  <span className="text-muted">{t('flowMaps.card.errors')} </span>
                  <span className={cn('font-semibold tabular-nums', standing?.label === 'errors' && NUMBER_TONE[standing.tone])}>{`${(digest.errorRate * 100).toFixed(1)} %`}</span>
                </span>
              )}
              <span className="flex-1" />
              <Sparkline values={digest.hourly} label={t('flowMaps.card.trend', { name: m.name })} width={76} height={26} className={TREND_TONE[tone]} />
            </span>
          )}
          {digest === null && <span className="text-xs text-subtle">{t('flowMaps.card.noNumbers')}</span>}
        </button>
        {onFavorite && !m.error && (
          <button
            type="button"
            aria-pressed={isFavorite}
            aria-label={starLabel}
            title={starLabel}
            onClick={() => onFavorite(m.id)}
            className={cn(
              'absolute left-2 top-2 inline-flex size-6 items-center justify-center rounded-sm hover:bg-surface-hover focus-visible:opacity-100',
              isFavorite ? 'text-warning' : 'text-subtle opacity-60 group-hover/map:opacity-100'
            )}
            data-testid="flow-map-star"
          >
            <Star className={cn('size-3.5', isFavorite && 'fill-current')} aria-hidden />
          </button>
        )}
      </li>
    )
  }
  return (
    <nav aria-label={t('flowMaps.maps')} className="flex w-[300px] shrink-0 flex-col gap-2.5" data-testid="flow-map-list">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
        <Input value={query} onChange={(e) => onQuery(e.target.value)} placeholder={t('flowMaps.search')} aria-label={t('flowMaps.search')} className="pl-7" />
      </div>
      {matching.length === 0 && <p className="px-1 text-xs text-muted">{t('flowMaps.noMatch')}</p>}
      {onlyFavorites && matching.length > 0 && starred.length === 0 && <p className="px-1 text-xs text-muted" data-testid="flow-map-no-favorites">{t('flowMaps.noFavorites')}</p>}
      <div className="flex max-h-[calc(100vh-11rem)] flex-col gap-3.5 overflow-y-auto pr-1">
        {starred.length > 0 && (
          <section className="flex flex-col gap-2" data-testid="flow-map-favorites">
            <h3 className={HEADING}>{t('flowMaps.favorites')}</h3>
            <ul className="flex flex-col gap-2">{starred.map(card)}</ul>
          </section>
        )}
        {groups.map((g) => (
          <section key={g.name ?? ''} className="flex flex-col gap-2">
            <h3 className={HEADING}>{g.name ?? t('flowMaps.ungrouped')}</h3>
            <ul className="flex flex-col gap-2">{g.maps.map(card)}</ul>
          </section>
        ))}
      </div>
    </nav>
  )
}
