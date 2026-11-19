import { useState } from 'react'
import { inboxSettings, INBOX_KINDS, plannerSettings, type InboxKind, type Profile } from '@workhub/core'
import { Button, Input, Select, Textarea } from '../../components/atoms'
import { Dialog, Field, useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { formToProposal, INBOX_KIND_LABEL, type InboxItemForm } from '../../lib/planner'
import { PeoplePicker } from './PeoplePicker'

/**
 * "Add item" in a dialog, so nothing on the tab moves: the Inbox opens it empty, a person's
 * "Add topic" with that person picked. A title already open asks before adding it again.
 */
export function AddItemDialog({ profile, initial, areas, title, onClose }: { profile: Profile; initial: InboxItemForm | null; areas: string[]; title?: string; onClose: () => void }) {
  const { t } = useI18n()
  const toast = useToast()
  const settings = inboxSettings(plannerSettings(profile))
  const people = plannerSettings(profile).people
  const [form, setForm] = useState<InboxItemForm | null>(initial)
  const [opened, setOpened] = useState(initial)
  const [duplicate, setDuplicate] = useState(false)
  // A new request (another person's "Add topic") starts the form over.
  if (initial !== opened) {
    setOpened(initial)
    setForm(initial)
    setDuplicate(false)
  }
  const close = () => {
    setDuplicate(false)
    onClose()
  }
  const add = async (force = false) => {
    if (!form) return
    const proposal = formToProposal(form)
    if (!proposal.title) return toast(t('planner.inbox.titleRequired'), 'danger')
    const r = await window.hub.planner.addItem(profile.id, proposal, force)
    if (r.ok) return close()
    if (r.duplicateOf) return setDuplicate(true)
    toast(r.error, 'danger')
  }
  const set = (patch: Partial<InboxItemForm>) => setForm((f) => (f ? { ...f, ...patch } : f))
  const levelOptions = [{ value: '', label: t('planner.inbox.none') }, ...settings.criticalities.map((c) => ({ value: c.name, label: c.name }))]
  const areaOptions = [{ value: '', label: t('planner.inbox.none') }, ...areas.map((a) => ({ value: a, label: a }))]
  return (
    <Dialog
      open={form !== null}
      onOpenChange={(open) => !open && close()}
      title={title ?? t('planner.inbox.addTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void add()}>
            {t('planner.inbox.addSave')}
          </Button>
        </>
      }
    >
      {form && (
        <div className="grid grid-cols-2 gap-3" data-testid="inbox-add">
          <Field label={t('planner.inbox.kind')}>
            <Select value={form.kind} onChange={(v) => set({ kind: v as InboxKind })} options={INBOX_KINDS.map((k) => ({ value: k, label: t(INBOX_KIND_LABEL[k]) }))} />
          </Field>
          <Field label={t('planner.inbox.dueLabel')}>
            <Input type="date" value={form.due} onChange={(e) => set({ due: e.target.value })} />
          </Field>
          <Field label={t('planner.inbox.title')} className="col-span-2">
            <Input
              autoFocus
              value={form.title}
              onChange={(e) => {
                set({ title: e.target.value })
                setDuplicate(false)
              }}
              maxLength={300}
            />
          </Field>
          <Field label={t('planner.inbox.detail')} hint={t('planner.detail.markdownHint')} className="col-span-2">
            <Textarea rows={3} value={form.detail} onChange={(e) => set({ detail: e.target.value })} />
          </Field>
          <Field label={t('planner.inbox.area')}>
            <Select value={form.area} onChange={(v) => set({ area: v })} options={areaOptions} />
          </Field>
          <Field label={t('planner.inbox.criticality')}>
            <Select value={form.criticality} onChange={(v) => set({ criticality: v })} options={levelOptions} />
          </Field>
          {people.length > 0 && (
            <Field label={t('planner.inbox.people')} className="col-span-2">
              <PeoplePicker people={people} value={form.people} onChange={(ids) => set({ people: ids })} />
            </Field>
          )}
          {duplicate && (
            <p role="alert" className="col-span-2 flex items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
              <span className="flex-1">{t('planner.inbox.duplicate')}</span>
              <Button size="sm" variant="ghost" onClick={() => void add(true)}>
                {t('planner.inbox.addAnyway')}
              </Button>
            </p>
          )}
        </div>
      )}
    </Dialog>
  )
}
