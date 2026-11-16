import { execFile } from 'node:child_process'
import { installCommand, installMethod, isInstallerId, MANAGED_TOOLS, type InstallContext, type InstallerId } from '@workhub/core'
import type { ManagedFailure } from '@workhub/core'
import type { ManagedProgress, ManagedResult, ManagedToolsInstaller } from '@workhub/adapters/managed-tools'

/** An install may download and unpack a tool: ten minutes at most. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000
/** Only the tail of the output goes back to the renderer. */
export const INSTALL_OUTPUT_CAP = 4000

export interface InstallResult {
  ok: boolean
  output: string
  /** Why a tool Workhub installs itself failed (the renderer words it); unset for a command's own output. */
  reason?: ManagedFailure
}

export interface InstallOptions {
  signal?: AbortSignal
  onProgress?: (p: ManagedProgress) => void
}

/** Runs one command line in a shell and reports how it ended. Test seam. */
export type ShellRunner = (command: string, options: { platform: NodeJS.Platform; timeoutMs: number; signal?: AbortSignal }) => Promise<InstallResult>

const tail = (text: string): string => (text.length > INSTALL_OUTPUT_CAP ? text.slice(-INSTALL_OUTPUT_CAP) : text)

/** The login shell on macOS and Linux (so PATH and version managers match a terminal), PowerShell on Windows. */
export const runInShell: ShellRunner = (command, { platform, timeoutMs, signal }) =>
  new Promise((done) => {
    const [file, args] = platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command]] : [process.env['SHELL'] || '/bin/zsh', ['-ilc', command]]
    execFile(file as string, args as string[], { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 << 20, ...(signal ? { signal } : {}) }, (err, stdout, stderr) => {
      const output = tail(`${stdout}${stderr}`.trim())
      if (!err) return done({ ok: true, output })
      if (signal?.aborted) return done({ ok: false, output, reason: 'canceled' })
      const e = err as NodeJS.ErrnoException & { killed?: boolean }
      done({ ok: false, output: output || (e.killed ? 'Timed out.' : e.message) })
    })
  })

export interface SetupInstallerDeps {
  platform?: NodeJS.Platform
  /** The processor, for the archives of the tools Workhub installs itself. */
  arch?: string
  /** Homebrew and npm on this machine, checked again before each install (the table's methods depend on them). */
  context?: () => Promise<Omit<InstallContext, 'platform'>>
  run?: ShellRunner
  /** The tools Workhub installs into its own folder (Node.js, Git on Windows, gh, glab, npm agents). */
  managed?: Pick<ManagedToolsInstaller, 'install' | 'hasNode'>
  timeoutMs?: number
}

const fromManaged = (r: ManagedResult): InstallResult => (r.ok ? { ok: true, output: '' } : { ok: false, output: tail(r.detail), reason: r.reason })

/**
 * Installs a missing tool with the method of the installer table, never with text from the
 * renderer; only a method that needs no administrator rights; one install at a time. A tool Workhub
 * installs itself goes into its tools folder; an agent installed with npm brings Workhub's own
 * Node.js first when it is not there yet.
 */
export class SetupInstaller {
  private busy = false
  constructor(private readonly deps: SetupInstallerDeps = {}) {}

  get running(): boolean {
    return this.busy
  }

  async install(installer: unknown, options: InstallOptions = {}): Promise<InstallResult> {
    if (!isInstallerId(installer)) return { ok: false, output: 'Unknown installer.' }
    const platform = this.deps.platform ?? process.platform
    if (this.busy) return { ok: false, output: '', reason: 'busy' }
    this.busy = true
    try {
      const found = this.deps.context ? await this.deps.context().catch(() => ({})) : {}
      const context: InstallContext = { ...(this.deps.arch ? { arch: this.deps.arch } : {}), ...found, platform }
      const method = installMethod(installer as InstallerId, context)
      const command = installCommand(installer as InstallerId, context)
      if (!method || !command) return { ok: false, output: 'No installer Workhub can run for this system.' }
      if (method.managed) {
        const managed = this.deps.managed
        if (!managed) return { ok: false, output: 'No installer Workhub can run for this system.' }
        if (MANAGED_TOOLS[method.managed].kind === 'npm' && !managed.hasNode()) {
          const node = await managed.install('node', options)
          if (!node.ok) return fromManaged(node)
        }
        return fromManaged(await managed.install(method.managed, options))
      }
      options.onProgress?.({ phase: 'installing' })
      return await (this.deps.run ?? runInShell)(command, { platform, timeoutMs: this.deps.timeoutMs ?? INSTALL_TIMEOUT_MS, ...(options.signal ? { signal: options.signal } : {}) })
    } finally {
      this.busy = false
    }
  }
}
