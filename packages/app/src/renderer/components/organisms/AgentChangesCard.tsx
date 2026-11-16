import { Bot } from 'lucide-react'
import { useState } from 'react'
import type { AgentChange, AgentChangeAnswer } from '@shared/agent-changes-api'
import { Badge, Button } from '../atoms'
import { useAgentChanges } from '../../chatStore'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { changeValue, shortValue } from '../../lib/agentChanges'
import { errorText } from '../../lib/errorText'
import { relativeTime } from '../../lib/tickets'
import { useNow } from '../../lib/usage'

const KIND: Record<AgentChange['kind'], MessageKey> = {
  automation: 'agentChanges.kind.automation',
  flowMap: 'agentChanges.kind.flowMap',
  milestone: 'agentChanges.kind.milestone',
  inboxItem: 'agentChanges.kind.inboxItem'
}

const ACTION: Record<AgentChange['action'], MessageKey> = {
  create: 'agentChanges.action.create',
  update: 'agentChanges.action.update',
  delete: 'agentChanges.action.delete'
}

const FAILURE: Record<Exclude<AgentChangeAnswer, { ok: true }>['error'], MessageKey> = {
  gone: 'agentChanges.error.gone',
  changed: 'agentChanges.error.changed',
  cut: 'agentChanges.error.cut',
  failed: 'agentChanges.error.failed'
}

/**
 * "Changes by agents" on Home: what agents changed of automations, flow maps, milestones and inbox
 * items through the control endpoint, with the fields before and after, and the user's Keep or
 * Revert. Shown only while some change waits.
 */
export function AgentChangesCard() {
  const { t, tn } = useI18n()
  const changes = useAgentChanges()
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  if (!changes.length) return null
  const answer = async (c: AgentChange, revert: boolean) => {
    setBusy(c.id)
    try {
      const r = revert ? await window.hub.agentChanges.revert(c.id) : await window.hub.agentChanges.keep(c.id)
      setErrors(({ [c.id]: _old, ...rest }) => (r.ok ? rest : { ...rest, [c.id]: t(FAILURE[r.error] ?? 'agentChanges.error.failed', { detail: r.detail ?? '' }) }))
    } catch (e) {
      setErrors((all) => ({ ...all, [c.id]: errorText(e) }))
    } finally {
      setBusy(null)
    }
  }
  return (
    <section id="agent-changes" data-testid="agent-changes" aria-labelledby="agent-changes-title" className="flex flex-col gap-2 rounded-[10px] border border-border bg-surface p-3 shadow-sm">
      <div className="flex items-center gap-1.5">
        <Bot className="size-4 shrink-0 text-accent" aria-hidden />
        <h3 id="agent-changes-title" className="flex-1 text-sm font-semibold">
          {t('agentChanges.title')}
        </h3>
        <span className="text-sm tabular-nums text-muted" title={tn('agentChanges.count', changes.length)}>
          {changes.length}
        </span>
      </div>
      <p className="text-xs text-muted">{t('agentChanges.hint')}</p>
      <ul className="flex flex-col gap-2">
        {changes.map((c) => (
          <AgentChangeRow key={c.id} change={c} busy={busy === c.id} error={errors[c.id]} onKeep={() => void answer(c, false)} onRevert={() => void answer(c, true)} />
        ))}
      </ul>
    </section>
  )
}

function AgentChangeRow({ change: c, busy, error, onKeep, onRevert }: { change: AgentChange; busy: boolean; error?: string; onKeep: () => void; onRevert: () => void }) {
  const { t, locale } = useI18n()
  const now = useNow()
  const who = c.session ? (c.session.agent && c.session.agent !== c.session.name ? t('agentChanges.bySession', { name: c.session.name ?? c.session.id, agent: c.session.agent }) : t('agentChanges.bySessionOnly', { name: c.session.name ?? c.session.id })) : t('agentChanges.byUnknown')
  return (
    <li data-testid="agent-change" data-kind={c.kind} className="flex flex-col gap-1.5 rounded-md border border-border px-2.5 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral">{t(KIND[c.kind])}</Badge>
        <span className="min-w-0 flex-1 truncate font-semibold" title={c.object.name}>
          {c.object.name}
        </span>
        <span className="text-xs text-muted">{t(ACTION[c.action])}</span>
      </div>
      <p className="text-xs text-muted">
        {who} · {relativeTime(c.at, now, locale)}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 font-mono text-xs">
        {c.fields.map((f) => {
          const before = changeValue(c.before[f])
          const after = changeValue(c.after[f])
          return (
            <div key={f} className="contents" data-testid="agent-change-field">
              <dt className="text-muted">{f}</dt>
              <dd className="min-w-0 break-words">
                <span className="text-danger line-through" title={before ?? undefined}>
                  {before === null ? t('agentChanges.unset') : shortValue(before)}
                </span>
                {' → '}
                <span className="text-success" title={after ?? undefined}>
                  {after === null ? t('agentChanges.unset') : shortValue(after)}
                </span>
                {c.held?.includes(f) && <span className="ml-1.5 font-sans text-warning">{t('agentChanges.held')}</span>}
              </dd>
            </div>
          )
        })}
      </dl>
      {!c.held?.length && c.kind === 'flowMap' && c.fields.includes('alerts') && <p className="text-xs text-subtle">{t('agentChanges.inEffect')}</p>}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" disabled={busy} data-testid="agent-change-revert" onClick={onRevert}>
          {t('agentChanges.revert')}
        </Button>
        <Button size="sm" variant="primary" disabled={busy} data-testid="agent-change-keep" onClick={onKeep}>
          {t('agentChanges.keep')}
        </Button>
      </div>
    </li>
  )
}
