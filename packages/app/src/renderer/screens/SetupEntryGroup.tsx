import { useState } from 'react'
import { Button } from '../components/atoms'
import { useI18n } from '../i18n/I18nProvider'
import type { SetupPage } from '@shared/setup-api'
import { SettingRow, SettingsGroup } from './settings/SettingsLayout'
import { StorageRecoveredNotice, useStorageInfo } from './settings/StorageNotice'

const ENTRIES: readonly (readonly [SetupPage, 'check' | 'welcome' | 'help'])[] = [
  ['check', 'check'],
  ['welcome', 'welcome'],
  ['help', 'help']
]

/** Settings → Advanced › Diagnostics and help: a damaged database moved aside (if ever), the way back to the setup check, the welcome tour and "How Workhub works". */
export function SetupEntryGroup() {
  const { t } = useI18n()
  const [storage] = useStorageInfo()
  const [exported, setExported] = useState<string | null>(null)
  const exportDiagnostics = async () => {
    setExported(null)
    const r = await window.hub.diagnostics.exportDiagnostics()
    if (r.ok) setExported(t('setup.entry.exportDone', { files: String(r.files), folder: r.folder }))
    else if (!r.canceled) setExported(t('setup.entry.exportFailed', { error: r.error ?? '' }))
  }
  return (
    <SettingsGroup anchor="diagnostics" title={t('settingsV2.advanced.diagnostics')}>
      <StorageRecoveredNotice info={storage} />
      {ENTRIES.map(([page, key]) => (
        <SettingRow key={page} label={t(`setup.entry.${key}`)} hint={t(`setup.entry.${key}Hint`)}>
          <Button size="sm" onClick={() => window.hub.setup.openWindow(page)}>
            {t('setup.entry.open')}
          </Button>
        </SettingRow>
      ))}
      <SettingRow label={t('setup.entry.export')} hint={exported ?? t('setup.entry.exportHint')}>
        <Button size="sm" onClick={() => void exportDiagnostics()}>
          {t('setup.entry.exportButton')}
        </Button>
      </SettingRow>
    </SettingsGroup>
  )
}
