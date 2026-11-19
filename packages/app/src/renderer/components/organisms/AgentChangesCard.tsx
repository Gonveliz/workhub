import { Bot } from 'lucide-react'
import type { AgentChange } from '@shared/agent-changes-api'
import { Button } from '../atoms'
import { useAgentChanges } from '../../chatStore'
import { useI18n } from '../../i18n/I18nProvider'
import type { PluralKey } from '../../i18n/translate'
import { countsByKind, latestChange } from '../../lib/agentChanges'
import { relativeTime } from '../../lib/tickets'
import { useNow } from '../../lib/usage'

const KIND_COUNT: Record<AgentChange['kind'], PluralKey> = {
  automation: 'agentChanges.kindCount.automation',
  flowMap: 'agentChanges.kindCount.flowMap',
  milestone: 'agentChanges.kindCount.milestone',
  inboxItem: 'agentChanges.kindCount.inboxItem'
}

/**
 * "Changes by agents" on Home: one row with how many changes wait (by kind when there are several
 * kinds), when the latest happened, and "See changes", which opens the window that lists them for
 * Keep or Revert. Shown only while some change waits.
 */
export function AgentChangesCard() {
  const changes = useAgentChanges()
  const now = useNow()
  return <AgentChangesSummary changes={changes} now={now} onOpen={() => window.hub.agentChanges.openWindow()} />
}

export function AgentChangesSummary({ changes, now, onOpen }: { changes: readonly AgentChange[]; now: number; onOpen: () => void }) {
  const { t, tn, locale } = useI18n()
  const latest = latestChange(changes)
  if (latest === null) return null
  const kinds = countsByKind(changes)
  const total = tn('agentChanges.count', changes.length)
  const what = kinds.length > 1 ? kinds.map((k) => tn(KIND_COUNT[k.kind], k.count)).join(' · ') : total
  return (
    <section id="agent-changes" data-testid="agent-changes" aria-labelledby="agent-changes-title" className="flex items-center gap-3 rounded-[10px] border border-border bg-surface px-3 py-2.5 shadow-sm">
      <Bot className="size-4 shrink-0 text-accent" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 id="agent-changes-title" className="text-sm font-semibold">
          {t('agentChanges.title')}
        </h3>
        <span className="rounded-full bg-accent-soft px-1.5 text-xs font-medium tabular-nums text-accent" title={total}>
          {changes.length}
        </span>
        <span className="min-w-0 text-xs text-muted" data-testid="agent-changes-summary">
          {what} · {t('agentChanges.latest', { when: relativeTime(latest, now, locale) })}
        </span>
      </div>
      <Button size="sm" variant="secondary" data-testid="agent-changes-open" onClick={onOpen}>
        {t('agentChanges.open')}
      </Button>
    </section>
  )
}
