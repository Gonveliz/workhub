import { useCallback, useEffect, useState } from 'react'
import type { ManagedToolId } from '@workhub/core'
import type { ManagedToolView } from '@shared/setup-api'
import { Button } from '../../components/atoms'
import { Dialog } from '../../components/molecules/Dialog'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { formatBytes } from '../../lib/localReview'
import { SettingRow, SettingsGroup } from './SettingsLayout'

/** Settings → Advanced: the tools Workhub installed into its own folder, each with its version, size and Remove. */
export function ManagedToolsGroup() {
  const { t, locale } = useI18n()
  const [state, setState] = useState<{ folder: string; tools: ManagedToolView[] } | null>(null)
  const [removing, setRemoving] = useState<ManagedToolId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => void window.hub.setup.tools().then(setState), [])
  useEffect(() => {
    load()
    // An install elsewhere (the setup check, the welcome) adds a line.
    return window.hub.setup.onInstallProgress((s) => {
      if (!s.running) load()
    })
  }, [load])
  const name = (id: ManagedToolId) => t(`setup.tool.${id}` as MessageKey)
  const remove = (id: ManagedToolId) => {
    setRemoving(null)
    setError(null)
    void window.hub.setup.removeTool(id).then((r) => {
      if (!r.ok) setError(t('setup.tools.removeFailed', { name: name(id), reason: t(`setup.installAll.reason.${r.reason}` as MessageKey) }))
      load()
    })
  }
  return (
    <SettingsGroup title={t('setup.tools.title')} footnote={state ? t('setup.tools.where', { folder: state.folder }) : undefined}>
      {state && state.tools.length === 0 && <p className="py-3 text-sm text-muted">{t('setup.tools.none')}</p>}
      {state?.tools.map((tool) => (
        <SettingRow key={tool.id} label={name(tool.id)} hint={t('setup.tools.detail', { version: tool.version || '?', size: formatBytes(tool.bytes, locale) })}>
          <Button size="sm" onClick={() => setRemoving(tool.id)}>
            {t('setup.tools.remove')}
          </Button>
        </SettingRow>
      ))}
      {error && (
        <p role="alert" className="py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removing ? t('setup.tools.removeTitle', { name: name(removing) }) : ''}
        description={t(removing === 'node' ? 'setup.tools.removeNodeBody' : 'setup.tools.removeBody')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={() => removing && remove(removing)}>
              {t('setup.tools.remove')}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </SettingsGroup>
  )
}
