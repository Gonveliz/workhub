import { useEffect, useState } from 'react'
import type { StorageInfo } from '@shared/api'
import { useI18n } from '../../i18n/I18nProvider'

/** What the main process says about the database (path, size, backups, a past recovery); null until it answers. */
export function useStorageInfo(): [StorageInfo | null, () => Promise<void>] {
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const load = () => window.hub.storage.info().then(setInfo, () => setInfo(null))
  useEffect(() => void load(), [])
  return [info, load]
}

/** The notice shown after a damaged database was moved aside: where it went and where the backups are. */
export function StorageRecoveredNotice({ info }: { info: StorageInfo | null }) {
  const { t, locale } = useI18n()
  if (!info?.recovered) return null
  return (
    <p className="my-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning" role="status" data-testid="storage-recovered">
      {t('storage.recovered', { date: new Date(info.recovered.at).toLocaleString(locale), path: info.recovered.movedTo, folder: info.backupFolder })}
    </p>
  )
}
