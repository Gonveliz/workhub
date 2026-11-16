import { useEffect, useRef, useState } from 'react'
import type { InstallerId, InstallPlanEntry } from '@workhub/core'
import type { InstallItemView, InstallQueueSnapshot } from '@shared/setup-api'
import { Button } from '../atoms/Button'
import { Spinner } from '../atoms/Spinner'
import { Dialog } from '../molecules/Dialog'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { formatBytes } from '../../lib/localReview'

/** The progress line of one install: its phase, the download's percent, or why it failed. */
export function installStateText(t: ReturnType<typeof useI18n>['t'], item: InstallItemView): string {
  if (item.state === 'downloading' && item.total) return t('setup.installAll.downloadingPercent', { percent: String(Math.min(100, Math.floor(((item.received ?? 0) / item.total) * 100))) })
  if (item.state === 'failed') return t(`setup.installAll.reason.${item.reason ?? 'failed'}` as MessageKey)
  return t(`setup.installAll.state.${item.state}` as MessageKey)
}

/** How a finished queue ended, for the line under its items: null while it runs or before any install. */
export function installOutcome(snapshot: InstallQueueSnapshot | null): 'done' | 'incomplete' | null {
  if (!snapshot || snapshot.running || snapshot.items.length === 0) return null
  return snapshot.items.every((i) => i.state === 'done') ? 'done' : 'incomplete'
}

/**
 * The lines kept after a queue describe that queue: they stay through the check its end starts
 * (the first one) and go when another check starts, because by then they may no longer be true
 * (the tool was removed in Settings, say).
 */
export function keepLinesForCheck(checksSinceQueue: number): boolean {
  return checksSinceQueue <= 1
}

/**
 * "Install what is missing": lists what it will download, from where and how large, waits for one
 * confirmation, then runs the installs one after another with a line each (Try again on a failed
 * one, Cancel while it runs). The main process decides the order and adds Node.js when needed; the
 * renderer only names installers. `busy` (the check running again) only disables the button: the
 * component stays mounted, so the lines of what was installed stay on screen after the queue ends.
 */
export function InstallMissing({ installers, onDone, busy = false }: { installers: readonly InstallerId[]; onDone: () => void; busy?: boolean }) {
  const { t, locale } = useI18n()
  const [plan, setPlan] = useState<InstallPlanEntry[] | null>(null)
  const [snapshot, setSnapshot] = useState<InstallQueueSnapshot | null>(null)
  const [mine, setMine] = useState(false)
  const wasRunning = useRef(false)
  const wasBusy = useRef(busy)
  const checksSinceQueue = useRef(0)
  const done = useRef(onDone)
  done.current = onDone

  useEffect(() => {
    const off = window.hub.setup.onInstallProgress((next) => {
      setSnapshot(next)
      // The check runs again once the queue ends, so the rows show what was installed.
      if (wasRunning.current && !next.running) done.current()
      wasRunning.current = next.running
    })
    void window.hub.setup.installState().then((s) => {
      wasRunning.current = s.running
      if (s.running) {
        setSnapshot(s)
        setMine(true)
      }
    })
    return off
  }, [])

  const running = snapshot?.running === true
  useEffect(() => {
    if (running) checksSinceQueue.current = 0
  }, [running])
  useEffect(() => {
    const started = busy && !wasBusy.current
    wasBusy.current = busy
    if (!started || running || !mine) return
    checksSinceQueue.current += 1
    if (!keepLinesForCheck(checksSinceQueue.current)) {
      checksSinceQueue.current = 0
      setMine(false)
    }
  }, [busy, running, mine])
  const ask = () => void window.hub.setup.installPlan([...installers]).then(setPlan)
  const start = () => {
    const ids = (plan ?? []).map((e) => e.installer)
    setPlan(null)
    // The last snapshot may be an earlier queue's (a row's own Install): its lines are not this one's.
    setSnapshot(null)
    checksSinceQueue.current = 0
    setMine(true)
    void window.hub.setup.installMany(ids).then(setSnapshot)
  }
  const name = (id: InstallerId) => t(`setup.tool.${id}` as MessageKey)
  const lines = mine ? (snapshot?.items ?? []) : []
  const outcome = mine ? installOutcome(snapshot) : null

  if (installers.length === 0 && lines.length === 0) return null
  return (
    <div className="flex flex-col gap-2" data-testid="install-missing">
      <div className="flex items-center gap-2">
        {installers.length > 0 && (
          <Button size="sm" variant="primary" disabled={running || busy} onClick={ask}>
            {t('setup.installAll')}
          </Button>
        )}
        {running && (
          <>
            <Spinner />
            <Button size="sm" variant="ghost" onClick={() => window.hub.setup.cancelInstalls()}>
              {t('common.cancel')}
            </Button>
          </>
        )}
      </div>
      {lines.length > 0 && (
        <ul role="status" className="divide-y divide-border rounded-lg border border-border bg-surface text-sm">
          {lines.map((item) => (
            <li key={item.installer} className="flex flex-col gap-1 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 font-medium">{name(item.installer)}</span>
                <span className={item.state === 'failed' ? 'text-danger' : item.state === 'done' ? 'text-success' : 'text-muted'}>{installStateText(t, item)}</span>
                {(item.state === 'failed' || item.state === 'canceled') && !running && (
                  <Button size="sm" onClick={() => void window.hub.setup.retryInstall(item.installer).then(setSnapshot)}>
                    {t('setup.installAll.retry')}
                  </Button>
                )}
              </div>
              {item.state === 'failed' && item.detail && <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-sm bg-surface-hover p-2 text-xs">{item.detail}</pre>}
            </li>
          ))}
        </ul>
      )}
      {outcome && (
        <p role="status" data-testid="install-missing-outcome" className={outcome === 'done' ? 'text-sm text-success' : 'text-sm text-danger'}>
          {t(outcome === 'done' ? 'setup.installAll.allDone' : 'setup.installAll.incomplete')}
        </p>
      )}
      <Dialog
        open={plan !== null}
        onOpenChange={(open) => !open && setPlan(null)}
        title={t('setup.installAll.title')}
        description={t('setup.installAll.body')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPlan(null)}>
              {t('common.cancel')}
            </Button>
            <Button autoFocus variant="primary" disabled={!plan?.length} data-testid="install-missing-confirm" onClick={start}>
              {t('setup.installAll.start')}
            </Button>
          </>
        }
      >
        {plan?.length === 0 && <p className="text-sm text-muted">{t('setup.installAll.nothing')}</p>}
        <ul className="flex flex-col gap-2">
          {(plan ?? []).map((e) => (
            <li key={e.installer} className="text-sm">
              <span className="font-medium">{name(e.installer)}</span>
              {e.version && <span className="text-muted"> {e.version}</span>}
              <span className="block text-xs text-muted">
                {[
                  t('setup.installAll.from', { source: e.source }),
                  e.bytes ? t('setup.installAll.size', { size: formatBytes(e.bytes, locale) }) : t('setup.installAll.sizeUnknown'),
                  e.diskBytes ? t('setup.installAll.onDisk', { size: formatBytes(e.diskBytes, locale) }) : '',
                  e.managed ? t('setup.installAll.managed') : '',
                  e.checksum ? '' : t('setup.installAll.noChecksum')
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  )
}
