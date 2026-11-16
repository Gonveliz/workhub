/**
 * How each tool is installed, per operating system. Workhub only ever runs a command from this
 * table, and only one marked `run`: those install into the user's own folders and need no
 * administrator rights. A `copy` method needs them (a system package, a machine-wide installer), so
 * the setup row shows it to copy with its page and says why. Each command is the one on the tool's
 * official page, cited next to it.
 */
import { isManagedToolId, MANAGED_TOOLS, managedAvailable, managedDownload, type ManagedToolId } from './managed-tools'

/** `codexAdapter`: the package Codex sessions start through `npx`, fetched ahead (managed-tools.ts). */
export type InstallerId = 'claudeCode' | 'codex' | 'codexAdapter' | 'kiro' | 'opencode' | 'gemini' | 'node' | 'git' | 'github' | 'gitlab'
export type InstallPlatform = 'darwin' | 'linux' | 'win32'
/** A tool a method relies on; the method is skipped when the machine does not have it. */
export type InstallRequirement = 'brew' | 'npm'

export interface InstallMethod {
  /** The command, or for a tool Workhub installs itself, what it downloads (shown before it runs). */
  command: string
  /** `run`: no administrator rights, Workhub may run it. `copy`: needs them, the person runs it. */
  mode: 'run' | 'copy'
  requires?: InstallRequirement
  /** Installed by Workhub into its own tools folder (managed-tools.ts), not by running `command`. */
  managed?: ManagedToolId
}

/** What the machine has, as far as the methods care. Homebrew is never assumed: it is checked. */
export interface InstallContext {
  platform: string
  /** The processor (`x64`, `arm64`): a tool Workhub installs itself needs an archive for it. */
  arch?: string
  brew?: boolean
  npm?: boolean
}

/** The official install page of each tool: the link a row offers when no method fits. */
export const INSTALL_PAGES: Record<InstallerId, string> = {
  claudeCode: 'https://code.claude.com/docs/en/setup',
  codex: 'https://github.com/openai/codex',
  codexAdapter: 'https://github.com/openai/codex',
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
/** Installed into Workhub's tools folder; what it shows is the address it downloads from (or the npm package). */
const managed = (id: ManagedToolId): InstallMethod => {
  const tool = MANAGED_TOOLS[id]
  const command = tool.kind === 'npm' ? `npm install --global ${tool.spec}` : (Object.values(tool.downloads)[0]?.url.replace(/[^/]+$/, '') ?? tool.page)
  return { command, mode: 'run', managed: id }
}

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
  // The Codex ACP adapter, fetched ahead with Workhub's own Node.js (managed-tools.ts).
  codexAdapter: {
    darwin: [managed('codexAdapter')],
    linux: [managed('codexAdapter')],
    win32: [managed('codexAdapter')]
  },
  // https://opencode.ai/docs/ (npm package opencode-ai, installed with Workhub's own Node.js; else
  // the install script; Windows has no script: `bash` is not there), checked 2026-11-16
  opencode: {
    darwin: [managed('opencode'), run('curl -fsSL https://opencode.ai/v2/install | bash')],
    linux: [managed('opencode'), run('curl -fsSL https://opencode.ai/v2/install | bash')],
    win32: [managed('opencode')]
  },
  // https://github.com/google-gemini/gemini-cli (npm, with Workhub's own Node.js; else Homebrew on
  // macOS and Linux, else the machine's npm), checked 2026-11-16
  gemini: {
    darwin: [managed('gemini'), run('brew install gemini-cli', 'brew'), run('npm install -g @google/gemini-cli', 'npm')],
    linux: [managed('gemini'), run('brew install gemini-cli', 'brew'), run('npm install -g @google/gemini-cli', 'npm')],
    win32: [managed('gemini'), run('npm install -g @google/gemini-cli', 'npm')]
  },
  // Node.js: the official archive unpacked into Workhub's tools folder (managed-tools.ts). Without
  // an archive for this processor: Homebrew when it is there, else nvm into the home folder, as
  // nodejs.org/en/download offers. nvm: https://github.com/nvm-sh/nvm (install script v0.41.0),
  // checked 2026-11-16. On Windows the official installer is a machine-wide .msi: the row links to
  // the download page.
  node: {
    darwin: [managed('node'), run('brew install node', 'brew'), run('curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash && . "$HOME/.nvm/nvm.sh" && nvm install --lts')],
    linux: [managed('node'), run('curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash && . "$HOME/.nvm/nvm.sh" && nvm install --lts')],
    win32: [managed('node')]
  },
  // https://git-scm.com/install/mac, /install/linux and /install/windows, checked 2026-11-16. macOS:
  // Homebrew, else Apple's Command Line Tools (a system dialog, no password). Linux packages need
  // administrator rights. Windows: MinGit unpacked into the tools folder, else the installer
  // (administrator rights).
  git: {
    darwin: [run('brew install git', 'brew'), run('xcode-select --install')],
    linux: [copy('sudo apt-get install git')],
    win32: [managed('git'), copy('winget install --id Git.Git -e --source winget')]
  },
  // The release archive into the tools folder; else https://github.com/cli/cli/blob/trunk/docs/install_macos.md
  // and install_windows.md, checked 2026-11-16. Linux otherwise has distribution repositories only.
  github: {
    darwin: [managed('github'), run('brew install gh', 'brew')],
    linux: [managed('github')],
    win32: [managed('github'), run('winget install --id GitHub.cli --source winget')]
  },
  // The release archive into the tools folder; else https://gitlab.com/gitlab-org/cli (README:
  // Homebrew on macOS and Linux), checked 2026-11-16
  gitlab: {
    darwin: [managed('gitlab'), run('brew install glab', 'brew')],
    linux: [managed('gitlab'), run('brew install glab', 'brew')],
    win32: [managed('gitlab')]
  }
}

export const isInstallerId = (value: unknown): value is InstallerId => typeof value === 'string' && Object.prototype.hasOwnProperty.call(INSTALLERS, value)

const contextOf = (ctx: InstallContext | string | undefined): InstallContext => (typeof ctx === 'string' ? { platform: ctx } : (ctx ?? { platform: '' }))

/** The first method of a tool the machine can use (its requirement is there), or null. */
export function installMethod(installer: InstallerId, context: InstallContext | string | undefined): InstallMethod | null {
  const ctx = contextOf(context)
  const methods: readonly InstallMethod[] = (INSTALLERS[installer] as Partial<Record<string, readonly InstallMethod[]>>)[ctx.platform] ?? []
  return methods.find((m) => (m.managed ? managedAvailable(m.managed, ctx.platform, ctx.arch) : !m.requires || ctx[m.requires] === true)) ?? null
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

/** The order installs run in: Node.js before the agents installed with it, the code tools, then the rest. */
export const INSTALL_ORDER: readonly InstallerId[] = ['node', 'git', 'github', 'gitlab', 'claudeCode', 'codexAdapter', 'opencode', 'gemini', 'codex', 'kiro']

/**
 * The installs to run for these ids, in order, without repeats: Workhub's own Node.js goes first
 * when a tool installed with it is asked for and it is not there yet (`privateNode`). Ids with no
 * method Workhub may run here are dropped.
 */
export function installQueue(ids: readonly unknown[], context: InstallContext, privateNode: boolean): InstallerId[] {
  const wanted = new Set(ids.filter(isInstallerId).filter((id) => installCommand(id, context) !== null))
  const needsNode = [...wanted].some((id) => {
    const m = installMethod(id, context)?.managed
    return m !== undefined && MANAGED_TOOLS[m].kind === 'npm'
  })
  if (needsNode && !privateNode && installMethod('node', context)?.managed) wanted.add('node')
  return INSTALL_ORDER.filter((id) => wanted.has(id))
}

/** One line of the list shown before anything downloads: where from and about how large. */
export interface InstallPlanEntry {
  installer: InstallerId
  /** The host it downloads from (or the package manager). */
  source: string
  /** About how many bytes it downloads; null when the install script does not say. */
  bytes: number | null
  /** Installed into Workhub's tools folder (no administrator rights, removable in Settings). */
  managed: boolean
  version: string | null
  /** Whether the download is checked against a published checksum. */
  checksum: boolean
}

export function installPlanEntry(installer: InstallerId, context: InstallContext): InstallPlanEntry | null {
  const method = installMethod(installer, context)
  if (!method || method.mode !== 'run') return null
  const id = method.managed
  if (id && isManagedToolId(id)) {
    const tool = MANAGED_TOOLS[id]
    if (tool.kind === 'npm') return { installer, source: 'registry.npmjs.org', bytes: tool.bytes, managed: true, version: null, checksum: true }
    const download = managedDownload(id, context.platform, context.arch)
    if (!download) return null
    return { installer, source: installSource(download.url) ?? '', bytes: download.bytes, managed: true, version: tool.version, checksum: true }
  }
  return { installer, source: installSource(method.command) ?? '', bytes: null, managed: false, version: null, checksum: false }
}
