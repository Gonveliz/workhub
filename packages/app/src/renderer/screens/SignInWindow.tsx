import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { CircleCheck, Copy, ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SignInTool } from '@workhub/core'
import type { SignInView } from '@shared/sign-in-api'
import { Button, Spinner, TooltipProvider } from '../components/atoms'
import { ToastProvider, useToast } from '../components/molecules'
import { I18nProvider, useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { cn } from '../lib/cn'
import { readPrefs } from '../lib/prefs'
import { usePlatform } from '../lib/platform'
import { applyTheme, terminalFont } from './sessions/TerminalPane'

const toolName = (t: (key: MessageKey) => string, tool: SignInTool): string => t(`signIn.tool.${tool}` as MessageKey)

/** The flow's terminal: what the tool prints, and the keys a person types into it. */
function SignInTerminal({ id, label }: { id: string; label: string }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const t = new Terminal({ ...terminalFont(), scrollback: readPrefs().terminalScrollback, cursorBlink: true })
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.open(host.current!)
    applyTheme(t, host.current)
    const off = window.hub.signInPane.onEvent((flow, event) => {
      if (flow === id && event.type === 'output') t.write(event.data)
    })
    t.onData((d) => window.hub.signInPane.write(id, d))
    let sent = ''
    const refit = () => {
      if (!host.current || host.current.clientWidth === 0) return
      try {
        fit.fit()
      } catch {
        return
      }
      const size = `${t.cols}x${t.rows}`
      if (size === sent) return
      sent = size
      window.hub.signInPane.resize(id, t.cols, t.rows)
    }
    const ro = new ResizeObserver(() => requestAnimationFrame(refit))
    ro.observe(host.current!)
    t.focus()
    return () => {
      ro.disconnect()
      off()
      t.dispose()
    }
  }, [id])
  return <div ref={host} className="xterm-host min-h-0 flex-1 overflow-hidden rounded-md border border-border p-2" role="region" aria-label={label} data-testid="sign-in-terminal" />
}

/** The address and code the tool printed, large, so nobody has to read them in the terminal. */
function PromptCard({ id, view }: { id: string; view: SignInView }) {
  const { t } = useI18n()
  const toast = useToast()
  const { url, code } = view.prompt
  if (!url && !code) return null
  const copy = () => void navigator.clipboard.writeText(code!).then(() => toast(t('signIn.copied')))
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-sm" data-testid="sign-in-prompt">
      {code ? (
        <>
          <p className="text-base">{t('signIn.codeIntro')}</p>
          <p className="select-all text-center font-mono text-3xl font-semibold tracking-widest" data-testid="sign-in-code">
            {code}
          </p>
        </>
      ) : (
        <p className="text-base">{t('signIn.browserIntro')}</p>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        {code && (
          <Button icon={<Copy className="size-4" aria-hidden />} onClick={copy}>
            {t('signIn.copyCode')}
          </Button>
        )}
        <Button variant="primary" icon={<ExternalLink className="size-4" aria-hidden />} onClick={() => window.hub.signInPane.openBrowser(id)}>
          {t('signIn.openBrowser')}
        </Button>
      </div>
    </section>
  )
}

function SignInPage({ id }: { id: string }) {
  const { t } = useI18n()
  const platform = usePlatform()
  const [view, setView] = useState<SignInView | null | undefined>(undefined)

  useEffect(() => {
    const off = window.hub.signInPane.onEvent((flow, event) => {
      if (flow === id && event.type === 'view') setView(event.view)
    })
    void window.hub.signInPane.attach(id).then(setView, () => setView(null))
    return off
  }, [id])

  const name = view ? toolName(t, view.tool) : ''
  const title = view ? (view.accountName ? t('signIn.titleAccount', { tool: name, account: view.accountName }) : t('signIn.title', { tool: name })) : t('signIn.titleLoading')
  useEffect(() => {
    document.title = title
  }, [title])

  const status =
    view === null
      ? t('signIn.gone')
      : !view
        ? ''
        : view.phase === 'running'
          ? t('signIn.running')
          : view.phase === 'signedIn'
            ? t('signIn.signedIn', { tool: name })
            : view.phase === 'ended'
              ? t('signIn.ended')
              : view.phase === 'cancelled'
                ? t('signIn.cancelled')
                : t('signIn.failed', { error: view.error ?? '' })

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className={cn('drag-region h-10 shrink-0', platform === 'mac' ? 'pl-20' : 'pr-36')} />
      <main className="flex min-h-0 flex-1 flex-col gap-4 px-6 pb-4">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="text-base text-muted">{t('signIn.intro')}</p>
        </header>
        <p role="status" className={cn('flex items-center gap-2 text-base', view?.phase === 'signedIn' && 'text-success')}>
          {view?.phase === 'running' && <Spinner />}
          {view?.phase === 'signedIn' && <CircleCheck className="size-4" aria-hidden />}
          {status}
        </p>
        {view && view.phase === 'running' && <PromptCard id={id} view={view} />}
        {/* Mounted before the first attach (a child's effect runs first), so no early output is missed. */}
        {view !== null && <SignInTerminal id={id} label={t('signIn.terminal')} />}
      </main>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-6 py-3">
        {view?.phase === 'running' ? (
          <Button variant="ghost" onClick={() => window.hub.signInPane.cancel(id)}>
            {t('common.cancel')}
          </Button>
        ) : (
          <Button variant={view?.phase === 'signedIn' ? 'primary' : 'secondary'} autoFocus onClick={() => window.close()}>
            {view?.phase === 'signedIn' ? t('signIn.done') : t('signIn.close')}
          </Button>
        )}
      </footer>
    </div>
  )
}

/** The sign-in window (`#signin?id=…`), opened by `hub.signIn(tool, accountId)`. Closing it stops the command. */
export function SignInWindow({ id }: { id: string }) {
  const { t } = useI18n()
  return (
    <ToastProvider label={t('common.notifications')}>
      <SignInPage id={id} />
    </ToastProvider>
  )
}

export function SignInWindowRoot({ id }: { id: string }) {
  return (
    <I18nProvider>
      <TooltipProvider>
        <SignInWindow id={id} />
      </TooltipProvider>
    </I18nProvider>
  )
}
