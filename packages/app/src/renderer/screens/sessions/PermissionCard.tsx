import { ShieldAlert } from 'lucide-react'
import { Button } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { ANSWERED_ELSEWHERE, type ChatItem } from '../../store'
import { QuestionCard } from './QuestionCard'

export type PermissionItem = Extract<ChatItem, { kind: 'permission' }>
export type AnswerPermission = (requestId: string, optionId: string | null, label: string, answers?: Record<string, string>) => void

/** The open permission requests and questions of a chat, oldest first. */
export function openRequests(items: readonly ChatItem[]): PermissionItem[] {
  return items.filter((i): i is PermissionItem => i.kind === 'permission' && i.answer === undefined)
}

/** What an answered request shows: who answered it, or that the agent withdrew it. */
export function answerText(answer: string, t: (key: 'chat.permissionWithdrawn' | 'chat.answeredElsewhere' | 'chat.answered', params?: Record<string, string | number>) => string): string {
  if (answer === '—') return t('chat.permissionWithdrawn')
  if (answer === ANSWERED_ELSEWHERE) return t('chat.answeredElsewhere')
  return t('chat.answered', { answer })
}

/**
 * A permission request (or an agent's question, through `QuestionCard`) with its buttons while it
 * waits, and the answer once given. Shown pinned above the composer while open, and in the log
 * once answered.
 */
export function PermissionCard({ item, onAnswer, pinned }: { item: PermissionItem; onAnswer: AnswerPermission; pinned?: boolean }) {
  const { t } = useI18n()
  if (item.questions?.length) {
    return <QuestionCard questions={item.questions} answer={item.answer} onSubmit={(answers, label) => onAnswer(item.requestId, answers ? 'allow' : 'deny', label, answers ?? undefined)} pinned={pinned} />
  }
  return (
    <div role="group" aria-label={t('chat.permissionRequested')} className={cn('rounded-lg border border-warning/40 bg-warning-soft p-3', !pinned && 'ml-8')} data-testid="permission-card">
      <div className="flex items-center gap-2 text-sm font-medium text-warning">
        <ShieldAlert className="size-4" aria-hidden />
        {t('chat.permissionRequested')}
      </div>
      <div className="mt-1 text-sm text-text [overflow-wrap:anywhere]">{item.title}</div>
      {item.detail && <pre className="mt-1 max-h-32 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{item.detail}</pre>}
      {item.answer !== undefined ? (
        <div className="mt-2 text-sm text-muted">{answerText(item.answer, t)}</div>
      ) : (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {item.options.map((o) => (
            <Button key={o.optionId} size="sm" variant={o.kind.startsWith('allow') ? 'primary' : 'secondary'} onClick={() => onAnswer(item.requestId, o.optionId, o.name)}>
              {o.name}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => onAnswer(item.requestId, null, t('common.cancel'))}>
            {t('common.cancel')}
          </Button>
        </div>
      )}
    </div>
  )
}

/** The line a still-open request leaves in the log: the request itself waits above the composer. */
export function PermissionMarker({ item }: { item: PermissionItem }) {
  const { t } = useI18n()
  return (
    <div className="ml-8 flex flex-wrap items-center gap-x-2 text-sm text-warning" data-testid="permission-marker">
      <ShieldAlert className="size-4" aria-hidden />
      <span className="font-medium">{item.questions?.length ? t('chat.questionAsked') : t('chat.permissionRequested')}</span>
      <span className="text-muted">· {t('chat.answerPinned')}</span>
    </div>
  )
}
