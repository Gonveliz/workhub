import { TimerOff } from 'lucide-react'
import { Button } from '../../components/atoms'
import type { SessionView } from '@shared/api'
import { useI18n } from '../../i18n/I18nProvider'
import { formatSince } from '../../lib/sessionHeader'
import { useAsyncAction } from '../../lib/useAsyncAction'
import { useNow } from '../../lib/usage'

/**
 * Under the header while a working session's agent has sent nothing for longer than the
 * preference: it may be stuck, or just thinking. Nothing is stopped for the user.
 */
export function StallNotice({ view: v }: { view: SessionView }) {
  const { t } = useI18n()
  const stop = useAsyncAction(() => window.hub.sessions.stop(v.id))
  const keep = useAsyncAction(() => window.hub.sessions.keepWaiting(v.id))
  const now = useNow(15_000)
  if (v.stalledSince === undefined || v.state !== 'busy') return null
  return (
    <div role="status" data-testid="session-stalled" className="flex shrink-0 items-center gap-2 border-b border-border bg-warning-soft px-4 py-1.5 text-sm text-warning">
      <TimerOff className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{t('session.stalled', { time: formatSince(now - v.stalledSince) })}</span>
      <Button size="sm" variant="ghost" disabled={stop.pending} onClick={() => stop.run()}>
        {t('session.stop')}
      </Button>
      <Button size="sm" variant="ghost" disabled={keep.pending} onClick={() => keep.run()}>
        {t('session.keepWaiting')}
      </Button>
    </div>
  )
}
