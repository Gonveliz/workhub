import { useEffect, useState } from 'react'
import { LogOut } from 'lucide-react'
import type { QuitIntent } from '@shared/quit-api'
import { Button } from '../atoms'
import { useI18n } from '../../i18n/I18nProvider'

/**
 * Shown above every screen while the app waits for the sessions to go idle before it quits (or
 * restarts into an update): it says so and offers to cancel. A new prompt simply postpones it.
 */
export function QuitPendingBanner() {
  const { t } = useI18n()
  const [pending, setPending] = useState<QuitIntent | null>(null)
  useEffect(() => {
    let live = true
    void window.hub.quit.pending().then((p) => live && setPending(p))
    const off = window.hub.quit.onPending(setPending)
    return () => {
      live = false
      off()
    }
  }, [])
  if (!pending) return null
  return (
    <div role="status" data-testid="quit-pending" className="flex items-center gap-2 border-b border-border bg-warning-soft px-4 py-1.5 text-sm text-warning">
      <LogOut className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{t(pending === 'restart' ? 'quit.pending.restart' : 'quit.pending.quit')}</span>
      <Button size="sm" variant="ghost" onClick={() => void window.hub.quit.cancelPending()}>
        {t('quit.pending.cancel')}
      </Button>
    </div>
  )
}
