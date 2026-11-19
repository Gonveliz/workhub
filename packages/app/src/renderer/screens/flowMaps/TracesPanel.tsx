import { ChevronDown, ChevronRight, RotateCcw, Sparkles, Waypoints } from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { FLOW_TRACE_SORTS, flowPartLabel, formatMs, type FlowMap, type FlowPartRef, type FlowTrace, type FlowTraceHop, type FlowTraceLog, type FlowTraceSort, type FlowTraceSummary } from '@workhub/core'
import type { FlowTraceLogsResult, FlowTraceResult, FlowTracesResult } from '@shared/health-api'
import { Badge, Button, IconButton, Spinner } from '../../components/atoms'
import { CopyButton } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/errorText'
import { pressable } from '../../lib/pressable'
import { useRowAnchor } from '../../lib/rowAnchor'
import { Segmented } from './Segmented'

export interface TracesPanelProps {
  map: FlowMap
  hours: number
  list: (sort: FlowTraceSort) => Promise<FlowTracesResult>
  selectedId: string | null
  /** The selected execution once read; null while none is selected, `{ ok: false }` when it failed. */
  selected: FlowTraceResult | null
  loadingTrace: boolean
  /** The selected execution's APM errors and log lines (the view holds them: the Claude draft uses them too). */
  logs?: FlowTraceLogsResult | null
  loadingLogs?: boolean
  onSelect: (traceId: string | null) => void
  picked: FlowPartRef | null
  onPick: (p: FlowPartRef | null) => void
  /** The flow's p95 over the window, marked on every duration bar; no mark without it. */
  usualMs?: number
  /** "Investigate": the Claude draft with the open execution. */
  onAsk?: () => void
  /** Brings the diagram into view, where the open execution is laid over the map. */
  onShowOnMap?: () => void
}

/**
 * The real executions of the flow as one table (latest, slowest or only failed): how long each
 * took as a bar, and how it ended. A row opens under itself with what happened in that execution.
 */
export function TracesPanel({ map, hours, list, selectedId, selected, loadingTrace, logs = null, loadingLogs = false, onSelect, picked, onPick, usualMs, onAsk, onShowOnMap }: TracesPanelProps) {
  const { t, tn } = useI18n()
  const [sort, setSort] = useState<FlowTraceSort>('latest')
  const [traces, setTraces] = useState<FlowTraceSummary[] | null>(null)
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const load = () => {
    setLoading(true)
    list(sort)
      .then((r) => {
        if (r.ok) {
          setTraces(r.traces)
          setError(undefined)
        } else {
          setTraces([])
          setError(r.error)
        }
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setLoading(false))
  }
  useEffect(() => void load(), [sort, hours]) // eslint-disable-line react-hooks/exhaustive-deps
  const failed = traces?.filter((x) => x.outcome === 'failure').length ?? 0
  return (
    <div className="flex flex-col gap-2.5" data-testid="flow-traces">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Segmented label={t('flowMaps.traces.title')} value={sort} onChange={setSort} options={FLOW_TRACE_SORTS.map((s) => ({ value: s, label: t(`flowMaps.traces.sort.${s}`) }))} />
        {traces && traces.length > 0 && (
          <span className="text-xs text-muted" data-testid="flow-traces-summary">
            {tn('flowMaps.exec.count', traces.length)} · {t('flowMaps.exec.window', { hours })}
            {failed > 0 && ` · ${tn('flowMaps.exec.failedCount', failed)}`}
          </span>
        )}
        <span className="flex-1" />
        {usualMs !== undefined && traces && traces.length > 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <span className="inline-block h-3 w-px bg-muted" aria-hidden />
            {t('flowMaps.exec.usualMark', { value: formatMs(usualMs) })}
          </span>
        )}
        <IconButton size="sm" label={t('flowMaps.reload')} icon={loading ? <Spinner /> : <RotateCcw className="size-3.5" aria-hidden />} disabled={loading} onClick={load} />
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {!traces && !error && <p className="flex items-center gap-2 text-sm text-muted"><Spinner /> {t('flowMaps.traces.loading')}</p>}
      {traces && traces.length === 0 && !error && <p className="text-sm text-muted">{t('flowMaps.traces.empty')}</p>}
      {traces && traces.length > 0 && (
        <ExecutionList
          traces={traces}
          selectedId={selectedId}
          onSelect={onSelect}
          usualMs={usualMs}
          detail={() => (
            <>
              {loadingTrace && <p className="flex items-center gap-2 text-sm text-muted"><Spinner /> {t('flowMaps.traces.reading')}</p>}
              {!loadingTrace && selected && !selected.ok && <p className="text-sm text-danger">{selected.error}</p>}
              {!loadingTrace && selected?.ok && <TraceDetail map={map} trace={selected.trace} logs={logs} loadingLogs={loadingLogs} picked={picked} onPick={onPick} onAsk={onAsk} onShowOnMap={onShowOnMap} />}
            </>
          )}
        />
      )}
    </div>
  )
}

const OUTCOME_TONE = { success: 'success', failure: 'danger', unknown: 'neutral' } as const

/**
 * The executions as rows: when, how long (a bar against the slowest of the list, with a mark at
 * the flow's p95: amber past it, red when the execution failed) and how it ended. The selected
 * row is open and shows `detail` under itself; pressing it again closes it.
 */
export function ExecutionList({ traces, selectedId, onSelect, usualMs, detail }: { traces: readonly FlowTraceSummary[]; selectedId: string | null; onSelect: (traceId: string | null) => void; usualMs?: number; detail: () => React.ReactNode }) {
  const { t, locale } = useI18n()
  const anchor = useRowAnchor(selectedId ?? '')
  const when = (at: number) => new Date(at).toLocaleString(locale, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const longest = Math.max(1, usualMs ?? 0, ...traces.map((x) => x.durationMs))
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <table className="w-full text-xs" data-testid="flow-executions">
        <thead className="bg-surface text-left text-muted">
          <tr>
            <th className="w-40 px-3 py-1.5 font-medium">{t('flowMaps.traces.when')}</th>
            <th className="px-3 py-1.5 font-medium">{t('flowMaps.traces.duration')}</th>
            <th className="w-24 px-3 py-1.5 font-medium">{t('flowMaps.traces.outcome')}</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {traces.map((tr) => {
            const open = tr.traceId === selectedId
            const failed = tr.outcome === 'failure'
            const slow = usualMs !== undefined && tr.durationMs > usualMs
            return (
              <Fragment key={tr.traceId}>
                <tr
                  ref={anchor.ref(tr.traceId)}
                  className={cn('cursor-pointer border-t border-border hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none', open && 'bg-accent-soft')}
                  title={tr.traceId}
                  aria-expanded={open}
                  {...pressable(
                    () => {
                      anchor.mark(tr.traceId)
                      onSelect(open ? null : tr.traceId)
                    },
                    { pressed: open }
                  )}
                >
                  <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">{when(tr.at)}</td>
                  <td className="px-3 py-1.5">
                    <span className="flex items-center gap-2.5">
                      <span className="relative h-2 w-full max-w-72 rounded-full bg-border" aria-hidden>
                        <span className={cn('absolute inset-y-0 left-0 rounded-full', failed ? 'bg-danger' : slow ? 'bg-warning' : 'bg-accent')} style={{ width: `${Math.max(1, (tr.durationMs / longest) * 100)}%` }} />
                        {usualMs !== undefined && <span className="absolute -inset-y-1 w-px bg-muted" style={{ left: `${(usualMs / longest) * 100}%` }} data-testid="flow-execution-mark" />}
                      </span>
                      <span className={cn('w-14 shrink-0 font-medium tabular-nums', failed ? 'text-danger' : slow ? 'text-warning' : '')}>{formatMs(tr.durationMs)}</span>
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    <Badge tone={OUTCOME_TONE[tr.outcome]}>{t(`flowMaps.traces.outcome.${tr.outcome}`)}</Badge>
                  </td>
                  <td className="pr-2 text-subtle">{open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}</td>
                </tr>
                {open && (
                  <tr data-testid="flow-execution-open">
                    <td colSpan={4} className="border-t border-border p-0">
                      <div className="bg-surface-raised py-3 pl-10 pr-4" style={{ boxShadow: `inset 2px 0 0 ${failed ? 'var(--color-danger)' : 'var(--color-border-strong)'}` }}>
                        {detail()}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Round marks for a time axis that ends at `total` milliseconds: about four steps of 1, 2, 2.5 or 5 times a power of ten. */
export function axisTicks(total: number): number[] {
  if (!(total > 0)) return [0]
  const rough = total / 4
  const pow = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? rough
  const out: number[] = []
  for (let v = 0; v <= total + step * 0.001; v += step) out.push(Math.round(v))
  return out
}

const isError = (l: FlowTraceLog) => ['error', 'fatal', 'critical'].includes(levelOf(l))
const MARK_TONE = (l: FlowTraceLog) => (isError(l) ? 'bg-danger' : ['warn', 'warning'].includes(levelOf(l)) ? 'bg-warning' : 'bg-subtle')
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * What happened in one execution: a sentence (where it failed and with what error, or which part
 * took longest), its id and what to do next; the parts as a waterfall over one time axis, with the
 * log lines marked on it; the logs; and what it did outside the map or never touched.
 */
export function TraceDetail({ map, trace, logs, loadingLogs, picked, onPick, onAsk, onShowOnMap }: { map: FlowMap; trace: FlowTrace; logs: FlowTraceLogsResult | null; loadingLogs: boolean; picked: FlowPartRef | null; onPick: (p: FlowPartRef | null) => void; onAsk?: () => void; onShowOnMap?: () => void }) {
  const { t, tn } = useI18n()
  const hops = Object.values(trace.hops).sort((a, b) => a.startMs - b.startMs || b.durationMs - a.durationMs)
  const total = Math.max(1, trace.durationMs, ...hops.map((h) => h.startMs + h.durationMs))
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / total) * 100))}%`
  const ticks = axisTicks(total)
  const lines = logs?.ok ? logs.logs : []
  const firstError = lines.find(isError)
  const errorAt = firstError ? Math.max(0, firstError.at - trace.at) : undefined
  // The part that took longest, leaving out the one that spans the whole execution (its entry).
  const longest = hops.filter((h) => !(h.startMs === 0 && h.durationMs >= total * 0.9)).reduce<FlowTraceHop | undefined>((m, h) => (!m || h.durationMs > m.durationMs ? h : m), undefined)
  const sentence =
    trace.outcome === 'failure'
      ? firstError
        ? t('flowMaps.exec.failedAt', { service: firstError.service, at: `${(errorAt! / 1000).toFixed(2)} s`, message: cut(firstError.message, 140) })
        : t('flowMaps.exec.failedNoLog')
      : longest
        ? t('flowMaps.exec.longest', { duration: formatMs(trace.durationMs), part: flowPartLabel(map, longest), value: formatMs(longest.durationMs) })
        : t('flowMaps.exec.took', { duration: formatMs(trace.durationMs) })
  const ROW = 'grid grid-cols-[minmax(140px,34%)_1fr_4.5rem] items-center gap-2'
  return (
    <div className="flex flex-col gap-3" data-testid="flow-trace-detail">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <Badge tone={OUTCOME_TONE[trace.outcome]} className="shrink-0">{t(`flowMaps.traces.outcome.${trace.outcome}`)}</Badge>
        <p className="min-w-0 flex-1 basis-64 text-xs text-muted" data-testid="flow-trace-sentence">{sentence}</p>
        <code className="max-w-40 truncate rounded bg-surface px-1.5 py-0.5 text-[11px] text-muted" title={trace.traceId}>{trace.traceId}</code>
        <CopyButton text={() => trace.traceId} />
        {onAsk && (
          <Button size="sm" variant="primary" icon={<Sparkles className="size-3.5" aria-hidden />} onClick={onAsk}>
            {t('flowMaps.band.investigate')}
          </Button>
        )}
        {onShowOnMap && (
          <Button size="sm" variant="secondary" icon={<Waypoints className="size-3.5" aria-hidden />} onClick={onShowOnMap}>
            {t('flowMaps.exec.showOnMap')}
          </Button>
        )}
      </div>
      <div className="text-xs">
        <div className={cn(ROW, 'text-[11px] text-muted')} title={t('flowMaps.traces.hopsHint')}>
          <span>{t('flowMaps.traces.hops')}</span>
          <span className="relative h-4" data-testid="flow-trace-axis">
            {ticks.map((v) => (
              <span key={v} className="absolute whitespace-nowrap" style={{ left: pct(v), transform: `translateX(${v === 0 ? '0' : v / total > 0.94 ? '-100%' : '-50%'})` }}>
                {v === 0 ? '0' : formatMs(v)}
              </span>
            ))}
          </span>
          <span />
        </div>
        {lines.length > 0 && (
          <div className={cn(ROW, 'text-[11px] text-muted')}>
            <span>{t('flowMaps.logs.title')}</span>
            <span className="relative h-4 border-b border-border" data-testid="flow-trace-marks">
              {lines.map((l, i) => (
                <span key={i} title={`+${(Math.max(0, l.at - trace.at) / 1000).toFixed(2)} s · ${l.service} · ${l.message}`} className={cn('absolute top-1 size-2 -translate-x-1/2', isError(l) ? 'rotate-45 rounded-[2px]' : 'rounded-full', MARK_TONE(l))} style={{ left: pct(l.at - trace.at) }} />
              ))}
            </span>
            <span />
          </div>
        )}
        {hops.length === 0 && <p className="py-1 text-muted">—</p>}
        <ul className="flex flex-col" data-testid="flow-trace-waterfall">
          {hops.map((h) => {
            const active = picked?.of === h.of && picked.key === h.key
            const label = flowPartLabel(map, h)
            return (
              <li
                key={`${h.of}:${h.key}`}
                className={cn(ROW, 'cursor-pointer rounded py-1 hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none', h.failed && 'bg-danger-soft', active && 'bg-accent-soft')}
                title={`${label} · +${formatMs(h.startMs)} · ${formatMs(h.durationMs)}`}
                data-failed={h.failed ? '' : undefined}
                {...pressable(() => onPick(active ? null : { of: h.of, key: h.key }), { pressed: active })}
              >
                <span className={cn('truncate pl-1', h.of === 'edges' ? 'text-muted' : 'font-medium')}>{label}</span>
                <span className="relative h-2.5" style={{ backgroundImage: 'linear-gradient(to right, var(--color-border) 1px, transparent 1px)', backgroundSize: `${((ticks[1] ?? total) / total) * 100}% 100%` }}>
                  <span className={cn('absolute inset-y-0 rounded-sm', h.failed ? 'bg-danger' : 'bg-accent')} style={{ left: pct(h.startMs), width: `max(3px, ${pct(h.durationMs)})` }} />
                  {h.failed && errorAt !== undefined && <span className="absolute -inset-y-1.5 border-l border-dashed border-danger" style={{ left: pct(errorAt) }} />}
                </span>
                <span className={cn('whitespace-nowrap pr-1 text-right tabular-nums', h.failed ? 'text-danger' : 'text-muted')}>
                  {formatMs(h.durationMs)}
                  {h.count > 1 ? ` ×${h.count}` : ''}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
      <LogsSection trace={trace} logs={logs} loading={loadingLogs} />
      {(trace.unmapped.length > 0 || trace.missing.length > 0) && (
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5 text-xs text-muted">
          {trace.unmapped.length > 0 && (
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1" title={t('flowMaps.traces.unmappedHint')} data-testid="flow-trace-unmapped">
              <span>{t('flowMaps.exec.outside')}</span>
              {trace.unmapped.map((u, i) => (
                <span key={i} className="whitespace-nowrap">
                  <span className="font-medium text-text">{u.event === 'span' ? `${u.service} → ${u.destination ?? u.name}` : `${u.service} · ${u.name}`}</span> {formatMs(u.durationMs)}
                  {u.count > 1 ? ` · ${tn('flowMaps.traces.times', u.count)}` : ''}
                  {i < trace.unmapped.length - 1 ? ' ·' : ''}
                </span>
              ))}
            </p>
          )}
          {trace.missing.length > 0 && (
            <p title={t('flowMaps.traces.missing')} data-testid="flow-trace-missing">
              {t('flowMaps.exec.untouched')} {trace.missing.map((k) => flowPartLabel(map, { of: partOf(map, k), key: k })).join(' · ')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

const LEVEL_TONE: Record<string, string> = { error: 'bg-danger/15 text-danger', warn: 'bg-warning/15 text-warning', info: 'bg-surface-raised text-muted' }
const levelOf = (l: FlowTraceLog) => (l.level ?? (l.source === 'apm.error' ? 'error' : 'log')).toLowerCase()
const toneOf = (level: string) => LEVEL_TONE[level === 'warning' ? 'warn' : level] ?? (['fatal', 'critical'].includes(level) ? LEVEL_TONE.error : 'bg-surface-raised text-muted')

/** The APM errors and log lines of the execution, oldest first, each at its offset from the start; click a message for its full text. */
export function LogsSection({ trace, logs, loading }: { trace: Pick<FlowTrace, 'at'>; logs: FlowTraceLogsResult | null; loading: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = useState<Set<number>>(new Set())
  const toggle = (i: number) => setOpen((prev) => {
    const next = new Set(prev)
    if (!next.delete(i)) next.add(i)
    return next
  })
  return (
    <div data-testid="flow-trace-logs">
      <p className="mb-1 text-xs font-medium text-muted">{t('flowMaps.logs.title')}</p>
      {loading && <p className="flex items-center gap-2 text-sm text-muted"><Spinner /> {t('flowMaps.logs.loading')}</p>}
      {!loading && logs && !logs.ok && <p className="text-sm text-danger">{t('flowMaps.logs.failed', { error: logs.error })}</p>}
      {!loading && logs?.ok && logs.logs.length === 0 && <p className="text-sm text-muted">{t('flowMaps.logs.empty')}</p>}
      {!loading && logs?.ok && logs.logs.length > 0 && (
        <ul className="max-h-[260px] overflow-y-auto rounded-md border border-border bg-surface text-xs">
          {logs.logs.map((l, i) => {
            const level = levelOf(l)
            const expanded = open.has(i)
            return (
              <li key={i} className={cn('grid grid-cols-[auto_auto_auto_1fr] items-baseline gap-x-2 border-t border-border px-2 py-1 first:border-t-0', ['error', 'fatal', 'critical'].includes(level) && 'bg-danger-soft')}>
                <span className="whitespace-nowrap tabular-nums text-muted">+{(Math.max(0, l.at - trace.at) / 1000).toFixed(2)} s</span>
                <span className="max-w-[140px] truncate font-medium" title={l.service}>{l.service}</span>
                <span className={cn('rounded px-1.5 py-px text-[10px] font-medium uppercase', toneOf(level))}>{level}</span>
                <div className="min-w-0">
                  <button type="button" className={cn('block w-full text-left', expanded ? 'whitespace-pre-wrap break-words' : 'truncate')} title={l.message} aria-expanded={expanded} onClick={() => toggle(i)}>
                    {l.message}
                  </button>
                  {l.source === 'apm.error' && (l.type || l.culprit) && <span className="block truncate text-[11px] text-subtle" title={[l.type, l.culprit].filter(Boolean).join(' · ')}>{[l.type, l.culprit].filter(Boolean).join(' · ')}</span>}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function partOf(map: FlowMap, key: string): 'edges' | 'nodes' | 'stages' {
  if (map.nodes.some((n) => n.id === key)) return 'nodes'
  if (map.stages.some((s) => s.id === key)) return 'stages'
  return 'edges'
}
