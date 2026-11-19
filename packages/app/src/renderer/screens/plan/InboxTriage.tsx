import { Check, Pencil, SquareArrowOutUpRight, Ticket, X } from 'lucide-react'
import { forwardRef, type ReactNode } from 'react'
import { availableInboxActions, isUrgent, type CriticalityLevel, type InboxAction, type InboxItem, type Person } from '@workhub/core'
import type { MilestoneView } from '@shared/planner-api'
import { Badge, Button, IconButton, Spinner } from '../../components/atoms'
import { Markdown } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { relativeTime } from '../../lib/pullRequests'
import { inboxActionLabel, inboxDecisionKey, INBOX_KIND_LABEL, INBOX_KIND_TONE, INBOX_SOURCE_LABEL } from '../../lib/planner'
import { ItemMilestones } from './ItemMilestones'
import { LinksList } from './PlanItemDetail'

const peopleNames = (item: InboxItem, people: readonly Person[]) => (item.people ?? []).map((id) => people.find((p) => p.id === id)?.name).filter((n): n is string => Boolean(n))

/** A key cap next to a decision; `onFill` inverts it on a filled button. */
function KeyCap({ children, onFill }: { children: ReactNode; onFill?: boolean }) {
  return <kbd className={cn('rounded-[5px] border px-1 font-mono text-2xs leading-4', onFill ? 'border-black/25 text-inherit' : 'border-border-strong text-muted')}>{children}</kbd>
}

/**
 * One row of the triage list: kind, due date and criticality, the title on one line, and where it
 * came from with the people. The checkbox (for bulk edits) shows on hover or once something is
 * picked; its place is kept, so the row never moves when it appears.
 */
export const TriageRow = forwardRef<HTMLLIElement, { item: InboxItem; people: readonly Person[]; levels: readonly CriticalityLevel[]; current: boolean; onPick: () => void; checked: boolean; selecting: boolean; onCheck: (on: boolean) => void }>(function TriageRow({ item, people, levels, current, onPick, checked, selecting, onCheck }, ref) {
  const { t, formatDate } = useI18n()
  const due = item.due ? formatDate(new Date(`${item.due}T00:00:00`), { day: 'numeric', month: 'short' }) : null
  const names = peopleNames(item, people)
  const source = item.source.label || t(INBOX_SOURCE_LABEL[item.source.type])
  return (
    <li ref={ref} className="group relative" data-testid="triage-row">
      <button
        type="button"
        aria-current={current || undefined}
        onClick={onPick}
        className={cn(
          'flex w-full flex-col rounded-md px-2.5 py-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          current ? 'bg-accent-soft shadow-[inset_2px_0_0_var(--color-accent)]' : 'hover:bg-surface-hover'
        )}
      >
        <span className="flex items-center gap-2 pr-6">
          <Badge tone={INBOX_KIND_TONE[item.kind]}>{t(INBOX_KIND_LABEL[item.kind])}</Badge>
          <span className="ml-auto flex items-center gap-2 text-xs whitespace-nowrap">
            {due && <span className="text-subtle">{t('planner.inbox.due', { date: due })}</span>}
            {item.criticality && <span className={isUrgent(item, levels) ? 'font-medium text-text' : 'text-subtle'}>{item.criticality}</span>}
          </span>
        </span>
        <span className={cn('mt-1 block truncate', current ? 'font-semibold' : 'font-medium')} title={item.title}>
          {item.title}
        </span>
        <span className="mt-px block truncate text-xs text-subtle">{[source, ...(names.length ? [names.join(', ')] : [])].join(' · ')}</span>
      </button>
      <input
        type="checkbox"
        className={cn('absolute top-2.5 right-2.5 size-4 accent-[var(--color-accent)]', !selecting && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}
        checked={checked}
        onChange={(e) => onCheck(e.target.checked)}
        aria-label={t('planner.inbox.select', { title: item.title })}
      />
    </li>
  )
})

/** One fact under the item: its label above, its value below. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="mt-0.5 min-w-0 break-words font-medium">{children}</dd>
    </div>
  )
}

/**
 * The selected item in full: kind, source and age, its own window and its edit form, the title,
 * the whole body, its links, then its facts with the milestone it counts toward. No chart: an
 * inbox item carries no metric series of its own.
 */
export function TriageDetail({ item, people, milestones, profileId, now, onOpenMilestone, footer }: { item: InboxItem; people: readonly Person[]; milestones: readonly MilestoneView[]; profileId: string; now: number; onOpenMilestone: (id: string) => void; footer: ReactNode }) {
  const { t, locale, formatDate } = useI18n()
  const names = peopleNames(item, people)
  const source = item.source.label ? `${t(INBOX_SOURCE_LABEL[item.source.type])}: ${item.source.label}` : t(INBOX_SOURCE_LABEL[item.source.type])
  const open = (edit: boolean) => window.hub.planner.openWindow({ profileId, kind: 'inbox', id: item.id, ...(edit ? { edit: true } : {}) })
  const none = <span className="font-normal text-subtle">{t('planner.inbox.none')}</span>
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={item.title} data-testid="triage-detail">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pt-4 pb-3">
        <header className="flex items-center gap-2">
          <Badge tone={INBOX_KIND_TONE[item.kind]}>{t(INBOX_KIND_LABEL[item.kind])}</Badge>
          <span className="min-w-0 truncate text-xs text-subtle">
            {source} · <time dateTime={new Date(item.createdAt).toISOString()} title={formatDate(item.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}>{relativeTime(item.createdAt, now, locale)}</time>
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            <IconButton size="sm" label={t('planner.detail.edit')} icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => open(true)} />
            <IconButton size="sm" label={t('planner.triage.window')} icon={<SquareArrowOutUpRight className="size-4" aria-hidden />} onClick={() => open(false)} />
          </span>
        </header>
        <h2 className="text-lg leading-snug font-semibold break-words">{item.title}</h2>
        {item.detail ? <Markdown text={item.detail} profileId={profileId} breaks className="text-sm leading-relaxed text-muted" /> : <p className="text-sm text-subtle">{t('planner.detail.noBody')}</p>}
        {(item.link || (item.links?.length ?? 0) > 0) && <LinksList link={item.link} links={item.links} profileId={profileId} />}
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-3 border-t border-border pt-3 text-sm">
          <Fact label={t('planner.inbox.area')}>{item.area ?? none}</Fact>
          <Fact label={t('planner.inbox.criticality')}>{item.criticality ?? none}</Fact>
          <Fact label={t('planner.inbox.people')}>{names.length ? names.join(', ') : none}</Fact>
          {item.due && <Fact label={t('planner.inbox.dueLabel')}>{formatDate(new Date(`${item.due}T00:00:00`), { day: 'numeric', month: 'short', year: 'numeric' })}</Fact>}
          <Fact label={t('planner.triage.milestone')}>
            <ItemMilestones item={item} milestones={milestones} profileId={profileId} onOpen={onOpenMilestone} field />
          </Fact>
        </dl>
      </div>
      {footer}
    </section>
  )
}

const ACTION_ICON: Partial<Record<InboxAction, ReactNode>> = {
  approve: <Ticket className="size-3.5" aria-hidden />,
  keep: <Check className="size-3.5" aria-hidden />,
  discard: <X className="size-3.5" aria-hidden />
}

/**
 * "What is it?": the decisions a pending item allows, each with the number key that takes it, and
 * how to move through the list. Creating a ticket is the one filled button; it waits for a tracker
 * that can create issues (a decision is only recorded, so it never waits).
 */
export function DecisionBar({ item, canCreate, busy, onAction }: { item: InboxItem; canCreate: boolean; busy: boolean; onAction: (action: InboxAction) => void }) {
  const { t } = useI18n()
  return (
    <div className="mx-5 mb-4 flex flex-col gap-2.5 rounded-lg border border-border bg-surface-raised px-3.5 py-3" role="group" aria-label={t('planner.triage.what')} data-testid="decision-bar">
      <p className="text-2xs font-semibold tracking-wider text-subtle uppercase">{t('planner.triage.what')}</p>
      <div className="flex flex-wrap items-center gap-2">
        {availableInboxActions(item).map((action) => {
          const needsTracker = action === 'approve' && item.kind !== 'decision'
          const key = inboxDecisionKey(action)
          const primary = action === 'approve'
          return (
            <Button
              key={action}
              variant={primary ? 'primary' : action === 'discard' ? 'ghost' : 'secondary'}
              icon={busy && primary ? <Spinner /> : action === 'approve' && item.kind === 'decision' ? <Check className="size-3.5" aria-hidden /> : ACTION_ICON[action]}
              disabled={busy || (needsTracker && !canCreate)}
              title={needsTracker && !canCreate ? t('planner.inbox.noCreate') : undefined}
              aria-keyshortcuts={key}
              onClick={() => onAction(action)}
            >
              {t(inboxActionLabel(action, item.kind))}
              {key && <KeyCap onFill={primary}>{key}</KeyCap>}
            </Button>
          )
        })}
        <span className="ml-auto flex items-center gap-1 text-xs text-subtle">
          <KeyCap>↑</KeyCap>
          <KeyCap>↓</KeyCap>
          {t('planner.triage.next')}
        </span>
      </div>
    </div>
  )
}
