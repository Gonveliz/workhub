import { MessageSquareShare, SquarePlus } from 'lucide-react'
import { useState } from 'react'
import type { SessionRequest, SessionRequestAnswer } from '@shared/session-requests-api'
import { Button } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { useSessionRequests } from '../../chatStore'
import { errorText } from '../../lib/errorText'
import { pushItem } from '../../store'

const FAILURE: Record<Exclude<SessionRequestAnswer, { ok: true }>['error'], MessageKey> = {
  gone: 'sessionRequests.error.gone',
  agent: 'sessionRequests.error.agent',
  folder: 'sessionRequests.error.folder',
  unattended: 'sessionRequests.error.unattended',
  failed: 'sessionRequests.error.failed'
}

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

/**
 * What this session's agent asked of other sessions, waiting for the user: a new session it
 * proposed, or its first message to another session. Nothing happens until Approve.
 */
export function SessionRequestsBar({ sessionId }: { sessionId: string }) {
  return <SessionRequestList sessionId={sessionId} requests={useSessionRequests(sessionId)} />
}

/** The requests themselves, each with its text in full and the user's two answers. */
export function SessionRequestList({ sessionId, requests }: { sessionId: string; requests: readonly SessionRequest[] }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState<string | null>(null)
  if (!requests.length) return null
  const answer = async (r: SessionRequest, approve: boolean) => {
    setBusy(r.id)
    try {
      if (!approve) return await window.hub.sessionRequests.dismiss(r.id)
      const result = await window.hub.sessionRequests.approve(r.id)
      if (!result.ok) pushItem(sessionId, 'error', t(FAILURE[result.error] ?? 'sessionRequests.error.failed', { detail: result.detail ?? '' }))
    } catch (e) {
      pushItem(sessionId, 'error', errorText(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <section data-testid="session-requests" aria-label={t('sessionRequests.title')} className="flex max-h-[40%] shrink-0 flex-col gap-2 overflow-y-auto border-b border-border bg-accent-soft px-4 py-2 text-sm text-text">
      {requests.map((r) => (
        <div key={r.id} data-testid="session-request" data-kind={r.kind} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            {r.kind === 'start' ? <SquarePlus className="size-4 shrink-0 text-accent" aria-hidden /> : <MessageSquareShare className="size-4 shrink-0 text-accent" aria-hidden />}
            <span className="min-w-0 flex-1" title={r.kind === 'start' ? r.cwd : undefined}>
              {r.kind === 'start'
                ? t(r.name ? 'sessionRequests.startNamed' : 'sessionRequests.start', { agent: r.agentName, folder: folderName(r.cwd), name: r.name ?? '' })
                : t('sessionRequests.message', { to: r.toName })}
            </span>
            <Button size="sm" variant="primary" disabled={busy === r.id} data-testid="session-request-approve" onClick={() => void answer(r, true)}>
              {r.kind === 'start' ? t('sessionRequests.approveStart') : t('sessionRequests.approveMessage')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy === r.id} data-testid="session-request-dismiss" onClick={() => void answer(r, false)}>
              {t('sessionRequests.dismiss')}
            </Button>
          </div>
          <p className="max-h-32 overflow-y-auto rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap break-words" aria-label={r.kind === 'start' ? t('sessionRequests.prompt') : t('sessionRequests.text')}>
            {r.kind === 'start' ? r.prompt : r.text}
          </p>
          <p className="text-xs text-muted">{r.kind === 'start' ? t('sessionRequests.startHint') : t('sessionRequests.messageHint', { to: r.toName })}</p>
        </div>
      ))}
    </section>
  )
}
