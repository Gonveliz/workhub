import { Copy, GitPullRequestCreate } from 'lucide-react'
import { useEffect, useState } from 'react'
import { prName, type PullRequest } from '@workhub/core'
import type { PullRequestDraftResult } from '@shared/codehost-api'
import { Button, Input, Switch, Textarea } from '../../components/atoms'
import { Dialog, useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { failureKey, hasOpenPullRequestFor } from '../../lib/pullRequestFlow'
import { MonitorSection } from './MonitorSection'

type Ready = Extract<PullRequestDraftResult, { state: 'ready' }>

/** The session's branch as "Create pull request" sees it, read while the monitor shows and again every minute. */
function usePullRequestDraft(sessionId: string, visible: boolean, refreshKey: string): [PullRequestDraftResult | null, () => void] {
  const [draft, setDraft] = useState<PullRequestDraftResult | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!visible) return
    let alive = true
    const read = () => void window.hub.codeHost.draftPullRequest(sessionId).then((d) => alive && setDraft(d), () => undefined)
    read()
    const timer = setInterval(read, 60_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [sessionId, visible, refreshKey, tick])
  return [draft, () => setTick((n) => n + 1)]
}

/**
 * "Create pull request" in the session monitor: offered when the session's branch is pushed, has
 * commits and no open pull request. A branch the remote does not have (or has behind) gets the push
 * command to copy instead: Workhub never pushes it.
 */
export function CreatePullRequestSection({ sessionId, profileId, visible, known, refreshKey }: { sessionId: string; profileId: string | null; visible: boolean; known: readonly PullRequest[]; refreshKey: string }) {
  const { t, tn } = useI18n()
  const notify = useToast()
  const [draft, reread] = usePullRequestDraft(sessionId, visible, refreshKey)
  const [form, setForm] = useState<Ready | null>(null)
  if (!draft || draft.state === 'unavailable' || hasOpenPullRequestFor(known, draft)) return null
  const copy = (command: string) => void navigator.clipboard.writeText(command).then(() => notify(t('pr.create.copied')))
  return (
    <MonitorSection id="newPullRequest" title={t('pr.create.section')}>
      {draft.state === 'notPushed' ? (
        <div className="flex flex-col gap-1.5 text-xs" data-testid="create-pr-not-pushed">
          <p className="text-muted">{draft.onRemote ? tn('pr.create.unpushed', draft.unpushed, { branch: draft.branch }) : t('pr.create.notPushed', { branch: draft.branch })}</p>
          <div className="flex items-center gap-1.5">
            <code className="min-w-0 flex-1 truncate rounded bg-sidebar px-1.5 py-1 font-mono select-text" title={draft.command}>
              {draft.command}
            </code>
            <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" aria-hidden />} onClick={() => copy(draft.command)}>
              {t('pr.create.copy')}
            </Button>
          </div>
          <p className="text-subtle">{t('pr.create.noPush')}</p>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-1.5 text-xs">
          <p className="text-muted">{t('pr.create.ready', { branch: draft.branch })}</p>
          <Button size="sm" variant="secondary" icon={<GitPullRequestCreate className="size-3.5" aria-hidden />} data-testid="create-pr-open" onClick={() => setForm(draft)}>
            {t('pr.create.open')}
          </Button>
        </div>
      )}
      {form && (
        <CreatePullRequestDialog
          sessionId={sessionId}
          draft={form}
          onClose={() => setForm(null)}
          onCreated={(url) => {
            setForm(null)
            reread()
            void window.hub.codeHost.openWindow(profileId, url)
          }}
        />
      )}
    </MonitorSection>
  )
}

/** The form: title, description, base and draft, prefilled; nothing is sent until the user confirms. */
function CreatePullRequestDialog({ sessionId, draft, onClose, onCreated }: { sessionId: string; draft: Ready; onClose: () => void; onCreated: (url: string) => void }) {
  const { t } = useI18n()
  const notify = useToast()
  const [title, setTitle] = useState(draft.title)
  const [body, setBody] = useState(draft.body)
  const [base, setBase] = useState(draft.base)
  const [isDraft, setIsDraft] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; key?: ReturnType<typeof failureKey> } | null>(null)
  const submit = async () => {
    setBusy(true)
    const r = await window.hub.codeHost.createPullRequest(sessionId, { title, body, base, draft: isDraft })
    setBusy(false)
    if (!r.ok) return setError({ text: r.error, key: failureKey(r.kind) })
    notify(t('pr.create.done', { name: createdName(r.url) }))
    onCreated(r.url)
  }
  const repo = `${draft.repository.owner}/${draft.repository.repo}`
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title={t('pr.create.title')}
      description={t('pr.create.description', { branch: draft.branch, base: base || draft.base, repo })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={busy || !title.trim() || !base.trim()} data-testid="create-pr-confirm" onClick={() => void submit()}>
            {busy ? t('pr.create.creating') : t('pr.create.confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">{t('pr.create.titleLabel')}</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">{t('pr.create.body')}</span>
          <Textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} className="font-sans" />
          {draft.body && <span className="text-xs text-subtle">{t('pr.create.bodyFromBrief')}</span>}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">{t('pr.create.base')}</span>
          <Input value={base} onChange={(e) => setBase(e.target.value)} className="font-mono" />
        </label>
        <label className="flex items-center gap-2.5">
          <Switch checked={isDraft} onChange={setIsDraft} aria-label={t('pr.create.draft')} />
          <span>{t('pr.create.draft')}</span>
        </label>
        {error && (
          <div role="alert" className="text-sm text-danger">
            {error.key && <p>{t(error.key)}</p>}
            <p className="text-xs break-words">{t('pr.action.failed', { message: error.text })}</p>
          </div>
        )}
      </div>
    </Dialog>
  )
}

/** `repo#12` of a created PR's URL for the toast, else the URL. */
export function createdName(url: string): string {
  const m = /\/([^/]+)\/(?:-\/)?(pull|merge_requests)\/(\d+)/.exec(url)
  return m ? prName({ repo: m[1]!, number: Number(m[3]) }, m[2] === 'pull' ? 'github' : 'gitlab') : url
}
