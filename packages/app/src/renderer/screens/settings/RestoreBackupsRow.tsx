import { ArchiveRestore } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { StorageRestorePoint, StorageRestoreResult } from '@shared/api'
import { Button } from '../../components/atoms'
import { Dialog, useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { errorText } from '../../lib/errorText'
import { fileName, formatBytes } from '../../lib/localReview'

const KIND_LABEL: Record<StorageRestorePoint['kind'], MessageKey> = {
  automatic: 'storage.restoreKind.automatic',
  manual: 'storage.restoreKind.manual',
  beforeRestore: 'storage.restoreKind.beforeRestore'
}

/** What a refused restore tells the person; main's own message goes to the console only. */
export function restoreErrorKey(reason: Extract<StorageRestoreResult, { ok: false }>['reason']): MessageKey {
  if (reason === 'unknown') return 'storage.restoreUnknown'
  if (reason === 'unreadable') return 'storage.restoreUnreadable'
  if (reason === 'damaged') return 'storage.restoreDamaged'
  if (reason === 'newerSchema') return 'storage.restoreNewer'
  return 'storage.restoreFailed'
}

/** The backups (and copies earlier restores set aside), each with Restore… (Settings → Advanced → Data). */
export function RestoreBackupsRow({ refresh }: { refresh: number }) {
  const { t, locale } = useI18n()
  const toast = useToast()
  const [points, setPoints] = useState<StorageRestorePoint[] | null>(null)
  const [chosen, setChosen] = useState<StorageRestorePoint | null>(null)
  const [busy, setBusy] = useState(false)
  const load = () =>
    window.hub.storage.restorePoints().then(setPoints, (e: unknown) => {
      console.warn('[storage] restore points failed', errorText(e))
      setPoints([])
    })
  useEffect(() => void load(), [refresh])
  const date = (p: StorageRestorePoint) => new Date(p.at).toLocaleString(locale)
  const restore = async (p: StorageRestorePoint) => {
    setBusy(true)
    try {
      const r = await window.hub.storage.restore(p.path)
      if (r.ok) {
        // The app quits and starts again: the buttons stay off until it does.
        toast(t('storage.restoring'))
        return
      }
      console.warn('[storage] restore refused', r.reason, r.error)
      toast(t(restoreErrorKey(r.reason)), 'danger')
    } catch (e) {
      console.warn('[storage] restore failed', errorText(e))
      toast(t('storage.restoreFailed'), 'danger')
    }
    setBusy(false)
    void load()
  }
  return (
    <div className="py-3" data-settings-row data-testid="storage-restore">
      <div className="flex items-start gap-3">
        <ArchiveRestore className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <span className="block text-base">{t('storage.restore')}</span>
          <p className="text-xs text-subtle">{t('storage.restoreHint')}</p>
          {points?.length === 0 && <p className="mt-1 text-xs text-muted">{t('storage.restoreNone')}</p>}
          {points && points.length > 0 && (
            <table className="mt-2 w-full text-xs">
              <tbody>
                {points.map((p) => (
                  <tr key={p.path} data-testid="storage-restore-point">
                    <td className="py-0.5 pr-4 tabular-nums" title={p.path}>
                      {date(p)}
                    </td>
                    <td className="pr-4 text-right tabular-nums text-muted">{formatBytes(p.sizeBytes, locale)}</td>
                    <td className="pr-4 text-muted">{t(KIND_LABEL[p.kind])}</td>
                    <td className="text-right">
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setChosen(p)} aria-label={`${t('storage.restoreAction')} ${fileName(p.path)}`}>
                        {t('storage.restoreAction')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <Dialog
        open={chosen !== null}
        onOpenChange={(open) => !open && setChosen(null)}
        title={chosen ? t('storage.restoreConfirmTitle', { date: date(chosen) }) : ''}
        description={chosen ? t('storage.restoreConfirmBody', { date: date(chosen) }) : ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setChosen(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              data-testid="storage-restore-confirm"
              onClick={() => {
                const p = chosen
                setChosen(null)
                if (p) void restore(p)
              }}
            >
              {t('storage.restoreConfirm')}
            </Button>
          </>
        }
      >
        {chosen && <code className="break-all text-xs text-muted">{chosen.path}</code>}
      </Dialog>
    </div>
  )
}
