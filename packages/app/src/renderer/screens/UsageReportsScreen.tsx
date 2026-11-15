import { ChartColumn, CircleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Profile } from '@workhub/core'
import type { ReportFilterValues, ReportFilters, ReportSession, SpendPoint, SpendTotals, WeeklyReport } from '@shared/analytics-api'
import { Button, Spinner } from '../components/atoms'
import { Card, CardBody, CardHeader, EmptyState, HelpTip, RefreshButton, StatTile } from '../components/molecules'
import { ShareBars, type ShareRow } from '../components/molecules/ShareBars'
import { ChartLegend, seriesColor, StackedBarChart, type ChartSeries } from '../components/molecules/StackedBarChart'
import { useConfig } from '../configStore'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { errorText } from '../lib/errorText'
import { folderName, formatTokens } from '../lib/home'
import {
  bucketFor,
  bucketStarts,
  chartSeries,
  largestSeries,
  customAdjusted,
  formatActive,
  formatMetric,
  formatUsd,
  freshTokens,
  groupKey,
  groupLabel,
  loadReportState,
  metricValue,
  NONE_KEY,
  OTHER_KEY,
  periodRange,
  saveReportState,
  scanNewTranscripts,
  SessionPager,
  sortTable,
  tablePageTo,
  INITIAL_TABLE,
  sortTotals,
  stackBuckets,
  startOfDay,
  startOfWeek,
  type GroupBy,
  type Names,
  type ReportState,
  type Sort,
  type TableView
} from '../lib/usageReports'
import { clampPage, PAGE_SIZE } from '../components/molecules/Pager'
import { ReportFiltersBar, ReportSessions, ReportTable, WeeklySummaryView } from './usage/ReportParts'

/** What the screen read for the current filters. */
export interface ReportData {
  points: SpendPoint[]
  totals: SpendTotals[]
  /** Every group together (sessions counted once); null when nothing was recorded. */
  overall: SpendTotals | null
  /** The page of sessions on screen. */
  sessions: ReportSession[]
  nextCursor: string | null
  /** Its index, 0-based (0 when absent). */
  sessionsPage?: number
}

/** The filter a group picks: each group filters by its own value (a project by that exact project). */
const FILTER_OF: Record<GroupBy, keyof ReportFilters> = { project: 'project', agent: 'agent', model: 'model', account: 'account', ticket: 'ticket', pr: 'pr', tag: 'tag' }

function useNames(): Names {
  const snap = useConfig()
  return useMemo(
    () => ({
      accounts: new Map((snap?.config.accounts ?? []).map((a) => [a.id, a.name])),
      agents: new Map((snap?.agents ?? []).map((a) => [a.id, a.name])),
      profiles: new Map((snap?.config.profiles ?? []).map((p) => [p.id, p.name]))
    }),
    [snap]
  )
}

/**
 * Usage and reports: tokens, cost and agent time over a period, grouped and filtered, as stacked
 * bars per day (or week), each group's share, a sortable totals table, the sessions behind them
 * and a weekly summary to copy. Filters persist in localStorage.
 */
export function UsageReportsScreen({ profileId: activeProfileId = null, profiles = [], onShowInHistory }: { profileId?: string | null; profiles?: Profile[]; onShowInHistory: (sessionId: string) => void }) {
  // As History: the active profile's work unless "All profiles" is picked (with a single profile, everything).
  const [state, setState] = useState<ReportState>(() => withProfile(loadReportState(), profiles.length > 1 ? activeProfileId : null))
  const switching = useRef(false)
  useEffect(() => {
    if (!switching.current) {
      switching.current = true
      return
    }
    setState((prev) => withProfile(prev, profiles.length > 1 ? activeProfileId : null))
  }, [activeProfileId])
  const [now, setNow] = useState(() => Date.now())
  // A new day moves "today" and "this week": checked every minute and when the window comes back.
  useEffect(() => {
    const tick = () => setNow((prev) => (startOfDay(Date.now()) === startOfDay(prev) ? prev : Date.now()))
    const timer = setInterval(tick, 60_000)
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', tick)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [])
  const [data, setData] = useState<ReportData | null>(null)
  const [values, setValues] = useState<ReportFilterValues | null>(null)
  const [loading, setLoading] = useState(false)
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const pager = useRef<SessionPager | null>(null)
  pager.current ??= new SessionPager((v) => {
    setSessionsLoading(v.loading)
    setData((d) => (d ? { ...d, sessions: v.rows, nextCursor: v.nextCursor, sessionsPage: v.page } : d))
  })
  const [error, setError] = useState('')
  const names = useNames()
  const { t } = useI18n()
  const change = useCallback((patch: Partial<ReportState>) => {
    setState((prev) => {
      const next = { ...prev, ...patch }
      saveReportState(next)
      return next
    })
  }, [])

  const range = periodRange(state, now)
  const bucket = bucketFor(range)
  const filterKey = JSON.stringify(state.filters)
  const seq = useRef(0)
  const [reloads, setReloads] = useState(0)
  // The sessions' own query: the same one read again (Refresh, a tag changed) keeps the page on screen.
  const sessionsKey = `${range.since}|${range.until}|${filterKey}`
  const lastSessionsKey = useRef('')
  const load = useCallback(async () => {
    const id = ++seq.current
    setLoading(true)
    setError('')
    const filters = state.filters
    const sessions = pager.current!
    sessions.cancel()
    const page = sessionsKey === lastSessionsKey.current ? sessions.view.page : 0
    const cursor = page > 0 ? sessions.cursor : null
    try {
      // The list holds the sessions the totals count: those with a turn in the period that matches.
      const [points, totals, overall, sessionsPage] = await Promise.all([
        window.hub.analytics.spend({ ...range, bucket, groupBy: state.groupBy, filters }),
        window.hub.analytics.totals({ ...range, groupBy: state.groupBy, filters }),
        window.hub.analytics.totals({ ...range, groupBy: 'none', filters }),
        window.hub.analytics.sessions({ ...filters, since: range.since, until: range.until, limit: PAGE_SIZE, turnsOnly: true, ...(cursor ? { cursor } : {}) })
      ])
      if (id !== seq.current) return
      lastSessionsKey.current = sessionsKey
      setData({ points, totals, overall: overall[0] && overall[0].turns > 0 ? overall[0] : null, sessions: sessionsPage.rows, nextCursor: sessionsPage.nextCursor, sessionsPage: page })
      sessions.reset(sessionsPage, page)
    } catch (e) {
      if (id === seq.current) setError(errorText(e))
    } finally {
      if (id === seq.current) setLoading(false)
    }
    // The period's bounds stand for `state.period/from/to` and `now`; `reloads` is Refresh.
  }, [range.since, range.until, bucket, state.groupBy, filterKey, reloads])
  useEffect(() => {
    void load()
  }, [load])

  // The menus' values: read on opening, on Refresh and when the profile or the period changes (not
  // with every filter), kept per profile and period. The profile menu always lists every profile.
  const profileId = state.filters.profileId
  const valuesCache = useRef(new Map<string, ReportFilterValues>())
  useEffect(() => {
    const key = `${profileId ?? ''}|${range.since}|${range.until}`
    const cached = valuesCache.current.get(key)
    if (cached) return setValues(cached)
    let alive = true
    window.hub.analytics.filters({ ...(profileId ? { profileId } : {}), since: range.since, until: range.until }).then(
      (v) => {
        if (valuesCache.current.size > 20) valuesCache.current.clear()
        valuesCache.current.set(key, v)
        if (alive) setValues(v)
      },
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [profileId, range.since, range.until, reloads])

  // Previous and next page of sessions, for the report on screen: a reload in the meantime drops the reply.
  const sessionsPageTo = (delta: 1 | -1) => {
    if (loading) return
    const id = seq.current
    const fetch = (cursor: string | null) => window.hub.analytics.sessions({ ...state.filters, since: range.since, until: range.until, limit: PAGE_SIZE, turnsOnly: true, ...(cursor ? { cursor } : {}) })
    const go = delta > 0 ? pager.current!.next(fetch) : pager.current!.prev(fetch)
    go.catch((e) => {
      if (id === seq.current) setError(errorText(e))
    })
  }
  const refresh = () => {
    valuesCache.current.clear()
    setNow(Date.now())
    setReloads((n) => n + 1)
  }
  // Refresh first reads the transcripts written since the last scan, then queries again.
  const [scanning, setScanning] = useState(false)
  const scanAndRefresh = async () => {
    setScanning(true)
    try {
      await scanNewTranscripts(window.hub.analytics)
    } finally {
      setScanning(false)
      refresh()
    }
  }

  // The weekly summary has its own week (this week by default) and follows only the profile filter.
  const thisWeek = startOfWeek(now)
  const [weekStart, setWeekStart] = useState(() => startOfWeek(Date.now()))
  const [week, setWeek] = useState<WeeklyReport | null>(null)
  const [weekLoading, setWeekLoading] = useState(false)
  const [weekError, setWeekError] = useState('')
  useEffect(() => {
    let alive = true
    setWeek(null)
    setWeekError('')
    setWeekLoading(true)
    window.hub.analytics
      .weekly({ weekStart, ...(profileId ? { profileId } : {}) })
      .then(
        (w) => alive && setWeek(w),
        (e) => alive && setWeekError(errorText(e))
      )
      .finally(() => alive && setWeekLoading(false))
    return () => {
      alive = false
    }
  }, [weekStart, profileId, thisWeek, reloads])
  const onWeek = (delta: number) => {
    if (delta === 0) return setWeekStart(thisWeek)
    const d = new Date(weekStart)
    d.setDate(d.getDate() + 7 * delta)
    setWeekStart(Math.min(thisWeek, startOfWeek(d.getTime() + 3_600_000)))
  }

  return (
    <UsageReportsView
      state={state}
      onChange={change}
      range={range}
      data={data}
      values={values}
      loading={loading || scanning}
      error={error}
      names={names}
      effective={customAdjusted(state, now)}
      onRefresh={scanAndRefresh}
      onSessionsPage={sessionsPageTo}
      sessionsLoading={sessionsLoading}
      onOpenSession={(s) => onShowInHistory(s.id)}
      onTagsChanged={refresh}
      weekly={
        <WeeklySummaryView
          week={week}
          loading={weekLoading}
          error={weekError}
          onRetry={() => setReloads((n) => n + 1)}
          weekStart={weekStart}
          isCurrent={weekStart >= thisWeek}
          onWeek={onWeek}
          scope={profileId ? (profiles.find((p) => p.id === profileId)?.name ?? names.profiles?.get(profileId) ?? profileId) : t('reports.all.profileId')}
        />
      }
    />
  )
}

/** The state with its profile filter set to `profileId`, or cleared when null. */
export function withProfile(state: ReportState, profileId: string | null): ReportState {
  const { profileId: _drop, ...rest } = state.filters
  return { ...state, filters: profileId ? { ...rest, profileId } : rest }
}

export interface UsageReportsViewProps {
  state: ReportState
  onChange: (patch: Partial<ReportState>) => void
  range: { since: number; until: number }
  data: ReportData | null
  values: ReportFilterValues | null
  loading: boolean
  error?: string
  names: Names
  onRefresh: () => Promise<unknown>
  /** Previous (-1) or next (1) page of sessions. */
  onSessionsPage: (delta: 1 | -1) => void
  /** A page of sessions is loading. */
  sessionsLoading?: boolean
  onOpenSession: (s: ReportSession) => void
  /** A session's tags changed in the list: the report is read again. */
  onTagsChanged?: () => void
  /** The custom period actually shown, when it differs from the dates typed. */
  effective?: { since: number; until: number } | null
  /** The weekly summary card (its own data). */
  weekly?: React.ReactNode
}

/** The screen without its data loading: what the tests render. */
export function UsageReportsView({ state, onChange, range, data, values, loading, error, names, onRefresh, onSessionsPage, sessionsLoading = false, onOpenSession, onTagsChanged, effective, weekly }: UsageReportsViewProps) {
  const { t, tn, locale, formatDate, formatNumber } = useI18n()
  // The totals table's sort and page: back to the first page with a new sort, grouping or filters.
  const [table, setTable] = useState<TableView>(INITIAL_TABLE)
  const { sort, page: tablePage } = table
  const filterKey = JSON.stringify(state.filters)
  useEffect(() => setTable((prev) => tablePageTo(prev, 0)), [state.groupBy, filterKey])
  const [highlight, setHighlight] = useState<string | null>(null)
  const bucket = bucketFor(range)
  const metric = state.metric
  const groupBy = state.groupBy
  const fmt = (v: number) => formatMetric(v, metric, locale)
  const metricName = t(`reports.metric.${metric}` as MessageKey)
  const groupName = t(`reports.group.${groupBy}` as MessageKey).toLowerCase()

  const totals = data?.totals ?? []
  const series = useMemo(() => chartSeries(totals, metric), [totals, metric])
  const label = (group: string | null) => groupLabel(groupBy, group, t, names)
  const fullLabel = (key: string) => (key === OTHER_KEY || key === NONE_KEY ? label(key) : groupBy === 'project' || groupBy === 'pr' ? key : label(key))
  // Chart legends and share rows are narrow: a folder goes by its name there (its path in the tooltip and the table).
  const shortLabel = (key: string) => (groupBy === 'project' && key !== OTHER_KEY && key !== NONE_KEY ? folderName(key) : label(key))
  const chartSeriesList: ChartSeries[] = series.map((s) => ({ key: s.key, slot: s.slot, label: shortLabel(s.key) }))
  const buckets = useMemo(() => stackBuckets(data?.points ?? [], series, bucketStarts(range, bucket), metric), [data, series, range.since, range.until, bucket, metric])
  const colorOf = (group: string | null) => {
    const s = series.find((x) => x.key === groupKey(group))
    return s ? seriesColor(s.slot) : series.some((x) => x.key === OTHER_KEY) ? seriesColor(0) : null
  }
  const pick = (key: string) => {
    if (key === OTHER_KEY || key === NONE_KEY) return
    onChange({ filters: { ...state.filters, [FILTER_OF[groupBy]]: key } })
  }

  const day = (ms: number) => formatDate(ms, { day: 'numeric', month: 'short' })
  const lastDay = range.until - 1
  const title = t(bucket === 'week' ? 'reports.chart.perWeek' : 'reports.chart.perDay', { metric: metricName })
  const by = t('reports.chart.byGroup', { group: groupName })
  const overall = data?.overall ?? null
  // The period's own total: by ticket, pull request or tag a session can sit in several groups.
  const totalMetric = overall ? metricValue(overall, metric) : 0
  const linked = groupBy === 'ticket' || groupBy === 'pr' || groupBy === 'tag'
  const linkedNote = linked ? <p className="text-xs text-subtle">{t('reports.table.linkedNote', { group: groupName })}</p> : null
  const top = largestSeries(series)
  const summary = top
    ? t('reports.chart.summary', { title, by, from: day(range.since), to: day(lastDay), total: fmt(totalMetric), top: label(top.key), value: fmt(top.total) })
    : t('reports.chart.summaryEmpty', { title, from: day(range.since), to: day(lastDay) })
  // The first week starts on a Monday that can predate the period: it is named by the period's first day.
  const tick = (start: number) => (bucket === 'week' ? day(Math.max(start, range.since)) : buckets.length <= 8 ? formatDate(start, { weekday: 'short', day: 'numeric' }) : day(start))
  const bucketTitle = (start: number) =>
    bucket === 'week' ? t('reports.chart.weekOf', { date: formatDate(Math.max(start, range.since), { day: 'numeric', month: 'long', year: 'numeric' }) }) : formatDate(start, { weekday: 'long', day: 'numeric', month: 'long' })

  // Ranked by the measure shown (the colors stay ranked by tokens).
  const shareRows: ShareRow[] = [...series].sort((a, b) => (a.key === OTHER_KEY ? 1 : b.key === OTHER_KEY ? -1 : b.total - a.total)).map((s) => {
    const row = s.key === OTHER_KEY ? null : totals.find((r) => groupKey(r.group) === s.key)
    return {
      key: s.key,
      slot: s.slot,
      label: shortLabel(s.key),
      fullLabel: fullLabel(s.key),
      value: s.total,
      details: row ? [`${formatTokens(freshTokens(row), locale)} ${t('reports.metric.tokens').toLowerCase()} · ${formatUsd(row.usd, locale)} · ${formatActive(row.activeMs)}`, tn('reports.sessions.turns', row.turns)] : undefined
    }
  })
  const rows = useMemo(() => sortTotals(totals, sort, label), [totals, sort, groupBy, names])
  const filtered = Object.keys(state.filters).length > 0
  const empty = data !== null && overall === null

  return (
    <div className="@container">
      <div className="flex max-w-[1240px] flex-col gap-4 px-6 pt-5 pb-6" data-testid="usage-reports">
        <header className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              {t('nav.usage')}
              <HelpTip text={t('reports.help')} label={t('nav.usage')} />
            </h1>
          </div>
          <RefreshButton size="md" iconClassName="size-4" label={t('reports.refresh')} loading={loading} onRefresh={onRefresh} />
        </header>

        <ReportFiltersBar state={state} values={values} names={names} onChange={onChange} effective={effective} />

        {error && data !== null && (
          <p role="alert" className="flex items-center gap-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            <CircleAlert className="size-4 shrink-0" aria-hidden />
            {error}
          </p>
        )}

        {data === null && error ? (
          <Card data-testid="report-error">
            <EmptyState
              icon={<CircleAlert className="size-6" aria-hidden />}
              title={t('reports.error.title')}
              description={error}
              action={
                <Button size="sm" variant="secondary" onClick={() => void onRefresh()} disabled={loading}>
                  {t('reports.retry')}
                </Button>
              }
              className="py-12"
            />
          </Card>
        ) : data === null ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted" data-testid="report-loading">
            <Spinner className="size-4" />
            {t('reports.loading')}
          </div>
        ) : empty ? (
          <>
            <Card>
              <EmptyState icon={<ChartColumn className="size-6" aria-hidden />} title={filtered ? t('reports.empty.filtered') : t('reports.empty.title')} description={t('reports.empty.description')} className="py-12" />
            </Card>
            {weekly}
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 @min-[760px]:grid-cols-4" data-testid="report-tiles">
              <StatTile
                label={t('reports.tile.tokens')}
                value={formatTokens(freshTokens(overall!), locale)}
                caption={t('reports.tile.tokensCaption', {
                  input: formatTokens(overall!.tokensIn, locale),
                  output: formatTokens(overall!.tokensOut, locale),
                  writes: formatTokens(overall!.cacheWrite, locale),
                  reads: formatTokens(overall!.cacheRead, locale)
                })}
              />
              <StatTile label={t('reports.tile.usd')} value={formatUsd(overall!.usd, locale)} caption={t('reports.tile.usdCaption')} />
              <StatTile label={t('reports.tile.active')} value={formatActive(overall!.activeMs)} caption={t('reports.tile.activeCaption')} />
              <StatTile label={t('reports.tile.sessions')} value={formatNumber(overall!.sessions)} caption={tn('reports.tile.sessionsCaption', overall!.turns)} />
            </div>

            <div className="grid grid-cols-1 items-start gap-3 @min-[1000px]:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
              <Card aria-label={title}>
                <CardHeader title={title} meta={by} actions={loading ? <Spinner className="size-3.5" /> : undefined} />
                <CardBody className="flex flex-col gap-2">
                  <StackedBarChart
                    buckets={buckets}
                    series={chartSeriesList}
                    tick={tick}
                    title={bucketTitle}
                    format={fmt}
                    summary={summary}
                    tableCaption={t('reports.chart.tableCaption', { title, by })}
                    bucketHeader={t(bucket === 'week' ? 'reports.chart.week' : 'reports.chart.day')}
                    totalLabel={t('reports.chart.total')}
                    highlight={highlight}
                  />
                  <ChartLegend series={chartSeriesList} onHighlight={setHighlight} onPick={pick} pickHint={t('reports.pickHint')} />
                  {linkedNote}
                </CardBody>
              </Card>
              <Card aria-label={t('reports.share.title', { group: groupName })}>
                <CardHeader title={t('reports.share.title', { group: groupName })} meta={metricName} />
                <CardBody className="flex flex-col gap-2">
                  <ShareBars
                    rows={shareRows}
                    total={totalMetric}
                    format={fmt}
                    formatPercent={(f) => formatNumber(f, { style: 'percent', maximumFractionDigits: f > 0 && f < 0.01 ? 1 : 0 })}
                    label={t('reports.share.title', { group: groupName })}
                    onPick={pick}
                    pickHint={t('reports.pickHint')}
                    onHighlight={setHighlight}
                    highlight={highlight}
                  />
                  {linkedNote}
                </CardBody>
              </Card>
            </div>

            <Card aria-label={t('reports.table.title', { group: groupName })}>
              <CardHeader title={t('reports.table.title', { group: groupName })} />
              <CardBody>
                <ReportTable
                  rows={rows}
                  overall={overall}
                  groupBy={groupBy}
                  sort={sort}
                  onSort={(next) => setTable((prev) => sortTable(prev, next))}
                  page={clampPage(tablePage, rows.length)}
                  onPage={(page) => setTable((prev) => tablePageTo(prev, page))}
                  label={(g) => ({ text: label(g), title: g === null ? undefined : fullLabel(g) })}
                  colors={colorOf}
                />
              </CardBody>
            </Card>

            <div className="grid grid-cols-1 items-start gap-3 @min-[1000px]:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
              <Card aria-label={t('reports.sessions.title')}>
                <CardHeader title={t('reports.sessions.title')} meta={formatNumber(overall!.sessions)} />
                <CardBody>
                  <ReportSessions
                    sessions={data.sessions}
                    names={names}
                    loading={loading}
                    page={data.sessionsPage ?? 0}
                    total={overall!.sessions}
                    hasNext={data.nextCursor !== null}
                    pageLoading={sessionsLoading}
                    onPage={onSessionsPage}
                    onTagsChanged={onTagsChanged ? () => onTagsChanged() : undefined}
                    onOpen={onOpenSession}
                  />
                </CardBody>
              </Card>
              {weekly}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
