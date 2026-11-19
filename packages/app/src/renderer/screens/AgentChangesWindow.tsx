import { Bot } from 'lucide-react'
import { useState } from 'react'
import type { AgentChange, AgentChangeAnswer } from '@shared/agent-changes-api'
import { Badge, Button, TooltipProvider } from '../components/atoms'
import { EmptyState } from '../components/molecules'
import { useAgentChanges } from '../chatStore'
import { I18nProvider, useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { changeValue, readableValue, shortValue, shownFields, type ValueWords } from '../lib/agentChanges'
import { cn } from '../lib/cn'
import { errorText } from '../lib/errorText'
import { usePlatform } from '../lib/platform'
import { relativeTime } from '../lib/tickets'
import { useNow } from '../lib/usage'

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
 * "Changes by agents" in a window of its own (opened from Home or the sidebar): what agents changed
 * of automations, flow maps, milestones and inbox items through the control endpoint, with the
 * fields before and after, and the user's Keep or Revert. It follows the list live, so a change
 * reviewed elsewhere leaves it at once.
 */
export function AgentChangesWindow() {
  const platform = usePlatform()
  return (
    <I18nProvider>
      <TooltipProvider>
        <div className="flex h-full flex-col bg-bg">
          <div className={cn('drag-region h-10 shrink-0', platform === 'mac' ? 'pl-20' : 'pr-36')} />
          <main className="mx-auto min-h-0 w-full max-w-4xl flex-1 overflow-y-auto px-6 pb-6" data-testid="agent-changes-window">
            <Live />
          </main>
        </div>
      </TooltipProvider>
    </I18nProvider>
  )
}

function Live() {
  const changes = useAgentChanges()
  const now = useNow()
  return <AgentChangesList changes={changes} now={now} />
}

/** The changes waiting for review, newest first, each with Revert and Keep and its last error. */
export function AgentChangesList({ changes, now }: { changes: readonly AgentChange[]; now: number }) {
  const { t, tn } = useI18n()
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
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
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Bot className="size-5 shrink-0 text-accent" aria-hidden />
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{t('agentChanges.title')}</h1>
        {changes.length > 0 && <span className="text-sm tabular-nums text-muted">{tn('agentChanges.count', changes.length)}</span>}
      </div>
      {changes.length === 0 ? (
        <EmptyState icon={<Bot className="size-5" aria-hidden />} title={t('agentChanges.window.empty')} description={t('agentChanges.window.emptyHint')} />
      ) : (
        <>
          <p className="text-sm text-muted">{t('agentChanges.hint')}</p>
          <ul className="flex flex-col gap-2">
            {changes.map((c) => (
              <AgentChangeRow key={c.id} change={c} now={now} busy={busy === c.id} error={errors[c.id]} onKeep={() => void answer(c, false)} onRevert={() => void answer(c, true)} />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function AgentChangeRow({ change: c, now, busy, error, onKeep, onRevert }: { change: AgentChange; now: number; busy: boolean; error?: string; onKeep: () => void; onRevert: () => void }) {
  const { t, locale } = useI18n()
  const words: ValueWords = { yes: t('agentChanges.value.yes'), no: t('agentChanges.value.no'), empty: t('agentChanges.value.empty'), locale }
  const who = c.session ? (c.session.agent && c.session.agent !== c.session.name ? t('agentChanges.bySession', { name: c.session.name ?? c.session.id, agent: c.session.agent }) : t('agentChanges.bySessionOnly', { name: c.session.name ?? c.session.id })) : t('agentChanges.byUnknown')
  // An added object has nothing before, a deleted one nothing after: only the side that has values is shown.
  const side = (value: unknown, tone: 'before' | 'after') => {
    const text = readableValue(value, words)
    return (
      <span className={tone === 'before' ? 'text-danger line-through' : 'text-success'} title={changeValue(value) ?? undefined}>
        {text === null ? t('agentChanges.unset') : shortValue(text)}
      </span>
    )
  }
  return (
    <li data-testid="agent-change" data-kind={c.kind} className="flex flex-col gap-1.5 rounded-[10px] border border-border bg-surface px-3 py-2.5 text-sm shadow-sm">
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
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {shownFields(c).map((f) => (
          <div key={f} className="contents" data-testid="agent-change-field">
            <dt className="font-mono text-muted">{f}</dt>
            <dd className="min-w-0 break-words">
              {c.action === 'create' ? (
                side(c.after[f], 'after')
              ) : c.action === 'delete' ? (
                side(c.before[f], 'before')
              ) : (
                <>
                  {side(c.before[f], 'before')}
                  {' → '}
                  {side(c.after[f], 'after')}
                </>
              )}
              {c.held?.includes(f) && <span className="ml-1.5 text-warning">{t('agentChanges.held')}</span>}
            </dd>
          </div>
        ))}
      </dl>
      {!c.held?.length && c.kind === 'flowMap' && c.fields.includes('alerts') && <p className="text-xs text-subtle">{t('agentChanges.inEffect')}</p>}
      <div className="flex items-center justify-end gap-1.5">
        {error && (
          <p role="alert" className="mr-auto min-w-0 text-xs text-danger" data-testid="agent-change-error">
            {error}
          </p>
        )}
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
