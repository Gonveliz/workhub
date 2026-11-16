import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  agentItem,
  agentSkillsItem,
  applyNeeds,
  claudeCodeItem,
  claudeSignInItem,
  codexItem,
  gitItem,
  githubItem,
  gitlabItem,
  healthItem,
  jiraItem,
  linearItem,
  nodeItem,
  profileItem,
  setupNeeds,
  slackItem,
  usageItem,
  appOptions,
  type AgentDefinition,
  type InstallContext,
  type Probe,
  type SetupItem,
  type WorkhubConfig
} from '@workhub/core'
import { claudeAccounts, claudeConfigDirOf } from './claude-accounts'

/** Seconds a command-line check may take. */
export const SETUP_TIMEOUT_MS = 10_000

/** The file a Windows shell would run for `command` (PATH folders, then PATHEXT extensions), or null. */
export function findOnWindowsPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const value = (name: string) => Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1]
  const exts = (value('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const hasExt = /\.[^\\/.]+$/.test(command)
  const names = hasExt ? [command, ...exts.map((e) => command + e)] : exts.map((e) => command + e)
  const dirs = /[\\/]/.test(command) ? [''] : (value('PATH') ?? '').split(';').filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const full = dir ? join(dir, name) : name
      try {
        if (statSync(full).isFile()) return full
      } catch {
        /* not here */
      }
    }
  }
  return null
}

/** Runs one command and reports how it ended; a slow or hanging tool never holds the window. */
export function probe(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<Probe> {
  return new Promise((done) => {
    const env = options.env ?? process.env
    // cmd.exe reports a missing command as an ordinary failure (localized text, exit code 1), so on
    // Windows the command is looked up first; only `.cmd`/`.bat` shims need the shell.
    const found = process.platform === 'win32' ? findOnWindowsPath(command, env) : command
    if (!found) return done({ result: 'notFound', output: '' })
    execFile(
      found,
      args,
      { env, timeout: options.timeoutMs ?? SETUP_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(found) },
      (err, stdout, stderr) => {
        const output = String(stdout || stderr || '').trim()
        if (!err) return done({ result: 'ok', output })
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: string | number }
        if (e.code === 'ENOENT') return done({ result: 'notFound', output })
        if (e.killed || e.code === 'ETIMEDOUT') return done({ result: 'timeout', output })
        done({ result: 'failed', output })
      }
    )
  })
}

export interface SetupServiceDeps {
  config: () => Promise<WorkhubConfig>
  hasSecret: (ref: string) => Promise<boolean>
  /** The PATH tools are looked up on (the login shell's, plus the bundled Claude Code). */
  path: () => string
  home: string
  /** The Slack watcher's last failure, null when it is not failing. */
  slackFailure: () => Promise<string | null>
  /** Workhub's skills per Claude folder (Settings → Agents → Workhub tools); the row is left out when unset. */
  agentSkills?: () => Promise<{ installed: number; outdated: number; total: number }>
  /** The known agents (built-in and the user's), for what runs on Node; the built-in ones when unset. */
  agents?: (config: WorkhubConfig) => readonly AgentDefinition[]
  /** Test seam: the operating system the install fixes are for. */
  platform?: NodeJS.Platform
  /** Test seam: replaces the command runner. */
  run?: typeof probe
}

/** What the install table needs to know about this machine: Homebrew and npm are checked, never assumed. */
export async function installContext(run: typeof probe, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<InstallContext> {
  const [brew, npm] = await Promise.all([platform === 'win32' ? Promise.resolve(null) : run('brew', ['--version'], { env }), run('npm', ['--version'], { env })])
  return { platform, brew: brew?.result === 'ok', npm: npm.result === 'ok' }
}

/** Checks what Workhub needs on this machine. Nothing here changes any setting. */
export class SetupService {
  constructor(private readonly deps: SetupServiceDeps) {}

  /** Every row, in display order, with its answer. */
  async run(): Promise<SetupItem[]> {
    const run = this.deps.run ?? probe
    const config = await this.deps.config()
    const base = { ...process.env, PATH: this.deps.path() }
    const defaultDir = resolve(process.env['CLAUDE_CONFIG_DIR'] || join(this.deps.home, '.claude'))

    const logins = claudeAccounts(config, this.deps.home).map(async (ref) => {
      const account = config.accounts.find((a) => a.id === ref.accountId) ?? null
      const dir = claudeConfigDirOf(config, account, this.deps.home)
      const isDefault = dir === defaultDir
      const env = isDefault ? base : { ...base, CLAUDE_CONFIG_DIR: dir }
      const p = await run('claude', ['auth', 'status'], { env })
      return claudeSignInItem(`claudeSignIn:${ref.accountId ?? 'default'}`, ref.name || 'Claude', p, ref.accountId)
    })
    const platform = this.deps.platform ?? process.platform
    const ctx = await installContext(run, base, platform)
    const nodeProbe = (async () => {
      let p = await run('node', ['--version'], { env: base })
      // A Node from a version manager may only be on the login shell's PATH.
      if (p.result === 'notFound' && platform !== 'win32') p = await run(process.env['SHELL'] || '/bin/zsh', ['-ilc', 'node --version'])
      return p
    })()
    const github = (async () => {
      const version = await run('gh', ['--version'], { env: base })
      if (version.result === 'notFound' || version.result === 'timeout') return githubItem(version, null, null, ctx)
      const user = await run('gh', ['api', 'user', '--jq', '.login'], { env: base })
      if (user.result === 'ok' && user.output) return githubItem(version, user, null, ctx)
      return githubItem(version, user, await run('gh', ['auth', 'token'], { env: base }), ctx)
    })()
    const gitlab = (async () => {
      const version = await run('glab', ['--version'], { env: base })
      if (version.result === 'notFound' || version.result === 'timeout') return gitlabItem(version, null, ctx)
      return gitlabItem(version, await run('glab', ['auth', 'status'], { env: base }), ctx)
    })()

    const needs = setupNeeds(config, this.deps.agents?.(config))
    const secretRefs = new Set<string>()
    for (const c of config.connections) if (c.secretRef && (await this.deps.hasSecret(c.secretRef))) secretRefs.add(c.secretRef)
    const [claudeCode, codex, kiro, opencode, gemini, node, git, githubResult, gitlabResult, ...loginItems] = await Promise.all([
      run('claude', ['--version'], { env: base }).then((p) => claudeCodeItem(p, ctx)),
      // Codex sessions start through npx, with the session's PATH (no login shell fallback). Its
      // sign-in is read with Codex's own command, when that is installed.
      Promise.all([run('npx', ['--version'], { env: base }), run('node', ['--version'], { env: base }), run('codex', ['login', 'status'], { env: base })]).then(([npx, n, auth]) => codexItem(npx, n, ctx, auth)),
      run('kiro-cli', ['--version'], { env: base }).then(async (p) => agentItem('kiro', p, ctx, p.result === 'ok' ? await run('kiro-cli', ['whoami'], { env: base }) : null)),
      run('opencode', ['--version'], { env: base }).then((p) => agentItem('opencode', p, ctx)),
      run('gemini', ['--version'], { env: base }).then((p) => agentItem('gemini', p, ctx)),
      nodeProbe.then((p) => nodeItem(p, needs.node, ctx)),
      run('git', ['--version'], { env: base }).then((p) => gitItem(p, ctx)),
      github,
      gitlab,
      ...logins
    ])
    const options = appOptions(config)
    const has = (ref: string) => secretRefs.has(ref)
    return applyNeeds(
      [
        claudeCode,
        ...loginItems,
        node,
        git,
        githubResult,
        gitlabResult,
        profileItem(config),
        codex,
        kiro,
        opencode,
        gemini,
        linearItem(config, has),
        jiraItem(config, has),
        slackItem(config, await this.deps.slackFailure()),
        healthItem(config),
        usageItem(options),
        ...(this.deps.agentSkills ? [agentSkillsItem(await this.deps.agentSkills().catch(() => ({ installed: 0, outdated: 0, total: 0 })))] : [])
      ],
      needs
    )
  }
}
