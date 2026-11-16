import { useState } from 'react'
import { RotateCw } from 'lucide-react'
import type { ConfigSnapshot } from '@shared/api'
import { Button } from '../atoms'
import { useToast } from '../molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { refreshConfig } from '../../configStore'

/**
 * Shown above every screen of the main window while the config file could not be loaded: the app
 * then runs on an empty stand-in config, so without it the user would only see an empty app.
 */
export function ConfigLoadErrorBanner({ snap }: { snap: ConfigSnapshot | null }) {
  const { t } = useI18n()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  if (!snap?.loadError) return null
  const issues = snap.loadIssues ?? []
  const retry = async () => {
    setBusy(true)
    try {
      const next = await window.hub.config.reload()
      await refreshConfig()
      if (next.loadError) toast(t('configLoad.stillFailing'), 'danger')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div role="alert" className="border-b border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger" data-testid="config-load-error">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{t('configLoad.title')}</p>
          <p className="mt-0.5">{t('configLoad.body')}</p>
          {issues.length ? (
            <ul className="mt-1 list-disc pl-5 font-mono text-xs">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 font-mono text-xs">{snap.loadError}</p>
          )}
          {snap.configPath && <p className="mt-1 select-text break-all text-xs">{t('configLoad.file', { path: snap.configPath })}</p>}
        </div>
        <Button size="sm" variant="secondary" disabled={busy} icon={<RotateCw className="size-3.5" aria-hidden />} onClick={() => void retry()}>
          {t('configLoad.retry')}
        </Button>
      </div>
    </div>
  )
}
