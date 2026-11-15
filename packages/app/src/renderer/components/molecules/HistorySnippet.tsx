import { snippetParts } from '@workhub/core'
import type { HistoryIndexProgress } from '@shared/api'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { Spinner } from '../atoms'

/** A History search snippet: the matches highlighted as elements, the rest as plain text (never parsed as HTML). */
export function HistorySnippet({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn('[overflow-wrap:anywhere]', className)} data-testid="history-snippet">
      {snippetParts(text).map((p, i) =>
        p.marked ? (
          <mark key={i} className="rounded-sm bg-warning-soft px-0.5 text-text">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </span>
  )
}

/** Whether a title snippet still shows the title (a session renamed in Workhub keeps the agent's title in the index). */
export function titleSnippetFits(titleSnippet: string | undefined, title: string): titleSnippet is string {
  return Boolean(titleSnippet) && snippetParts(titleSnippet!).map((p) => p.text).join('') === title
}

/** "Indexing… 12/400 · results may be incomplete" while History's search index builds; nothing otherwise. */
export function HistoryIndexingNote({ progress, className }: { progress: HistoryIndexProgress | null | undefined; className?: string }) {
  const { t, formatNumber } = useI18n()
  if (!progress?.indexing || progress.total <= 0) return null
  return (
    <p className={cn('flex items-center gap-1.5 text-xs text-subtle', className)} data-testid="history-indexing">
      <Spinner className="size-3" />
      {t('history.indexing', { done: formatNumber(progress.indexed), total: formatNumber(progress.total) })}
    </p>
  )
}
