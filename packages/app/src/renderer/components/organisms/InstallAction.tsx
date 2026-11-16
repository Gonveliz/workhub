import { useEffect, useState } from 'react'
import { installSource, type SetupFix } from '@workhub/core'
import type { MessageKey } from '../../i18n/translate'
import { installStateText } from './InstallMissing'
import { Button } from '../atoms/Button'
import { Spinner } from '../atoms/Spinner'
import { Dialog } from '../molecules/Dialog'
import { useI18n } from '../../i18n/I18nProvider'

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
  const source = installSource(fix.command)
  // The same queue as "Install what is missing": its progress line for this installer.
  useEffect(() => {
    if (!installing) return
    return window.hub.setup.onInstallProgress((s) => {
      const item = s.items.find((i) => i.installer === fix.installer)
      if (item && item.state !== 'pending') setPhase(installStateText(t, item))
    })
  }, [installing, fix.installer, t])
  const install = () => {
    setInstalling(true)
    setFailure(null)
    setPhase(null)
    window.hub.setup.install(fix.installer).then(
      (result) => {
        setInstalling(false)
        if (result.ok) onInstalled()
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
        {installing && <Spinner />}
        <Button size="sm" className="shrink-0" disabled={installing} onClick={() => setConfirming(true)}>
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
        <code className="block rounded-sm bg-surface-hover px-2 py-1.5 text-xs break-all">{fix.command}</code>
        {source && <p className="mt-2 text-sm text-muted">{t('setup.install.source', { source })}</p>}
      </Dialog>
    </div>
  )
}
