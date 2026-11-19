import { AppWindowMac, Bot } from 'lucide-react'
import { Dialog as RDialog } from 'radix-ui'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, TooltipProvider } from '../components/atoms'
import { ToastProvider, useToast } from '../components/molecules'
import { CloseSessionDialog } from '../components/organisms/CloseSessionDialog'
import { isWorking } from '../components/organisms/SessionList'
import { currentConfig, refreshConfig } from '../configStore'
import { requestSessionClose } from '../lib/closeSession'
import { requestAnswerFocus } from '../lib/pendingFocus'
import { requestFind } from '../lib/chatReveal'
import { I18nProvider, useI18n } from '../i18n/I18nProvider'
import { useAppearance } from '../lib/appearance'
import { cn } from '../lib/cn'
import { errorText } from '../lib/errorText'
import { folderName } from '../lib/home'
import { usePlatform } from '../lib/platform'
import { closeSubagent } from '../lib/subagentView'
import { sessionTitle } from '../lib/windows'
import { hydrateFromMain, pushTurnEnd, pushUser, seedTerminals, setViewing, startStore, useSession } from '../store'
import { startPromptQueue } from '../promptQueue'
import { SessionPane } from './SessionsScreen'
import { SubagentBody } from './sessions/SubagentView'

function WindowProviders({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <TooltipProvider>
        <Toasts>{children}</Toasts>
      </TooltipProvider>
    </I18nProvider>
  )
}

function Toasts({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  return <ToastProvider label={t('common.notifications')}>{children}</ToastProvider>
}

/** The root of a session window (`#session?id=…`): one session, no navigation. */
export function SessionWindowRoot({ sessionId }: { sessionId: string }) {
  return (
    <WindowProviders>
      <SessionWindow sessionId={sessionId} />
    </WindowProviders>
  )
}

/** Title bar room: the macOS traffic lights on the left, the Windows/Linux controls on the right. */
function TitleBar({ children }: { children: ReactNode }) {
  const platform = usePlatform()
  return <header className={cn('drag-region flex h-12 shrink-0 items-center gap-3 border-b border-border px-4', platform === 'mac' ? 'pl-20' : 'pr-36')}>{children}</header>
}

/** The window's title before a session names it: what the page was opened with (the app's name). */
const initialTitle = typeof document === 'undefined' ? '' : document.title

function SessionWindow({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const toast = useToast()
  const theme = useAppearance()
  const data = useSession(sessionId)
  const [loaded, setLoaded] = useState(false)
  const [closing, setClosing] = useState(false)
  const seen = useRef(false)
  const latest = useRef({ data, t, toast })
  latest.current = { data, t, toast }

  useEffect(() => {
    startStore()
    // Messages queued while the agent works go out from this window too.
    startPromptQueue()
    // The close dialog reads the profiles (whether a worktree is kept or removed on close).
    void refreshConfig().catch(() => undefined)
    const offConfig = window.hub.config.onChanged(() => void refreshConfig().catch(() => undefined))
    // The chat so far comes from main's journal; the terminals' output, which main does not keep,
    // from the main window. The live messages follow both (numbered, or held by main until the snapshot is in).
    void hydrateFromMain(sessionId)
    void window.hub.windows.snapshot(sessionId).then((snapshot) => {
      if (snapshot?.terminals) seedTerminals(sessionId, snapshot.terminals)
    })
    setViewing(sessionId)
    const offPrompted = window.hub.automations.onPrompted((id, text, seq) => id === sessionId && pushUser(id, text, undefined, seq))
    const offTurnEnded = window.hub.automations.onTurnEnded((id, stopReason, seq) => id === sessionId && pushTurnEnd(id, stopReason, seq))
    const offMenu = window.hub.menu.onCommand((command) => {
      // ⌘⇧W asks like the main window does: a working session, or a worktree to keep or remove.
      const current = latest.current.data
      if (command.kind === 'closeSession' && current) {
        void requestSessionClose(current.view, isWorking(current), {
          profiles: async () => (currentConfig() ?? (await refreshConfig())).config.profiles,
          ask: () => setClosing(true),
          close: () => window.hub.sessions.close(sessionId),
          fail: (e) => latest.current.toast(latest.current.t('sessions.closeFailed', { message: errorText(e) }), 'danger')
        })
      }
      if (command.kind === 'showMode') void window.hub.sessions.setMode(sessionId, command.mode).catch(() => undefined)
      if (command.kind === 'answerRequest') requestAnswerFocus(sessionId)
      if (command.kind === 'findInChat') requestFind(sessionId)
    })
    void window.hub.sessions.list().then(() => setLoaded(true))
    return () => {
      offPrompted()
      offTurnEnded()
      offMenu()
      offConfig()
    }
  }, [sessionId])

  if (data) seen.current = true
  // Closed here or anywhere else: the window has nothing left to show (main closes it as well).
  useEffect(() => {
    if (loaded && !data) {
      const timer = setTimeout(() => window.close(), seen.current ? 0 : 1500)
      return () => clearTimeout(timer)
    }
  }, [loaded, data])

  const title = data ? sessionTitle(data.view) : ''
  useEffect(() => {
    document.title = data ? `${title} · ${folderName(data.view.cwd)}` : initialTitle
  }, [title, data])

  if (!data) {
    return (
      <div className="flex h-full flex-col bg-bg">
        <TitleBar>{null}</TitleBar>
        <p className="m-auto text-sm text-muted">{loaded ? t('window.sessionGone') : null}</p>
      </div>
    )
  }
  const v = data.view
  return (
    <div className="flex h-full flex-col bg-bg" data-testid="session-window">
      <TitleBar>
        {/* The session's title, state and rename live in the header below; the title bar keeps the folder. */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate font-mono text-xs text-subtle" title={v.cwd}>
            {folderName(v.cwd)}
          </span>
        </div>
        <Button size="sm" variant="ghost" icon={<AppWindowMac className="size-3.5" aria-hidden />} title={t('window.moveToMainHint')} data-testid="move-to-main" onClick={() => window.hub.windows.dock(v.id)}>
          {t('window.moveToMain')}
        </Button>
      </TitleBar>
      <div className="flex min-h-0 flex-1 flex-col">
        <SessionPane data={data} visible theme={theme} />
      </div>
      {closing && <CloseSessionDialog session={data} working={isWorking(data)} onDone={() => setClosing(false)} onError={(message) => toast(message, 'danger')} />}
    </div>
  )
}

/** The root of a sub-agent window (`#subagent?session=…&id=…`): its conversation, read live. */
export function SubagentWindowRoot({ sessionId, subagentId }: { sessionId: string; subagentId: string }) {
  return (
    <WindowProviders>
      <SubagentWindow sessionId={sessionId} subagentId={subagentId} />
    </WindowProviders>
  )
}

function SubagentWindow({ sessionId, subagentId }: { sessionId: string; subagentId: string }) {
  useAppearance()
  const [stack, setStack] = useState([subagentId])
  const current = stack[stack.length - 1]!
  useEffect(() => closeSubagent, [])
  return (
    <div className="flex h-full flex-col bg-bg">
      <TitleBar>
        <Bot className="size-4 text-accent" aria-hidden />
      </TitleBar>
      {/* The conversation view is built for a dialog; here it is one that never closes but with the window. */}
      <RDialog.Root open modal={false} onOpenChange={(o) => !o && window.close()}>
        <RDialog.Content
          className="flex min-h-0 flex-1 flex-col focus-visible:outline-none"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <SubagentBody
            key={`${current}:${stack.length}`}
            sessionId={sessionId}
            subagentId={current}
            depth={stack.length}
            onBack={() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))}
            onOpenNested={(id) => setStack((s) => [...s, id])}
            inWindow
          />
        </RDialog.Content>
      </RDialog.Root>
    </div>
  )
}
