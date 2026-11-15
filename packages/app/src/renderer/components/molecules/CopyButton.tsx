import { Check, Copy, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, IconButton } from '../atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'

/** How long the check mark stays after a copy. */
const COPIED_MS = 1500

/**
 * Copies `text()` to the clipboard; the icon turns into a check for a moment so the copy is seen.
 * With `label`, a small button with that text instead of the bare icon.
 */
export function CopyButton({ text, className, label }: { text: () => string; className?: string; label?: string }) {
  const { t } = useI18n()
  // 'copied' shows a check, 'failed' a cross (the clipboard refused), each for a moment.
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (status === 'idle') return
    const timer = setTimeout(() => setStatus('idle'), COPIED_MS)
    return () => clearTimeout(timer)
  }, [status])
  const copy = () => {
    let value: string
    try {
      value = text()
    } catch {
      setStatus('failed')
      return
    }
    void navigator.clipboard.writeText(value).then(
      () => setStatus('copied'),
      () => setStatus('failed')
    )
  }
  const icon = status === 'copied' ? <Check className="size-3.5 text-success" aria-hidden /> : status === 'failed' ? <X className="size-3.5 text-danger" aria-hidden /> : <Copy className="size-3.5" aria-hidden />
  const said = status === 'copied' ? t('chat.copied') : status === 'failed' ? t('copy.failed') : null
  if (label) {
    return (
      <Button size="sm" variant="secondary" className={className} icon={icon} onClick={copy} data-testid="copy-button">
        <span aria-live="polite">{said ?? label}</span>
      </Button>
    )
  }
  return (
    <IconButton
      size="sm"
      label={said ?? t('chat.copy')}
      className={cn('size-6', className)}
      icon={icon}
      onClick={copy}
      data-testid="copy-button"
    />
  )
}
