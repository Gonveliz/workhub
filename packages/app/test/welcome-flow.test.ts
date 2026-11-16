import { describe, expect, it } from 'vitest'
import type { SetupItem } from '@workhub/core'
import {
  agentInstallFix,
  agentReadiness,
  agentSignInFix,
  agentSignInTool,
  canSkip,
  canStartSession,
  defaultFolder,
  newWorkspace,
  nextStep,
  previousStep,
  readySummary,
  stepComplete,
  welcomeInstallers,
  welcomeSteps,
  workspaceName,
  workspaceOf,
  type WelcomeState
} from '../src/renderer/lib/welcome-flow'

const row = (over: Partial<SetupItem> & Pick<SetupItem, 'kind'>): SetupItem => ({ id: over.kind, status: 'ok', code: 'version', params: {}, optional: false, ...over })

const claudeReady = [row({ kind: 'claudeCode' }), row({ kind: 'claudeSignIn', id: 'claudeSignIn:default', code: 'signedInAs' })]
const claudeSignedOut = [row({ kind: 'claudeCode' }), row({ kind: 'claudeSignIn', id: 'claudeSignIn:work', status: 'missing', code: 'notSignedIn', fix: { kind: 'signIn', tool: 'claude', accountId: 'work' } })]
const state = (over: Partial<WelcomeState> = {}): WelcomeState => ({ goal: 'files', agent: 'claude', folder: '/home/acme/Documents', name: '', items: claudeReady, ...over })

describe('welcome steps', () => {
  it('shows the code step only for the code goals', () => {
    expect(welcomeSteps('files')).toEqual(['goal', 'agent', 'signIn', 'folder', 'ready'])
    expect(welcomeSteps('code')).toEqual(['goal', 'agent', 'signIn', 'folder', 'code', 'ready'])
    expect(welcomeSteps('both')).toContain('code')
    expect(welcomeSteps(null)).not.toContain('code')
  })

  it('moves forward and back within the steps', () => {
    const steps = welcomeSteps('code')
    expect(nextStep(steps, 'folder')).toBe('code')
    expect(nextStep(steps, 'ready')).toBe('ready')
    expect(previousStep(steps, 'goal')).toBe('goal')
    expect(previousStep(welcomeSteps('files'), 'ready')).toBe('folder')
  })

  it('lets only the sign-in and code steps be skipped', () => {
    expect(['goal', 'agent', 'signIn', 'folder', 'code', 'ready'].filter((s) => canSkip(s as never))).toEqual(['signIn', 'code'])
  })
})

describe('agent cards', () => {
  it('reads Claude from Claude Code and its first login', () => {
    expect(agentReadiness('claude', [])).toBeNull()
    expect(agentReadiness('claude', claudeReady)).toBe('ready')
    expect(agentReadiness('claude', claudeSignedOut)).toBe('signedOut')
    expect(agentSignInFix('claude', claudeSignedOut)).toEqual({ kind: 'signIn', tool: 'claude', accountId: 'work' })
    expect(agentReadiness('claude', [row({ kind: 'claudeCode', status: 'missing', code: 'claudeMissing' }), row({ kind: 'claudeSignIn', status: 'missing', code: 'installClaudeFirst' })])).toBe('notInstalled')
  })

  it('reads the other agents from their own row', () => {
    const install = { kind: 'install', installer: 'kiro', command: 'curl -fsSL https://cli.kiro.dev/install | bash' } as const
    expect(agentReadiness('kiro', [row({ kind: 'kiro', status: 'missing', code: 'kiroMissing', fix: install })])).toBe('notInstalled')
    expect(agentInstallFix('kiro', [row({ kind: 'kiro', status: 'missing', code: 'kiroMissing', fix: install })])).toEqual(install)
    expect(agentReadiness('kiro', [row({ kind: 'kiro', status: 'missing', code: 'kiroNotSignedIn', fix: { kind: 'signIn', tool: 'kiro' } })])).toBe('signedOut')
    expect(agentInstallFix('kiro', [row({ kind: 'kiro', status: 'missing', code: 'kiroNotSignedIn', fix: { kind: 'signIn', tool: 'kiro' } })])).toBeUndefined()
    expect(agentReadiness('codex', [row({ kind: 'codex', code: 'codexReady' })])).toBe('ready')
    expect(agentReadiness('gemini', [row({ kind: 'gemini', status: 'warning', code: 'timeout' })])).toBe('unknown')
  })

  it('signs in inside Workhub only for the agents that have a sign-in flow', () => {
    expect(agentSignInTool('claude')).toBe('claude')
    expect(agentSignInTool('kiro')).toBe('kiro')
    expect(agentSignInTool('opencode')).toBeNull()
  })
})

describe('folder and workspace', () => {
  const folders = { home: '/home/acme', documents: '/home/acme/Documents' }
  it('starts in Documents for files and in the home folder for code', () => {
    expect(defaultFolder('files', folders)).toBe('/home/acme/Documents')
    expect(defaultFolder('code', folders)).toBe('/home/acme')
    expect(defaultFolder('both', folders)).toBe('/home/acme')
  })

  it('names the workspace after the folder unless renamed, so it is never empty', () => {
    expect(workspaceName('', '/home/acme/Documents')).toBe('Documents')
    expect(workspaceName('   ', 'C:\\Users\\acme\\code\\')).toBe('code')
    expect(workspaceName(' Notes ', '/home/acme/Documents')).toBe('Notes')
    expect(workspaceName('', '')).toBe('')
  })

  it('reuses the workspace that holds the folder and gives a new one a free id', () => {
    expect(workspaceOf([{ id: 'docs', folders: ['/home/acme/Documents'] }], '/home/acme/Documents')).toBe('docs')
    expect(workspaceOf([{ id: 'docs' }], '/x')).toBeNull()
    const ws = newWorkspace('Documents', '/home/acme/Documents', 'codex', ['documents'])
    expect(ws).toMatchObject({ id: 'documents-2', name: 'Documents', folders: ['/home/acme/Documents'], preferredAgents: ['codex'] })
    expect(newWorkspace('Docs', '/d', null, [])).not.toHaveProperty('preferredAgents')
  })
})

describe('step completion', () => {
  it('needs a goal, an installed agent, a sign-in and a folder', () => {
    expect(stepComplete('goal', state({ goal: null }))).toBe(false)
    expect(stepComplete('goal', state())).toBe(true)
    expect(stepComplete('agent', state({ agent: null }))).toBe(false)
    expect(stepComplete('agent', state({ items: [] }))).toBe(false)
    expect(stepComplete('agent', state({ items: claudeSignedOut }))).toBe(true)
    expect(stepComplete('signIn', state({ items: claudeSignedOut }))).toBe(false)
    expect(stepComplete('signIn', state())).toBe(true)
    expect(stepComplete('folder', state({ folder: '' }))).toBe(false)
    expect(stepComplete('folder', state({ name: '' }))).toBe(true)
    expect(stepComplete('code', state())).toBe(false)
    expect(stepComplete('code', state({ items: [...claudeReady, row({ kind: 'git' })] }))).toBe(true)
  })

  it('sums up what is set and what is missing; code lines only for the code goals', () => {
    expect(readySummary(state()).map((l) => l.line)).toEqual(['goal', 'agent', 'signIn', 'folder'])
    const code = readySummary(state({ goal: 'both', items: [...claudeSignedOut, row({ kind: 'git' }), row({ kind: 'github', status: 'missing', code: 'ghMissing' })] }))
    expect(code).toEqual([
      { line: 'goal', done: true },
      { line: 'agent', done: true },
      { line: 'signIn', done: false },
      { line: 'folder', done: true },
      { line: 'git', done: true },
      { line: 'codeHost', done: false },
      { line: 'tracker', done: false }
    ])
  })

  it('starts a session once an installed agent and a folder are chosen', () => {
    expect(canStartSession(state())).toBe(true)
    expect(canStartSession(state({ folder: '' }))).toBe(false)
    expect(canStartSession(state({ items: [row({ kind: 'claudeCode', status: 'missing', code: 'claudeMissing' })] }))).toBe(false)
  })
})

describe('welcomeInstallers', () => {
  const install = (installer: string) => ({ kind: 'install' as const, installer: installer as never, command: '' })
  const items = [
    row({ kind: 'opencode', status: 'missing', code: 'opencodeMissing', fix: install('opencode') }),
    row({ kind: 'git', status: 'missing', code: 'gitMissing', optional: true, fix: install('git') }),
    row({ kind: 'github', status: 'missing', code: 'ghMissing', fix: install('github') }),
    row({ kind: 'gitlab', status: 'missing', code: 'glabMissing', optional: true, fix: install('gitlab') })
  ]
  it('the agent step installs the chosen agent, plus git for the code goals', () => {
    expect(welcomeInstallers('agent', { goal: 'files', agent: 'opencode', items })).toEqual(['opencode'])
    expect(welcomeInstallers('agent', { goal: 'both', agent: 'opencode', items })).toEqual(['opencode', 'git'])
    expect(welcomeInstallers('agent', { goal: 'files', agent: 'claude', items })).toEqual([])
  })
  it('the code step installs git and the needed code host tools', () => {
    expect(welcomeInstallers('code', { goal: 'code', agent: 'claude', items })).toEqual(['git', 'github'])
    expect(welcomeInstallers('folder', { goal: 'code', agent: 'claude', items })).toEqual([])
  })
})
