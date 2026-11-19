import { Clock, Ellipsis, FileText, Pencil, Plus, Search, Sparkles, Trash2, UserRound, Video } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useState } from 'react'
import { availableInboxActions, inboxSettings, meetingsWith, openItemsOf, plannerSettings, type CalendarEvent, type InboxItem, type Person } from '@workhub/core'
import type { PlanBrief } from '@shared/plan-api'
import { Badge, Button, hueOf, IconButton, initials, Input, Spinner } from '../../components/atoms'
import { ConfirmDeleteDialog, Dialog, EmptyState, useToast } from '../../components/molecules'
import { refreshConfig } from '../../configStore'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { briefLabel, formToPerson, isOngoing, meetingDay, minutesUntil, personId, personToForm, withinWeek, type PersonForm } from '../../lib/plan'
import { EMPTY_ITEM_FORM, INBOX_KIND_LABEL, INBOX_KIND_TONE, INBOX_SOURCE_LABEL, plainPreview, type InboxItemForm } from '../../lib/planner'
import { isDirty } from '../../lib/unsavedChanges'
import { usePlanner } from '../../plannerStore'
import { AddItemDialog } from './AddItemDialog'
import { useInboxActions } from './InboxTab'
import { PersonFields } from './PersonFields'
import type { PlanTabContext } from './planTabs'

const blank = (): PersonForm => personToForm({ id: '', name: '', emails: [] })

/** Initials in a circle, in the person's own color. */
export function PersonAvatar({ name, large }: { name: string; large?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full bg-[hsl(var(--avatar-hue)_60%_68%)] font-semibold text-black/80 select-none', large ? 'size-11 text-base' : 'size-7 text-2xs')}
      style={{ ['--avatar-hue' as string]: String(hueOf(name)) }}
    >
      {initials(name)}
    </span>
  )
}

/** "today 21:05", "Thu 00:05": when a meeting is, short, for a line of text. */
function useWhen() {
  const { t, formatDate } = useI18n()
  const time = (ms: number) => formatDate(ms, { hour: '2-digit', minute: '2-digit' })
  const day = (ms: number, now: number) => {
    const near = meetingDay(ms, now)
    return near ? t(near === 'today' ? 'plan.today' : 'plan.tomorrow') : formatDate(ms, { weekday: 'short', day: 'numeric' })
  }
  return { time, day, short: (ms: number, now: number) => `${meetingDay(ms, now) ? day(ms, now).toLocaleLowerCase() : formatDate(ms, { weekday: 'short' })} ${time(ms)}` }
}

/** One open topic with a person: tick it done (when it can be), its kind and title (opens it), a line of its body, and source · criticality. */
export function TopicRow({ item, busy, onDone, onOpen }: { item: InboxItem; busy: boolean; onDone: () => void; onOpen: () => void }) {
  const { t } = useI18n()
  const canTick = availableInboxActions(item).includes('done')
  const why = canTick ? t('plan.people.markDone', { title: item.title }) : item.status === 'pending' ? t('plan.people.decideFirst') : t('plan.people.decisionOpen')
  const source = item.source.label || t(INBOX_SOURCE_LABEL[item.source.type])
  return (
    <li className="flex items-start gap-2.5 border-t border-border py-2.5" data-testid="person-topic">
      <input type="checkbox" className="mt-1 size-4 shrink-0 accent-[var(--color-accent)] disabled:opacity-40" checked={false} disabled={!canTick || busy} onChange={onDone} aria-label={why} title={why} />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2">
          <Badge tone={INBOX_KIND_TONE[item.kind]}>{t(INBOX_KIND_LABEL[item.kind])}</Badge>
          <button type="button" className="min-w-0 truncate rounded-sm text-left font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" title={t('planner.detail.open')} onClick={onOpen}>
            {item.title}
          </button>
          {busy && <Spinner />}
        </p>
        {item.detail && <p className="mt-0.5 line-clamp-1 text-sm text-muted">{plainPreview(item.detail)}</p>}
        <p className="mt-0.5 truncate text-xs text-subtle">{[source, ...(item.criticality ? [item.criticality] : [])].join(' · ')}</p>
      </div>
    </li>
  )
}

/** The person's header: initials, name, one line of facts, "Join" and "Prepare 1:1" once, and the rest in the "⋯" menu. */
export function PersonHeader({ person, facts, joinUrl, preparing, onJoin, onOneOnOne, onEdit, onRemove }: { person: Person; facts: string[]; joinUrl?: string; preparing: boolean; onJoin: (url: string) => void; onOneOnOne: () => void; onEdit: () => void; onRemove: () => void }) {
  const { t } = useI18n()
  return (
    <header className="flex items-center gap-3.5 rounded-lg border border-border bg-surface px-4 py-3 shadow-sm" data-testid="person-header">
      <PersonAvatar name={person.name} large />
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-lg font-semibold">{person.name}</h2>
        <p className="text-xs text-subtle">{facts.join(' · ')}</p>
      </div>
      {joinUrl && (
        <Button icon={<Video className="size-3.5" aria-hidden />} onClick={() => onJoin(joinUrl)}>
          {t('plan.join')}
        </Button>
      )}
      <Button variant="primary" icon={preparing ? <Spinner /> : <Sparkles className="size-3.5" aria-hidden />} disabled={preparing} onClick={onOneOnOne}>
        {t('plan.people.oneOnOne')}
      </Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <IconButton label={t('plan.people.more', { name: person.name })} icon={<Ellipsis className="size-4" aria-hidden />} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-48 animate-fade-in rounded-md border border-border bg-surface-raised p-1 shadow-lg">
            <DropdownMenu.Item onSelect={onEdit} className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-accent-soft">
              <Pencil className="size-3.5" aria-hidden />
              {t('plan.people.editTitle')}
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={onRemove} className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-danger outline-none select-none data-[highlighted]:bg-danger-soft">
              <Trash2 className="size-3.5" aria-hidden />
              {t('plan.people.remove', { name: person.name })}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </header>
  )
}

/** One meeting with the person: day and time, title, and its brief as an icon; "in N min" on the one about to start. */
export function MeetingRow({ event, brief, now, busy, onBrief }: { event: CalendarEvent; brief?: PlanBrief; now: number; busy: boolean; onBrief: () => void }) {
  const { t } = useI18n()
  const when = useWhen()
  const soon = minutesUntil(event, now)
  const ongoing = isOngoing(event, now)
  const near = soon !== null || ongoing
  return (
    <li className="flex items-center gap-2.5 border-t border-border py-2" data-testid="person-meeting">
      <div className="w-14 shrink-0 text-sm">
        <p className={cn('font-semibold first-letter:uppercase', near && 'text-accent')}>{when.day(event.start, now)}</p>
        <p className="text-xs text-subtle tabular-nums">{event.allDay ? t('plan.allDay') : when.time(event.start)}</p>
      </div>
      <span className="min-w-0 flex-1 truncate text-sm" title={event.title || t('plan.untitled')}>
        {event.title || t('plan.untitled')}
      </span>
      {ongoing ? (
        <Badge tone="accent">{t('plan.now')}</Badge>
      ) : soon !== null ? (
        <Badge tone="success">{t('plan.people.inMinutes', { count: soon })}</Badge>
      ) : (
        !event.allDay && (
          <IconButton
            size="sm"
            label={t(briefLabel(brief))}
            hint={brief?.error}
            disabled={busy}
            className={brief?.phase === 'ready' ? 'text-accent' : undefined}
            icon={busy || brief?.phase === 'preparing' ? <Spinner /> : <FileText className="size-3.5" aria-hidden />}
            onClick={onBrief}
          />
        )
      )}
    </li>
  )
}

/**
 * People: what you have to talk about with each person, and when. The list on the left (the
 * number is their open topics); on the right the person's next meeting, "Join" and "Prepare 1:1"
 * once, the open inbox items that involve them, and the meetings you have together this week.
 * Editing and removing a person live in the "⋯" menu; edits save to the profile.
 */
export function PeopleTab({ profile, view, now, busy, brief, oneOnOne, openLink, openItem }: PlanTabContext) {
  const { t, tn } = useI18n()
  const toast = useToast()
  const when = useWhen()
  const people = plannerSettings(profile).people
  const [selected, setSelected] = useState<string | null>(people[0]?.id ?? null)
  const [query, setQuery] = useState('')
  // The person form in its dialog: a new person, or the one being edited.
  const [editing, setEditing] = useState<{ form: PersonForm; baseline: PersonForm; isNew: boolean } | null>(null)
  const [nameError, setNameError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Person | null>(null)
  const [adding, setAdding] = useState<InboxItemForm | null>(null)
  const { view: work } = usePlanner(profile.id, true)
  const { busy: acting, onAction, dialog } = useInboxActions(profile.id, () => undefined, inboxSettings(plannerSettings(profile)).project)
  const current = people.find((p) => p.id === selected) ?? people[0]
  const inbox = work?.inbox ?? []
  const q = query.trim().toLowerCase()
  const listed = q ? people.filter((p) => p.name.toLowerCase().includes(q)) : people
  const areas = [...new Set([...inboxSettings(plannerSettings(profile)).areas, ...inbox.map((i) => i.area).filter((a): a is string => Boolean(a))])]

  const savePeople = async (next: Person[]) => {
    setSaving(true)
    try {
      const r = await window.hub.config.saveProfile({ ...profile, planner: { ...plannerSettings(profile), people: next } })
      if (!r.ok) {
        toast(r.issues[0]?.message ?? t('plan.people.saveFailed'), 'danger')
        return false
      }
      await refreshConfig()
      return true
    } finally {
      setSaving(false)
    }
  }
  const save = async () => {
    if (!editing) return
    if (!editing.form.name.trim()) return setNameError(true)
    const person = formToPerson(editing.isNew ? { ...editing.form, id: personId(editing.form.name, people.map((p) => p.id)) } : editing.form)
    const next = editing.isNew ? [...people, person] : people.map((p) => (p.id === person.id ? person : p))
    if (await savePeople(next)) {
      toast(t('plan.people.saved'))
      setSelected(person.id)
      setEditing(null)
    }
  }
  const remove = async (id: string) => {
    if (await savePeople(people.filter((p) => p.id !== id))) setSelected(people.find((p) => p.id !== id)?.id ?? null)
  }
  const openEditor = (person: Person | null) => {
    const form = person ? personToForm(person) : blank()
    setNameError(false)
    setEditing({ form, baseline: form, isNew: person === null })
  }

  const meetings = current ? meetingsWith(current, view.events, now) : []
  const week = withinWeek(meetings, now)
  const next = meetings[0]
  const topics = current ? openItemsOf(inbox, current.id) : []
  const soon = next ? minutesUntil(next, now) : null
  const facts = current
    ? [
        next ? t('plan.people.nextMeeting', { when: when.short(next.start, now) }) : t('plan.people.noNext'),
        ...(next && isOngoing(next, now) ? [t('plan.now')] : soon !== null ? [t('plan.people.inMinutes', { count: soon })] : []),
        tn('plan.people.topics', topics.length),
        tn('plan.people.week', week.length)
      ]
    : []

  return (
    <div className="grid grid-cols-1 gap-3.5 @min-[760px]:h-[calc(100vh-16rem)] @min-[760px]:min-h-[30rem] @min-[760px]:grid-cols-[16rem_minmax(0,1fr)] @min-[1100px]:grid-cols-[18rem_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col gap-0.5 rounded-lg border border-border bg-surface p-2 shadow-sm">
        <div className="flex items-center gap-2 px-0.5 pt-0.5 pb-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle" aria-hidden />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('plan.people.search')} aria-label={t('plan.people.search')} className="pl-8" />
          </div>
          <IconButton label={t('plan.people.add')} icon={<Plus className="size-4" aria-hidden />} className="border border-border" onClick={() => openEditor(null)} />
        </div>
        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto" aria-label={t('plan.people.title')}>
          {people.length === 0 && <li className="px-2 py-2 text-sm text-muted">{t('plan.people.empty')}</li>}
          {people.length > 0 && listed.length === 0 && <li className="px-2 py-2 text-sm text-muted">{t('plan.people.noMatch')}</li>}
          {listed.map((p) => {
            const first = meetingsWith(p, view.events, now)[0]
            const open = openItemsOf(inbox, p.id).length
            const on = p.id === current?.id
            return (
              <li key={p.id}>
                <button
                  type="button"
                  aria-current={on || undefined}
                  onClick={() => setSelected(p.id)}
                  className={cn('flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40', on ? 'bg-accent-soft' : 'hover:bg-surface-hover')}
                  data-testid="person-row"
                >
                  <PersonAvatar name={p.name} />
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate', on ? 'font-semibold' : 'font-medium')}>{p.name}</span>
                    <span className="flex items-center gap-1 truncate text-xs text-subtle">
                      {first && <Clock className="size-3 shrink-0" aria-hidden />}
                      {first ? when.short(first.start, now) : t('plan.people.noNext')}
                    </span>
                  </span>
                  {open > 0 && (
                    <Badge title={tn('plan.people.topics', open)} aria-label={tn('plan.people.topics', open)}>
                      {open}
                    </Badge>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
        {people.length > 0 && <p className="mt-auto px-2 pt-2 text-xs text-subtle">{t('plan.people.countHint')}</p>}
      </div>

      {!current ? (
        <EmptyState icon={<UserRound className="size-6" aria-hidden />} title={t('plan.people.pick')} description={t('plan.people.pickHint')} />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-col gap-3">
          <PersonHeader person={current} facts={facts} joinUrl={next?.meetingUrl} preparing={busy === `person:${current.id}`} onJoin={openLink} onOneOnOne={() => oneOnOne(current.id)} onEdit={() => openEditor(current)} onRemove={() => setDeleting(current)} />

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 @min-[1000px]:grid-cols-[minmax(0,1fr)_18rem] @min-[1100px]:grid-cols-[minmax(0,1fr)_20rem]">
            <section className="flex min-h-0 flex-col rounded-lg border border-border bg-surface px-4 pt-3 pb-1 shadow-sm" data-testid="person-inbox" aria-labelledby="person-talk">
              <div className="flex items-center gap-2 pb-2">
                <h3 id="person-talk" className="text-md font-semibold">
                  {t('plan.people.talk')}
                </h3>
                <span className="text-xs text-subtle">{tn('plan.people.topics', topics.length)}</span>
                <Button size="sm" variant="ghost" className="ml-auto" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => setAdding({ ...EMPTY_ITEM_FORM, people: [current.id] })}>
                  {t('plan.people.addTopic')}
                </Button>
              </div>
              {topics.length === 0 ? (
                <p className="border-t border-border py-3 text-sm text-muted">{t('planner.people.noOpenItems')}</p>
              ) : (
                <ul className="min-h-0 flex-1 overflow-y-auto">
                  {topics.map((i) => (
                    <TopicRow key={i.id} item={i} busy={acting === i.id} onDone={() => onAction(i)('done')} onOpen={() => openItem('inbox', i.id)} />
                  ))}
                </ul>
              )}
            </section>

            <section className="flex min-h-0 flex-col rounded-lg border border-border bg-surface px-4 pt-3 pb-1 shadow-sm" aria-labelledby="person-meetings">
              <div className="flex items-baseline gap-2 pb-2">
                <h3 id="person-meetings" className="text-md font-semibold">
                  {t('plan.people.together')}
                </h3>
                <span className="ml-auto text-xs text-subtle">{t('plan.people.nextDays')}</span>
              </div>
              {week.length === 0 ? (
                <p className="border-t border-border py-3 text-sm text-muted">{current.emails.length ? t('plan.people.noWeek') : t('plan.people.noEmails')}</p>
              ) : (
                <ul className="min-h-0 flex-1 overflow-y-auto">
                  {week.map((e) => (
                    <MeetingRow key={e.id} event={e} brief={view.briefs[e.id]} now={now} busy={busy === `event:${e.id}`} onBrief={() => brief(e.id)} />
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing?.isNew ? t('plan.people.newTitle') : t('plan.people.editTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" disabled={saving || (!!editing && !editing.isNew && !isDirty(editing.baseline, editing.form))} onClick={() => void save()}>
              {t('plan.people.save')}
            </Button>
          </>
        }
      >
        {editing && <PersonFields form={editing.form} onChange={(patch) => setEditing((e) => (e ? { ...e, form: { ...e.form, ...patch } } : e))} nameError={nameError ? t('plan.person.nameRequired') : undefined} />}
      </Dialog>
      <AddItemDialog profile={profile} initial={adding} areas={areas} title={current ? t('plan.people.addTopicTitle', { name: current.name }) : undefined} onClose={() => setAdding(null)} />
      <ConfirmDeleteDialog
        name={deleting?.name ?? ''}
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('plan.people.confirmDelete', { name: deleting?.name ?? '' })}
        description={t('plan.people.confirmDeleteBody')}
        onConfirm={() => {
          if (deleting) void remove(deleting.id)
        }}
      />
      {dialog}
    </div>
  )
}
