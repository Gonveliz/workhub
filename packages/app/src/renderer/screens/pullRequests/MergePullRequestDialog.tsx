import { Lock } from 'lucide-react'
import { useEffect, useState } from 'react'
import { appOptions, isLongLivedBranch, prName, type MergeMethod, type PullRequest } from '@workhub/core'
import type { SessionView } from '@shared/api'
import { Button, Select, Spinner, Switch } from '../../components/atoms'
import { Dialog, useToast } from '../../components/molecules'
import { useConfig } from '../../configStore'
import { useI18n } from '../../i18n/I18nProvider'
import { failureKey, MERGE_METHOD_LABEL, sessionsOnMergedBranch } from '../../lib/pullRequestFlow'
import { errorText } from '../../lib/errorText'

export interface MergePullRequestDialogProps {
  profileId: string | null
  pr: Pick<PullRequest, 'url' | 'title' | 'branch' | 'base' | 'repo' | 'number' | 'provider' | 'owner'>
  onClose: () => void
  /** After the host merged it. */
  onMerged?: () => void
}

type SessionOutcome = { state: 'closing' } | { state: 'closed' } | { state: 'kept'; text: string }

/**
 * "Merge…": the method (only those the repository allows) and "Delete the branch" (locked for
 * protected branches), confirmed in words that name both. After the merge, open sessions in a
 * worktree on the PR's branch are offered to close with their worktree removed; the removal refuses
 * uncommitted or unpushed work, and nothing happens without a click.
 */
export function MergePullRequestDialog({ profileId, pr, onClose, onMerged }: MergePullRequestDialogProps) {
  const { t, tn } = useI18n()
  const notify = useToast()
  const config = useConfig()
  const [methods, setMethods] = useState<MergeMethod[] | null>(null)
  const [method, setMethod] = useState<MergeMethod | null>(null)
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; key?: ReturnType<typeof failureKey> } | null>(null)
  const [merged, setMerged] = useState<SessionView[] | null>(null)
  const [outcomes, setOutcomes] = useState<Record<string, SessionOutcome>>({})
  const name = prName(pr, pr.provider)

  useEffect(() => {
    let alive = true
    void window.hub.codeHost.mergeMethods(profileId, pr.url).then((r) => {
      if (!alive) return
      if (!r.ok) return setError({ text: r.error })
      setMethods(r.methods)
      setMethod(r.methods[0] ?? null)
    })
    return () => {
      alive = false
    }
  }, [profileId, pr.url])

  const locked = isLongLivedBranch(pr.branch, config ? appOptions(config.config).protectedBranches : undefined)
  const deleting = deleteBranch && !locked

  const submit = async () => {
    if (!method) return
    setBusy(true)
    setError(null)
    const r = await window.hub.codeHost.merge(profileId, pr.url, method, deleting)
    if (!r.ok) {
      setBusy(false)
      return setError({ text: r.error, key: failureKey(r.kind) })
    }
    notify(r.warning ? t('pr.merge.warning', { message: r.warning }) : t('pr.merge.done', { name }))
    onMerged?.()
    const linked = sessionsOnMergedBranch(await window.hub.sessions.list().catch(() => []), pr.branch)
    setBusy(false)
    if (linked.length === 0) return onClose()
    setMerged(linked)
  }

  const closeSession = async (id: string) => {
    setOutcomes((o) => ({ ...o, [id]: { state: 'closing' } }))
    try {
      // Never forced: a worktree with uncommitted or unpushed work stays, and the session with it.
      const r = await window.hub.sessions.closeRemovingWorktree(id, false)
      const kept = r.ok ? null : [r.blocked.dirty ? t('sessions.worktreeDirty') : '', r.blocked.unpushed > 0 ? tn('sessions.worktreeUnpushed', r.blocked.unpushed) : ''].filter(Boolean).join(' ')
      setOutcomes((o) => ({ ...o, [id]: kept === null ? { state: 'closed' } : { state: 'kept', text: kept } }))
    } catch (e) {
      setOutcomes((o) => ({ ...o, [id]: { state: 'kept', text: errorText(e) } }))
    }
  }

  if (merged) {
    return (
      <Dialog
        open
        onOpenChange={(open) => !open && onClose()}
        title={t('pr.merge.after.title', { name })}
        description={t('pr.merge.after.body', { branch: pr.branch })}
        footer={
          <Button variant="ghost" data-testid="merge-after-done" onClick={onClose}>
            {merged.every((s) => outcomes[s.id]) ? t('pr.merge.after.done') : t('pr.merge.after.skip')}
          </Button>
        }
      >
        <ul className="flex flex-col gap-2 text-sm">
          {merged.map((s) => {
            const outcome = outcomes[s.id]
            return (
              <li key={s.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate" title={s.worktree?.path}>
                    {s.name || s.agentName}
                  </span>
                  {outcome?.state === 'closed' ? (
                    <span className="text-xs text-success">{t('pr.merge.after.closed')}</span>
                  ) : (
                    <Button size="sm" variant="secondary" disabled={outcome?.state === 'closing'} onClick={() => void closeSession(s.id)}>
                      {t('sessions.worktreeRemove')}
                    </Button>
                  )}
                </div>
                {outcome?.state === 'kept' && <p className="text-xs text-warning">{t('pr.merge.after.kept', { reason: outcome.text })}</p>}
              </li>
            )
          })}
        </ul>
      </Dialog>
    )
  }

  const summary = method ? t(deleting ? 'pr.merge.summaryDelete' : 'pr.merge.summaryKeep', { head: pr.branch, base: pr.base, method: t(MERGE_METHOD_LABEL[method]) }) : ''
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title={t('pr.merge.title', { name })}
      description={pr.title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={busy || !method} data-testid="merge-pr-confirm" onClick={() => void submit()}>
            {busy ? t('pr.merge.merging') : t('pr.merge.confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        {methods === null && !error ? (
          <p className="flex items-center gap-2 text-muted">
            <Spinner className="size-3.5" /> {t('pr.merge.loadingMethods')}
          </p>
        ) : methods && methods.length === 0 ? (
          <p className="text-warning">{t('pr.merge.noMethods')}</p>
        ) : (
          methods && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">{t('pr.merge.method')}</span>
              <Select value={method ?? ''} onChange={(v) => setMethod(v as MergeMethod)} options={methods.map((m) => ({ value: m, label: t(MERGE_METHOD_LABEL[m]) }))} aria-label={t('pr.merge.method')} />
            </label>
          )
        )}
        {locked ? (
          <p className="flex items-center gap-1.5 text-muted">
            <Lock className="size-3.5 shrink-0" aria-hidden />
            {t('pr.close.protected', { branch: pr.branch })}
          </p>
        ) : (
          <label className="flex items-center gap-2.5">
            <Switch checked={deleteBranch} onChange={setDeleteBranch} aria-label={t('pr.close.deleteBranch', { branch: pr.branch })} />
            <span>{t('pr.close.deleteBranch', { branch: pr.branch })}</span>
          </label>
        )}
        {summary && (
          <p className="text-muted" data-testid="merge-pr-summary">
            {summary}
          </p>
        )}
        {error && (
          <div role="alert" className="text-danger">
            {error.key && <p>{t(error.key)}</p>}
            <p className="text-xs break-words">{t('pr.action.failed', { message: error.text })}</p>
          </div>
        )}
      </div>
    </Dialog>
  )
}
