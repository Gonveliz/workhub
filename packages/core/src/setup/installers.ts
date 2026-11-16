/**
 * How each tool is installed, per operating system. Workhub only ever runs a command from this
 * table, and only one marked `run`: those install into the user's own folders and need no
 * administrator rights. A `copy` method needs them (a system package, a machine-wide installer), so
 * the setup row shows it to copy with its page and says why. Each command is the one on the tool's
 * official page, cited next to it.
 */
export type InstallerId = 'claudeCode' | 'codex' | 'kiro' | 'opencode' | 'gemini' | 'node' | 'git' | 'github' | 'gitlab'
export type InstallPlatform = 'darwin' | 'linux' | 'win32'
/** A tool a method relies on; the method is skipped when the machine does not have it. */
export type InstallRequirement = 'brew' | 'npm'

export interface InstallMethod {
  command: string
  /** `run`: no administrator rights, Workhub may run it. `copy`: needs them, the person runs it. */
  mode: 'run' | 'copy'
  requires?: InstallRequirement
}

/** What the machine has, as far as the methods care. Homebrew is never assumed: it is checked. */
export interface InstallContext {
  platform: string
  brew?: boolean
  npm?: boolean
}

/** The official install page of each tool: the link a row offers when no method fits. */
export const INSTALL_PAGES: Record<InstallerId, string> = {
  claudeCode: 'https://code.claude.com/docs/en/setup',
  codex: 'https://github.com/openai/codex',
  kiro: 'https://kiro.dev/docs/getting-started/installation/',
  opencode: 'https://opencode.ai/docs/',
  gemini: 'https://github.com/google-gemini/gemini-cli',
  node: 'https://nodejs.org/en/download',
  git: 'https://git-scm.com/downloads',
  github: 'https://cli.github.com/',
  gitlab: 'https://gitlab.com/gitlab-org/cli'
}

/** The pages per platform where the general one is not the right one (distribution packages, a Windows installer). */
const PLATFORM_PAGES: Partial<Record<InstallerId, Partial<Record<InstallPlatform, string>>>> = {
  git: { darwin: 'https://git-scm.com/install/mac', linux: 'https://git-scm.com/install/linux', win32: 'https://git-scm.com/install/windows' },
  github: { linux: 'https://github.com/cli/cli/blob/trunk/docs/install_linux.md' },
  gitlab: { win32: 'https://gitlab.com/gitlab-org/cli/-/releases' },
  opencode: { win32: 'https://opencode.ai/docs/' }
}

const run = (command: string, requires?: InstallRequirement): InstallMethod => (requires ? { command, mode: 'run', requires } : { command, mode: 'run' })
const copy = (command: string): InstallMethod => ({ command, mode: 'copy' })

/**
 * The methods per tool and platform, best first; the first one the machine can use wins. A
 * platform without an entry has no official command (the row links to the page).
 */
export const INSTALLERS: Record<InstallerId, Partial<Record<InstallPlatform, readonly InstallMethod[]>>> = {
  // https://code.claude.com/docs/en/setup (native installer; "You do not need to run as Administrator" on Windows), checked 2026-11-16
  claudeCode: {
    darwin: [run('curl -fsSL https://claude.ai/install.sh | bash')],
    linux: [run('curl -fsSL https://claude.ai/install.sh | bash')],
    win32: [run('irm https://claude.ai/install.ps1 | iex')]
  },
  // https://github.com/openai/codex (install scripts), checked 2026-11-16. Sessions run the ACP
  // adapter through npx; this binary is Codex's own command line (its sign-in).
  codex: {
    darwin: [run('curl -fsSL https://chatgpt.com/codex/install.sh | sh')],
    linux: [run('curl -fsSL https://chatgpt.com/codex/install.sh | sh')],
    win32: [run('powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"')]
  },
  // https://kiro.dev/docs/getting-started/installation/ (macOS install script; Linux packages and Windows have no one-line command there), checked 2026-11-16
  kiro: {
    darwin: [run('curl -fsSL https://cli.kiro.dev/install | bash')]
  },
  // https://opencode.ai/docs/ (install script; Windows: a download, no package manager), checked 2026-11-16
  opencode: {
    darwin: [run('curl -fsSL https://opencode.ai/v2/install | bash')],
    linux: [run('curl -fsSL https://opencode.ai/v2/install | bash')]
  },
  // https://github.com/google-gemini/gemini-cli (Homebrew on macOS and Linux, else npm), checked 2026-11-16
  gemini: {
    darwin: [run('brew install gemini-cli', 'brew'), run('npm install -g @google/gemini-cli', 'npm')],
    linux: [run('brew install gemini-cli', 'brew'), run('npm install -g @google/gemini-cli', 'npm')],
    win32: [run('npm install -g @google/gemini-cli', 'npm')]
  },
  // Node.js: Homebrew when it is there, else nvm into the home folder, as nodejs.org/en/download
  // offers. nvm: https://github.com/nvm-sh/nvm (install script v0.41.0), checked 2026-11-16. On
  // Windows the official installer is a machine-wide .msi: the row links to the download page.
  node: {
    darwin: [run('brew install node', 'brew'), run('curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash && . "$HOME/.nvm/nvm.sh" && nvm install --lts')],
    linux: [run('curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash && . "$HOME/.nvm/nvm.sh" && nvm install --lts')]
  },
  // https://git-scm.com/install/mac, /install/linux and /install/windows, checked 2026-11-16. macOS:
  // Homebrew, else Apple's Command Line Tools (a system dialog, no password). Linux packages and the
  // Windows installer need administrator rights.
  git: {
    darwin: [run('brew install git', 'brew'), run('xcode-select --install')],
    linux: [copy('sudo apt-get install git')],
    win32: [copy('winget install --id Git.Git -e --source winget')]
  },
  // https://github.com/cli/cli/blob/trunk/docs/install_macos.md and install_windows.md, checked
  // 2026-11-16. Linux has distribution repositories only (administrator rights): the row links there.
  github: {
    darwin: [run('brew install gh', 'brew')],
    win32: [run('winget install --id GitHub.cli --source winget')]
  },
  // https://gitlab.com/gitlab-org/cli (README: Homebrew on macOS and Linux; Windows: the releases page), checked 2026-11-16
  gitlab: {
    darwin: [run('brew install glab', 'brew')],
    linux: [run('brew install glab', 'brew')]
  }
}

export const isInstallerId = (value: unknown): value is InstallerId => typeof value === 'string' && Object.prototype.hasOwnProperty.call(INSTALLERS, value)

const contextOf = (ctx: InstallContext | string | undefined): InstallContext => (typeof ctx === 'string' ? { platform: ctx } : (ctx ?? { platform: '' }))

/** The first method of a tool the machine can use (its requirement is there), or null. */
export function installMethod(installer: InstallerId, context: InstallContext | string | undefined): InstallMethod | null {
  const ctx = contextOf(context)
  const methods: readonly InstallMethod[] = (INSTALLERS[installer] as Partial<Record<string, readonly InstallMethod[]>>)[ctx.platform] ?? []
  return methods.find((m) => !m.requires || ctx[m.requires] === true) ?? null
}

/** The command Workhub may run to install a tool here: only a `run` method, never a `copy` one. */
export function installCommand(installer: InstallerId, context: InstallContext | string | undefined): string | null {
  const method = installMethod(installer, context)
  return method?.mode === 'run' ? method.command : null
}

/** Where the official install needs administrator rights and has no single command to copy. */
const ADMIN_ONLY: Partial<Record<InstallerId, readonly InstallPlatform[]>> = { github: ['linux'], node: ['win32'] }

/** The official way to install this tool here needs administrator rights (so Workhub only links to it). */
export function adminOnly(installer: InstallerId, platform: string): boolean {
  return (ADMIN_ONLY[installer] as readonly string[] | undefined)?.includes(platform) === true || installMethod(installer, platform)?.mode === 'copy'
}

/** The official page for a tool on a platform. */
export function installPage(installer: InstallerId, platform: string | undefined): string {
  return (platform ? PLATFORM_PAGES[installer]?.[platform as InstallPlatform] : undefined) ?? INSTALL_PAGES[installer]
}

/**
 * Where an install command downloads from, to show next to it before it runs: the web address's
 * host for a script, else the package manager it goes through. Null for a command it cannot tell.
 */
export function installSource(command: string): string | null {
  const host = /https?:\/\/([^/\s"'|]+)/i.exec(command)?.[1]
  if (host) return host.toLowerCase()
  if (/^brew\s/.test(command)) return 'Homebrew (formulae.brew.sh)'
  if (/^npm\s/.test(command)) return 'npm (registry.npmjs.org)'
  if (/^winget\s/.test(command)) return 'winget (Microsoft)'
  if (/^xcode-select\s/.test(command)) return 'Apple (Command Line Tools)'
  return null
}
