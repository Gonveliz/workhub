import { useEffect, useState } from 'react'
import { installSource, type InstallPlanEntry, type SetupFix } from '@workhub/core'
import type { MessageKey } from '../../i18n/translate'
import { InstallPlanList, installStateText } from './InstallMissing'
import { Button } from '../atoms/Button'
import { Spinner } from '../atoms/Spinner'
import { Dialog } from '../molecules/Dialog'
import { useI18n } from '../../i18n/I18nProvider'

/** How long "Done" holds the button after an install: longer than the check that follows takes. */
const INSTALLED_HOLD_MS = 20_000

/**
 * The Install button of a fix Workhub may run: asks first, shows the command, runs the installer
 * the main process names (never this text) with where it downloads from, and reports a failure.
 * Shared with New session and the welcome.
 */
export function InstallAction({ fix, name, onInstalled }: { fix: Extract<SetupFix, { kind: 'install' }>; name: string; onInstalled: () => void }) {
  const { t } = useI18n()
  const [confirming, setConfirming] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [failure, setFailure] = useState<{ reason: string | null; output: string } | null>(null)
  const [phase, setPhase] = useState<string | null>(null)
  // Installed, and the check has not read the row again yet: the button must not offer it a second time.
  const [installed, setInstalled] = useState(false)
  // "Install what is missing" (or another row) is installing: one install at a time.
  const [queueRunning, setQueueRunning] = useState(false)
  // What this one install downloads, Node.js included when it comes along: the same list as "Install what is missing".
  const [plan, setPlan] = useState<InstallPlanEntry[] | null>(null)
  const source = installSource(fix.command)
  useEffect(() => {
    if (!confirming || !fix.managed) return
    let live = true
    void window.hub.setup.installPlan([fix.installer]).then(
      (entries) => live && setPlan(entries),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [confirming, fix.installer, fix.managed])
  // The same queue as "Install what is missing": its progress line for this installer.
  useEffect(() => {
    void window.hub.setup.installState().then((s) => setQueueRunning(s.running))
    return window.hub.setup.onInstallProgress((s) => {
      setQueueRunning(s.running)
      const item = s.items.find((i) => i.installer === fix.installer)
      if (item && item.state !== 'pending') setPhase(installStateText(t, item))
    })
  }, [fix.installer, t])
  // The row goes away once the check finds the tool; if it does not, the button comes back.
  useEffect(() => {
    if (!installed) return
    const timer = setTimeout(() => setInstalled(false), INSTALLED_HOLD_MS)
    return () => clearTimeout(timer)
  }, [installed])
  const install = () => {
    setInstalling(true)
    setFailure(null)
    setPhase(null)
    window.hub.setup.install(fix.installer).then(
      (result) => {
        setInstalling(false)
        if (result.ok) {
          setInstalled(true)
          onInstalled()
        }
        else if (result.reason !== 'canceled') setFailure({ reason: result.reason ? t(`setup.installAll.reason.${result.reason}` as MessageKey) : null, output: result.output.trim() })
      },
      (error: unknown) => {
        setInstalling(false)
        setFailure({ reason: null, output: error instanceof Error ? error.message : String(error) })
      }
    )
  }
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        {installing && phase && <span className="text-sm text-muted">{phase}</span>}
        {installed && !installing && <span className="text-sm text-success">{t('setup.installAll.state.done')}</span>}
        {installing && <Spinner />}
        <Button size="sm" className="shrink-0" disabled={installing || installed || queueRunning} onClick={() => setConfirming(true)}>
          {installing ? t('setup.installing') : t('setup.install')}
        </Button>
      </div>
      {failure !== null && (
        <div role="alert" className="w-full text-sm text-danger">
          <p>{failure.reason ?? t('setup.install.failed')}</p>
          {(failure.output || !failure.reason) && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-sm bg-surface-hover p-2 text-xs text-text">{failure.output || t('setup.install.noOutput')}</pre>}
        </div>
      )}
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('setup.install.title', { name })}
        description={t(fix.managed ? 'setup.install.managedBody' : 'setup.install.body')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              autoFocus
              data-testid="setup-install-confirm"
              onClick={() => {
                setConfirming(false)
                install()
              }}
            >
              {t(fix.managed ? 'setup.install.download' : 'setup.install.run')}
            </Button>
          </>
        }
      >
        {fix.managed && plan && plan.length > 0 ? (
          <InstallPlanList plan={plan} />
        ) : (
          <>
            <code className="block rounded-sm bg-surface-hover px-2 py-1.5 text-xs break-all">{fix.command}</code>
            {source && <p className="mt-2 text-sm text-muted">{t('setup.install.source', { source })}</p>}
          </>
        )}
      </Dialog>
    </div>
  )
}
