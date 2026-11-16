import { Component, type ReactNode } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { boundaryCaught, boundaryReport, boundaryReset, BOUNDARY_CLEAR, type BoundaryState } from '../lib/errorBoundary'
import { Button } from './atoms'

interface Props {
  /** Where it sits, for the log ("window", "session"). */
  where: string
  /** `window` fills the window with a Reload action; `session` is a small panel with Try again. */
  variant: 'window' | 'session'
  children: ReactNode
}

/**
 * A render error inside shows a fallback instead of blanking the window; the agents keep running in
 * the main process. The error goes to the main log through the renderer's usual report path.
 */
export class ErrorBoundary extends Component<Props, BoundaryState> {
  override state = BOUNDARY_CLEAR

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return boundaryCaught(error)
  }

  override componentDidCatch(error: unknown): void {
    window.hub?.diagnostics?.report(boundaryReport(boundaryCaught(error).error!, this.props.where))
  }

  override render() {
    const { error } = this.state
    if (!error) return this.props.children
    return <Fallback variant={this.props.variant} message={error.message} onRetry={() => this.setState(boundaryReset())} />
  }
}

function Fallback({ variant, message, onRetry }: { variant: Props['variant']; message: string; onRetry: () => void }) {
  const { t } = useI18n()
  const session = variant === 'session'
  return (
    <div role="alert" className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted">
      <div className="text-base font-semibold text-text">{t(session ? 'crash.sessionTitle' : 'crash.title')}</div>
      {!session && <p className="max-w-md">{t('crash.body')}</p>}
      <code className="max-w-full text-danger [overflow-wrap:anywhere]">{message}</code>
      {session ? (
        <Button variant="primary" onClick={onRetry}>
          {t('crash.retry')}
        </Button>
      ) : (
        <Button variant="primary" onClick={() => location.reload()}>
          {t('crash.reload')}
        </Button>
      )}
    </div>
  )
}
