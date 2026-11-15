// What a session has going on besides its reply, above the chat's composer: the sub-agents at work
// and the tasks the agent left running in the background (the desktop's notice, reused).
import { Bot, ChevronRight, Timer } from 'lucide-react'
import { useState } from 'react'
import type { BackgroundTaskSummary, SessionMonitorSnapshot, SessionState, SubagentSummary } from '@workhub/core'
import { cn } from '../../renderer/lib/cn'
import { StateDot } from '../../renderer/components/atoms/StateDot'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import { waitingTasks } from '../../renderer/lib/backgroundTasks'
import { isLive } from '../../renderer/lib/subagentView'
import { BackgroundTasksNotice } from '../../renderer/screens/sessions/BackgroundTasksNotice'
import { navigate } from '../app-context'

/** A sub-agent with no status that has done nothing for this long is not shown as at work: its end was missed. */
export const SUBAGENT_STALE_MS = 10 * 60_000

/** The sub-agents at work now, oldest first (the order they were started in). */
export function runningSubagents(subagents: readonly SubagentSummary[] | undefined, now: number): SubagentSummary[] {
  return (subagents ?? [])
    .filter((s) => {
      if (!isLive(s.status)) return false
      const last = s.lastActivityAt ?? s.startedAt
      return s.status !== undefined || last === undefined || now - last < SUBAGENT_STALE_MS
    })
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
}

const nameOf = (s: SubagentSummary) => s.description ?? s.name ?? s.type ?? s.id

/** "2 sub-agents running" and their names; a name opens that sub-agent's conversation. Nothing when none runs. */
export function SubagentsRunningRow({ sessionId, subagents }: { sessionId: string; subagents: readonly SubagentSummary[] }) {
  const { t, tn } = useI18n()
  if (subagents.length === 0) return null
  return (
    <section data-testid="subagents-running" aria-label={t('web.session.subagentsLabel')} className="flex shrink-0 items-center gap-2 border-t border-border bg-sidebar px-3 py-2 text-xs">
      <Bot className="size-4 shrink-0 text-info" aria-hidden />
      <StateDot tone="info" pulse />
      <span className="shrink-0 font-medium text-text">{tn('web.session.subagents', subagents.length)}</span>
      <ul className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
        {subagents.map((s) => (
          <li key={s.id} className="shrink-0">
            <button
              type="button"
              data-testid="subagent-chip"
              onClick={() => navigate({ screen: 'subagent', sessionId, id: s.id })}
              aria-label={t('subagent.open', { name: nameOf(s) })}
              className="flex min-h-11 max-w-48 items-center truncate rounded-full border border-border bg-surface px-3 text-muted active:bg-surface-hover"
            >
              {nameOf(s)}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The tasks the agent left running, in one line ("2 background tasks"); a tap shows the desktop's notice with each one. */
export function BackgroundTasksRow({ tasks, now, initiallyOpen = false }: { tasks: readonly BackgroundTaskSummary[]; now: number; initiallyOpen?: boolean }) {
  const { tn } = useI18n()
  const [open, setOpen] = useState(initiallyOpen)
  if (tasks.length === 0) return null
  return (
    <div data-testid="background-tasks-row" className="border-t border-border bg-sidebar">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-xs text-muted active:bg-surface-hover"
      >
        <Timer className="size-4 shrink-0 animate-pulse text-subtle" aria-hidden />
        <span className="flex-1 font-medium text-text">{tn('web.session.backgroundTasks', tasks.length)}</span>
        <ChevronRight className={cn('size-4 shrink-0 text-subtle transition-transform', open && 'rotate-90')} aria-hidden />
      </button>
      {open && (
        <div className="pb-3">
          <BackgroundTasksNotice tasks={tasks} now={now} />
        </div>
      )}
    </div>
  )
}

/** Both rows of a session's activity, from its monitor; nothing once the session stopped or failed. */
export function SessionActivity({ sessionId, state, monitor, now }: { sessionId: string; state: SessionState; monitor: SessionMonitorSnapshot; now: number }) {
  if (state === 'stopped' || state === 'error') return null
  return (
    <>
      <SubagentsRunningRow sessionId={sessionId} subagents={runningSubagents(monitor.subagents, now)} />
      <BackgroundTasksRow tasks={waitingTasks(monitor.backgroundTasks)} now={now} />
    </>
  )
}
