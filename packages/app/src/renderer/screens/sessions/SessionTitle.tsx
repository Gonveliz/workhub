import { Pencil } from 'lucide-react'
import { useState } from 'react'
import { IconButton, Input } from '../../components/atoms'
import { useToast } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import { errorText } from '../../lib/errorText'

/** Longest name the rename field takes (main keeps at most this many characters too). */
const MAX_NAME = 120

/**
 * The session's title in the header, renamed in place: the pencil (or a double click) edits, Enter
 * saves, Escape cancels, an empty name goes back to the automatic title. Long titles truncate; the
 * tooltip has the whole title and the folder.
 */
export function SessionTitle({ id, title, name, tooltip }: { id: string; title: string; name: string | undefined; tooltip: string }) {
  const { t } = useI18n()
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const start = () => {
    setValue(name ?? '')
    setEditing(true)
  }
  const save = () => {
    setEditing(false)
    if ((value.trim() || undefined) === name) return
    void window.hub.sessions.rename(id, value.trim() || null).catch((e: unknown) => toast(t('session.renameFailed', { message: errorText(e) }), 'danger'))
  }
  if (editing) {
    return (
      <Input
        autoFocus
        aria-label={t('session.renameLabel')}
        value={value}
        maxLength={MAX_NAME}
        placeholder={title}
        data-testid="inline-session-name"
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') setEditing(false)
        }}
        className="h-7 w-72 max-w-full min-w-0 shrink text-md"
      />
    )
  }
  return (
    <span className="flex min-w-0 shrink items-center gap-0.5" data-testid="session-title">
      <h1 className="min-w-16 truncate text-md font-semibold" title={tooltip} onDoubleClick={start}>
        {title}
      </h1>
      <IconButton size="sm" className="size-6 shrink-0 text-subtle" label={t('session.rename')} icon={<Pencil className="size-3" />} onClick={start} />
    </span>
  )
}
