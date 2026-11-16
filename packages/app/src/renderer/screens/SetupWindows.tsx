import { CircleCheck, CircleDashed, FolderOpen } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SetupGoal, SetupItem } from '@workhub/core'
import { Button, Input, Spinner, TooltipProvider } from '../components/atoms'
import { Field, ToastProvider } from '../components/molecules'
import { refreshConfig, useConfig } from '../configStore'
import { I18nProvider, useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { cn } from '../lib/cn'
import { usePlatform } from '../lib/platform'
import { useSetupCheck } from '../lib/setup'
import {
  agentInstallFix,
  agentReadiness,
  agentSignInFix,
  agentSignInTool,
  canSkip,
  canStartSession,
  defaultFolder,
  isWelcomeAgent,
  newWorkspace,
  nextStep,
  previousStep,
  readySummary,
  stepComplete,
  WELCOME_AGENTS,
  welcomeSteps,
  workspaceName,
  workspaceOf,
  type AgentReadiness,
  type SummaryLine,
  type WelcomeAgent,
  type WelcomeState,
  type WelcomeStep
} from '../lib/welcome-flow'
import { FixButton, FixNotes, SetupChecklist, SetupRow } from './SetupChecklist'

/** The routes of the setup windows (`#welcome`, `#setup`, `#howitworks`); null for any other hash. */
export function parseSetupHash(hash: string): 'welcome' | 'check' | 'help' | null {
  const name = hash.replace(/^#\/?/, '').split('?')[0]
  return name === 'welcome' ? 'welcome' : name === 'setup' ? 'check' : name === 'howitworks' ? 'help' : null
}

function Frame({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  const { t } = useI18n()
  const platform = usePlatform()
  useEffect(() => {
    document.title = title
  }, [title])
  return (
    <ToastProvider label={t('common.notifications')}>
      <div className="flex h-full flex-col bg-bg">
        {/* Room for the macOS traffic lights; Windows and Linux draw their controls over the right end. */}
        <div className={cn('drag-region h-10 shrink-0', platform === 'mac' ? 'pl-20' : 'pr-36')} />
        <main className="min-h-0 flex-1 overflow-y-auto px-8 pb-6">
          <div className="mx-auto flex max-w-2xl flex-col gap-6">{children}</div>
        </main>
        {footer && <footer className="flex shrink-0 items-center gap-2 border-t border-border px-8 py-3">{footer}</footer>}
      </div>
    </ToastProvider>
  )
}

function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="text-xl font-semibold">{title}</h1>
      {subtitle && <p className="text-base text-muted">{subtitle}</p>}
    </header>
  )
}

// --- Setup check ------------------------------------------------------------------------------

function SetupCheckPage() {
  const { t } = useI18n()
  const state = useSetupCheck()
  return (
    <Frame title={t('setup.title')}>
      <Header title={t('setup.title')} subtitle={t('setup.intro')} />
      <SetupChecklist state={state} />
    </Frame>
  )
}

// --- How Workhub works ----------------------------------------------------------------------

const HELP_SECTIONS = ['profiles', 'sessions', 'accounts', 'review', 'notifications', 'data'] as const

function HowItWorksPage() {
  const { t } = useI18n()
  return (
    <Frame title={t('howitworks.title')}>
      <Header title={t('howitworks.title')} subtitle={t('howitworks.intro')} />
      {HELP_SECTIONS.map((s) => (
        <section key={s} className="flex flex-col gap-1">
          <h2 className="text-md font-semibold">{t(`howitworks.${s}.title` as MessageKey)}</h2>
          <p className="text-base text-muted">{t(`howitworks.${s}.body` as MessageKey)}</p>
        </section>
      ))}
      <div>
        <Button onClick={() => window.hub.setup.openWindow('check')}>{t('howitworks.checkLink')}</Button>
      </div>
    </Frame>
  )
}

// --- Welcome ---------------------------------------------------------------------------------
// A guided first run: one decision per screen. The rules (which steps show, when one is complete,
// the default folder and name) are in lib/welcome-flow.ts; this is only their drawing.

const GOALS: readonly SetupGoal[] = ['files', 'code', 'both']

/** A choice drawn as a card: a native radio, so arrow keys move between the cards of a group. */
function ChoiceCard({ name, value, checked, onChange, title, hint, badge, children }: { name: string; value: string; checked: boolean; onChange: (v: string) => void; title: string; hint?: string; badge?: ReactNode; children?: ReactNode }) {
  return (
    <div className={cn('rounded-lg border bg-surface shadow-sm', checked ? 'border-accent' : 'border-border')}>
      <label className="flex cursor-pointer items-start gap-3 px-4 py-3">
        <input type="radio" name={name} value={value} checked={checked} onChange={() => onChange(value)} className="mt-1 accent-[var(--color-accent)]" />
        <span className="min-w-0 flex-1">
          <span className="block text-base font-medium">{title}</span>
          {hint && <span className="block text-sm text-muted">{hint}</span>}
        </span>
        {badge}
      </label>
      {children && <div className="flex flex-col gap-2 border-t border-border px-4 py-3">{children}</div>}
    </div>
  )
}

function GoalStep({ goal, onGoal }: { goal: SetupGoal | null; onGoal: (g: SetupGoal) => void }) {
  const { t } = useI18n()
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="sr-only">{t('welcome.goal.title')}</legend>
      {GOALS.map((g) => (
        <ChoiceCard key={g} name="goal" value={g} checked={goal === g} onChange={() => onGoal(g)} title={t(`welcome.goal.${g}`)} hint={t(`welcome.goal.${g}Hint`)} />
      ))}
    </fieldset>
  )
}

function ReadinessBadge({ readiness }: { readiness: AgentReadiness | null }) {
  const { t } = useI18n()
  const label = readiness === null ? t('welcome.agent.checking') : t(`welcome.agent.${readiness}`)
  const tone = readiness === 'ready' ? 'text-success' : readiness === 'signedOut' || readiness === 'unknown' ? 'text-warning' : 'text-muted'
  return <span className={cn('shrink-0 text-sm', tone)}>{label}</span>
}

function AgentStep({ agent, onAgent, items, onInstalled }: { agent: WelcomeAgent | null; onAgent: (a: WelcomeAgent) => void; items: readonly SetupItem[]; onInstalled: () => void }) {
  const { t } = useI18n()
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="sr-only">{t('welcome.agent.title')}</legend>
      {WELCOME_AGENTS.map((a) => {
        const readiness = agentReadiness(a, items)
        const fix = agent === a && readiness === 'notInstalled' ? agentInstallFix(a, items) : undefined
        const name = t(`welcome.agent.name.${a}`)
        return (
          <ChoiceCard key={a} name="agent" value={a} checked={agent === a} onChange={() => onAgent(a)} title={name} hint={t(`welcome.agent.hint.${a}`)} badge={<ReadinessBadge readiness={readiness} />}>
            {agent === a && readiness === 'notInstalled' && (
              <>
                <p className="text-sm">{t('welcome.agent.needsInstall', { name })}</p>
                {fix && <FixNotes fix={fix} />}
                {fix && (
                  <div className="flex justify-end">
                    <FixButton fix={fix} name={name} onInstalled={onInstalled} />
                  </div>
                )}
              </>
            )}
          </ChoiceCard>
        )
      })}
    </fieldset>
  )
}

function SignInStep({ agent, items, onStarted, waiting, onCheck, checking }: { agent: WelcomeAgent; items: readonly SetupItem[]; onStarted: () => void; waiting: boolean; onCheck: () => void; checking: boolean }) {
  const { t } = useI18n()
  const name = t(`welcome.agent.name.${agent}`)
  const readiness = agentReadiness(agent, items)
  const fix = agentSignInFix(agent, items)
  if (readiness === 'ready') return <p role="status" className="text-base text-success">{t('welcome.signIn.done', { name })}</p>
  if (readiness === 'notInstalled') return <p className="text-base">{t('welcome.signIn.notInstalled', { name })}</p>
  if (!agentSignInTool(agent)) return <p className="text-base">{t('welcome.signIn.noFlow', { name })}</p>
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="text-base">{waiting ? t('welcome.signIn.waiting') : t('welcome.signIn.notReady', { name })}</p>
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          disabled={!fix}
          onClick={() => {
            if (!fix) return
            void window.hub.signIn(fix.tool, fix.accountId)
            onStarted()
          }}
        >
          {t('welcome.signIn.button')}
        </Button>
        <Button disabled={checking} onClick={onCheck}>
          {t('welcome.signIn.checkAgain')}
        </Button>
        {checking && <Spinner />}
      </div>
    </div>
  )
}

function FolderStep({ folder, name, existing, onFolder, onName }: { folder: string; name: string; existing: string | null; onFolder: (f: string) => void; onName: (n: string) => void }) {
  const { t } = useI18n()
  const choose = async () => {
    const picked = await window.hub.pickFolder()
    if (picked) onFolder(picked)
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-muted">{t('welcome.folder.folder')}</span>
        <p className="truncate rounded-lg border border-border bg-surface px-4 py-3 text-base" title={folder}>
          {folder || t('welcome.folder.none')}
        </p>
        <div>
          <Button icon={<FolderOpen className="size-3.5" aria-hidden />} onClick={() => void choose()}>
            {t('welcome.folder.choose')}
          </Button>
        </div>
      </div>
      {existing ? (
        <p className="text-sm text-muted">{t('welcome.folder.existing', { name: existing })}</p>
      ) : (
        <Field label={t('welcome.folder.name')} hint={t('welcome.folder.nameHint')}>
          <Input value={name} onChange={(e) => onName(e.target.value)} placeholder={workspaceName('', folder)} className="max-w-xs" />
        </Field>
      )}
    </div>
  )
}

const CODE_TOOLS: readonly SetupItem['kind'][] = ['git', 'github', 'gitlab']
const TRACKERS: readonly SetupItem['kind'][] = ['linear', 'jira']

function CodeStep({ items, onInstalled }: { items: readonly SetupItem[]; onInstalled: () => void }) {
  const { t } = useI18n()
  const rows = (kinds: readonly SetupItem['kind'][]) => items.filter((i) => kinds.includes(i.kind)).map((i) => <SetupRow key={i.id} item={i} onInstalled={onInstalled} />)
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h2 className="px-1 text-md font-semibold">{t('welcome.code.tools')}</h2>
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface shadow-sm">{rows(CODE_TOOLS)}</ul>
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="px-1 text-md font-semibold">{t('welcome.code.trackers')}</h2>
        <p className="px-1 text-sm text-muted">{t('welcome.code.trackersHint')}</p>
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface shadow-sm">{rows(TRACKERS)}</ul>
        <div>
          <Button onClick={() => window.hub.setup.openSettings('trackers')}>{t('welcome.code.openTrackers')}</Button>
        </div>
      </section>
    </div>
  )
}

function ReadyStep({ state, error }: { state: WelcomeState; error: string | null }) {
  const { t } = useI18n()
  const value = (line: SummaryLine): string => {
    if (line === 'goal') return state.goal ? t(`welcome.goal.${state.goal}`) : ''
    if (line === 'agent' || line === 'signIn') return state.agent ? t(`welcome.agent.name.${state.agent}`) : ''
    if (line === 'folder') return state.folder
    return ''
  }
  return (
    <div className="flex flex-col gap-4">
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface shadow-sm">
        {readySummary(state).map(({ line, done }) => (
          <li key={line} className="flex items-center gap-3 px-4 py-3">
            {done ? <CircleCheck className="size-4 text-success" aria-hidden /> : <CircleDashed className="size-4 text-subtle" aria-hidden />}
            <span className="min-w-0 flex-1">
              <span className="block text-base font-medium">{t(`welcome.ready.line.${line}`)}</span>
              {value(line) && <span className="block truncate text-sm text-muted">{value(line)}</span>}
            </span>
            <span className={cn('text-sm', done ? 'text-success' : 'text-muted')}>{done ? t('welcome.ready.done') : t('welcome.ready.missing')}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={() => window.hub.setup.openWindow('check')}>
          {t('welcome.ready.check')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => window.hub.setup.openWindow('help')}>
          {t('welcome.ready.help')}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {t('welcome.ready.startFailed', { error })}
        </p>
      )}
    </div>
  )
}

/** Re-reads the check every few seconds while a sign-in runs, and whenever the window comes back to the front. */
function useRecheck(active: boolean, run: () => void) {
  useEffect(() => {
    if (!active) return
    const timer = setInterval(run, SIGN_IN_RECHECK_MS)
    window.addEventListener('focus', run)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', run)
    }
  }, [active, run])
}

const SIGN_IN_RECHECK_MS = 5000

function WelcomePage() {
  const { t } = useI18n()
  const snap = useConfig()
  const check = useSetupCheck()
  const [goal, setGoal] = useState<SetupGoal | null>(null)
  const [agent, setAgent] = useState<WelcomeAgent | null>('claude')
  const [folder, setFolder] = useState('')
  const [name, setName] = useState('')
  const [step, setStep] = useState<WelcomeStep>('goal')
  const [waitingSignIn, setWaitingSignIn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [profileId, setProfileId] = useState<string | null>(null)
  const [paths, setPaths] = useState<{ home: string; documents: string } | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const seeded = useRef(false)

  useEffect(() => {
    void refreshConfig()
    void window.hub.setup.folders().then(setPaths, () => undefined)
    return window.hub.config.onChanged(() => void refreshConfig())
  }, [])
  // Reopened from Settings: start from what was saved (the goal, the first workspace's agent).
  useEffect(() => {
    if (!snap || seeded.current) return
    seeded.current = true
    const saved = snap.config.options?.setupGoal
    if (saved) setGoal(saved)
    const preferred = snap.config.profiles[0]?.preferredAgents?.[0]?.split(':')[0]
    if (isWelcomeAgent(preferred)) setAgent(preferred)
  }, [snap])
  // The folder step starts on the default folder for the goal, named after it.
  useEffect(() => {
    if (step !== 'folder' || folder || !paths) return
    const start = defaultFolder(goal, paths)
    setFolder(start)
    setName(workspaceName('', start))
  }, [step, folder, paths, goal])
  // Each step moves the focus to its title, so a screen reader reads where it is.
  useEffect(() => heading.current?.focus(), [step])

  const steps = welcomeSteps(goal)
  const index = steps.indexOf(step)
  const state: WelcomeState = { goal, agent, folder, name, items: check.items }
  const complete = stepComplete(step, state)
  const profiles = snap?.config.profiles ?? []
  const existingId = folder ? workspaceOf(profiles, folder) : null
  const existingName = existingId ? (profiles.find((p) => p.id === existingId)?.name ?? null) : null
  useRecheck(step === 'signIn' && waitingSignIn && !complete, check.run)

  const chooseGoal = (g: SetupGoal) => {
    setGoal(g)
    setError(null)
    // Saved at once: closing the window keeps it, and the setup check follows it.
    void window.hub.config.saveOptions({ setupGoal: g }).then(
      () => refreshConfig(),
      () => setError(t('welcome.goal.saveFailed'))
    )
  }
  const chooseFolder = (f: string) => {
    setFolder(f)
    setName(workspaceName('', f))
  }

  /** Leaving the folder step saves its workspace (or picks the one that already has the folder). */
  const saveWorkspace = async (): Promise<boolean> => {
    if (existingId) {
      setProfileId(existingId)
      return true
    }
    setBusy(true)
    const profile = newWorkspace(workspaceName(name, folder), folder, agent, profiles.map((p) => p.id))
    const r = await window.hub.config.saveProfile(profile).catch(() => ({ ok: false }))
    setBusy(false)
    if (!r.ok) {
      setError(t('welcome.folder.saveFailed'))
      return false
    }
    setProfileId(profile.id)
    await refreshConfig()
    return true
  }

  const next = async () => {
    setError(null)
    if (step === 'folder' && !(await saveWorkspace())) return
    setStep(nextStep(steps, step))
  }
  const back = () => {
    setError(null)
    setStep(previousStep(steps, step))
  }

  const startSession = async () => {
    if (!agent) return
    setBusy(true)
    setError(null)
    try {
      const pid = profileId ?? workspaceOf(profiles, folder)
      const agents = await window.hub.config.effectiveAgents(pid)
      const key = agents.find((a) => a.agent.id === agent)?.key ?? agent
      const view = await window.hub.sessions.start({ profileId: pid, agentKey: key, cwd: folder, cols: 100, rows: 30 })
      window.hub.tickets.openSession(view.id)
      await window.hub.setup.completeWelcome()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const titles: Record<WelcomeStep, { title: string; subtitle: string }> = {
    goal: { title: t('welcome.goal.title'), subtitle: t('welcome.goal.subtitle') },
    agent: { title: t('welcome.agent.title'), subtitle: t('welcome.agent.subtitle') },
    signIn: { title: t('welcome.signIn.title', { name: agent ? t(`welcome.agent.name.${agent}`) : '' }), subtitle: t('welcome.signIn.subtitle') },
    folder: { title: t('welcome.folder.title'), subtitle: t('welcome.folder.subtitle') },
    code: { title: t('welcome.code.title'), subtitle: t('welcome.code.subtitle') },
    ready: { title: t('welcome.ready.title'), subtitle: t('welcome.ready.subtitle') }
  }

  return (
    <Frame
      title={t('welcome.title')}
      footer={
        <>
          <span className="text-sm text-subtle" aria-live="polite">
            {t('welcome.step', { n: index + 1, total: steps.length })}
          </span>
          <span className="flex-1" />
          {step !== 'ready' && (
            <Button variant="ghost" onClick={() => window.close()}>
              {t('welcome.later')}
            </Button>
          )}
          {index > 0 && (
            <Button disabled={busy} onClick={back}>
              {t('welcome.back')}
            </Button>
          )}
          {canSkip(step) && !complete && (
            <Button disabled={busy} onClick={() => setStep(nextStep(steps, step))}>
              {t('welcome.skip')}
            </Button>
          )}
          {step === 'ready' ? (
            <>
              <Button disabled={busy} onClick={() => void window.hub.setup.completeWelcome()}>
                {t('welcome.ready.close')}
              </Button>
              <Button variant="primary" disabled={busy || !canStartSession(state)} onClick={() => void startSession()}>
                {t('welcome.ready.start')}
              </Button>
            </>
          ) : (
            <Button variant="primary" disabled={busy || !complete} onClick={() => void next()}>
              {t('welcome.next')}
            </Button>
          )}
        </>
      }
    >
      <header className="flex flex-col gap-1">
        <h1 ref={heading} tabIndex={-1} className="text-xl font-semibold outline-none">
          {titles[step].title}
        </h1>
        <p className="text-base text-muted">{titles[step].subtitle}</p>
      </header>
      {step === 'goal' && <GoalStep goal={goal} onGoal={chooseGoal} />}
      {step === 'agent' && <AgentStep agent={agent} onAgent={setAgent} items={check.items} onInstalled={check.run} />}
      {step === 'signIn' && agent && <SignInStep agent={agent} items={check.items} waiting={waitingSignIn} onStarted={() => setWaitingSignIn(true)} onCheck={check.run} checking={check.running} />}
      {step === 'folder' && <FolderStep folder={folder} name={name} existing={existingName} onFolder={chooseFolder} onName={setName} />}
      {step === 'code' && <CodeStep items={check.items} onInstalled={check.run} />}
      {step === 'ready' && <ReadyStep state={state} error={error} />}
      {step !== 'ready' && error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </Frame>
  )
}

/** The root of a setup window, chosen by the URL hash. */
export function SetupWindow({ page }: { page: 'welcome' | 'check' | 'help' }) {
  return (
    <I18nProvider>
      <TooltipProvider>{page === 'welcome' ? <WelcomePage /> : page === 'check' ? <SetupCheckPage /> : <HowItWorksPage />}</TooltipProvider>
    </I18nProvider>
  )
}
