import { Database, FolderCog } from 'lucide-react'
import { useEffect, useState } from 'react'
import { appOptions } from '@workhub/core'
import { Button, Switch } from '../../components/atoms'
import { SwitchRow, useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { errorText } from '../../lib/errorText'
import { fileName, formatBytes } from '../../lib/localReview'
import { SetupEntryGroup } from '../SetupEntryGroup'
import { UpdatesSettings } from '../UpdatesSettings'
import { VoiceSettingsGroup } from '../VoiceSettings'
import { LanguageAppearanceGroup } from './AppearanceGroup'
import { SettingsGroup } from './SettingsLayout'
import { StorageRecoveredNotice, useStorageInfo } from './StorageNotice'
import { RestoreBackupsRow } from './RestoreBackupsRow'
import { StorageUsageRow } from './StorageUsageRow'
import type { SectionProps } from './shared'

/** "Keep running in the menu bar" says where the icon stays on each platform. */
const KEEP_LABEL: Record<string, MessageKey> = { mac: 'settingsV2.general.keepInTray', windows: 'settingsV2.general.keepInTrayWindows', linux: 'settingsV2.general.keepInTrayLinux' }

/** Settings → General: language and appearance, opening and closing, voice, and updates. */
export function GeneralSection({ snap, run }: SectionProps) {
  const { t } = useI18n()
  const options = appOptions(snap.config)
  const editable = !snap.loadError
  const keepLabel = t(KEEP_LABEL[window.hub.platform] ?? 'settingsV2.general.keepInTray')
  return (
    <div className="flex flex-col gap-6" data-testid="settings-general">
      <LanguageAppearanceGroup />
      <SettingsGroup
        anchor="openClose"
        title={t('settingsV2.general.openClose')}
        help={t('help.general.sessions')}
        footnote={window.hub.platform === 'linux' ? t('settings.keepInTrayLinuxNote') : undefined}
      >
        <SwitchRow label={t('settingsV2.general.reopenSessions')} hint={t('settingsV2.general.reopenSessionsHint')}>
          <Switch checked={options.reopenSessions} disabled={!editable} aria-label={t('settingsV2.general.reopenSessions')} onChange={(on) => void run(() => window.hub.config.saveOptions({ reopenSessions: on }))} />
        </SwitchRow>
        <SwitchRow label={t('settingsV2.general.startSessionsAtLaunch')} hint={t('settingsV2.general.startSessionsAtLaunchHint')}>
          <Switch
            checked={options.startSessionsAtLaunch}
            disabled={!editable || !options.reopenSessions}
            aria-label={t('settingsV2.general.startSessionsAtLaunch')}
            onChange={(on) => void run(() => window.hub.config.saveOptions({ startSessionsAtLaunch: on }))}
          />
        </SwitchRow>
        <SwitchRow label={keepLabel} hint={t('settingsV2.general.keepInTrayHint')} help={t('help.general.menuBar')}>
          <Switch checked={options.keepInTray} disabled={!editable} aria-label={keepLabel} onChange={(on) => void run(() => window.hub.config.saveOptions({ keepInTray: on }))} />
        </SwitchRow>
      </SettingsGroup>
      <VoiceSettingsGroup config={snap.config} editable={editable} run={run} />
      <SettingsGroup anchor="updates" title={t('updates.group')} help={t('help.general.updates')} footnote={window.hub.platform === 'mac' ? t('updates.macNote') : undefined}>
        <UpdatesSettings enabled={options.checkForUpdates} editable={editable} run={run} />
      </SettingsGroup>
    </div>
  )
}

/** Settings → Advanced: diagnostics and help, then the data (where it is kept). */
export function AdvancedSection({ snap }: SectionProps) {
  const { t } = useI18n()
  // Compacting changes the file's size: the database row reads it again.
  const [compactions, setCompactions] = useState(0)
  // A new backup joins the list of copies to restore from.
  const [backups, setBackups] = useState(0)
  return (
    <div className="flex flex-col gap-6" data-testid="settings-advanced">
      <SetupEntryGroup />
      <SettingsGroup anchor="data" title={t('settingsV2.advanced.data')} help={t('help.general.storage')}>
        <div className="flex items-center gap-3 py-3" data-settings-row>
          <FolderCog className="size-4 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <span className="block text-base">{t('settingsV2.advanced.dataDir')}</span>
            <p className="text-xs text-subtle">{t('settingsV2.advanced.dataDirHint')}</p>
          </div>
          <code className="max-w-80 truncate text-sm text-muted" title={snap.dataDir}>
            {snap.dataDir}
          </code>
        </div>
        <DatabaseRow refresh={compactions} onBackedUp={() => setBackups((n) => n + 1)} />
        <RestoreBackupsRow refresh={backups} />
        <StorageUsageRow onCompacted={() => setCompactions((n) => n + 1)} />
      </SettingsGroup>
    </div>
  )
}

/** What a failed "Back up now" tells the person; main's own message goes to the console only. */
export function backupErrorKey(error: string): 'storage.backupNotWritten' | 'storage.backupNoSpace' | 'storage.backupNoAccess' | 'storage.backupFailed' {
  if (error === 'no backup written') return 'storage.backupNotWritten'
  if (/\bENOSPC\b|no space left/i.test(error)) return 'storage.backupNoSpace'
  if (/\b(EACCES|EPERM|EROFS)\b|permission denied|read-only file system/i.test(error)) return 'storage.backupNoAccess'
  return 'storage.backupFailed'
}

/** The database file, its size, the last copy, "Back up now" and the backups folder (Settings → Advanced → Data). */
function DatabaseRow({ refresh, onBackedUp }: { refresh: number; onBackedUp: () => void }) {
  const { t, locale } = useI18n()
  const toast = useToast()
  const [info, load] = useStorageInfo()
  useEffect(() => {
    if (refresh) void load()
  }, [refresh])
  const [busy, setBusy] = useState(false)
  const backup = async () => {
    setBusy(true)
    try {
      const r = await window.hub.storage.backup()
      if (r.ok) {
        toast(t('storage.backedUp', { path: r.path }))
        onBackedUp()
      } else {
        console.warn('[storage] backup failed', r.error)
        toast(t(backupErrorKey(r.error)), 'danger')
      }
      await load()
    } catch (e) {
      console.warn('[storage] backup failed', errorText(e))
      toast(t(backupErrorKey(errorText(e))), 'danger')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="py-3" data-settings-row data-testid="storage-database">
      <StorageRecoveredNotice info={info} />
      <div className="flex items-center gap-3">
        <Database className="size-4 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <span className="block text-base">{t('storage.database')}</span>
          <p className="text-xs text-subtle">{t('storage.databaseHint')}</p>
          <p className="mt-1 text-xs text-muted">
            <code className="break-all" title={info?.path}>
              {info?.path ?? '…'}
            </code>
            {info && ` · ${formatBytes(info.sizeBytes, locale)} · ${info.lastBackup ? t('storage.lastBackup', { name: fileName(info.lastBackup) }) : t('storage.noBackup')}`}
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-1.5">
          <Button size="sm" disabled={busy || !info} onClick={() => void backup()} data-testid="storage-backup">
            {t('storage.backupNow')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => window.hub.storage.revealBackups()} data-testid="storage-reveal-backups">
            {t('storage.revealBackups')}
          </Button>
        </div>
      </div>
    </div>
  )
}
