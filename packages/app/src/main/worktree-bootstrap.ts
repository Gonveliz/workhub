/**
 * Getting a new session worktree ready: copy the `.worktreeinclude` files, then run the setup
 * command the user typed for the folder (Settings → Profiles → Folder options). Nothing here
 * throws: a session starts whatever happens, and the outcome becomes a notice where the session
 * reports its start.
 */
import { spawn } from 'node:child_process'
import { MAX_INCLUDE_BYTES, MAX_INCLUDE_FILES } from '@workhub/adapters/git-worktree'
import type { IncludeCopyResult, Worktrees } from '@workhub/core'

/** How long the setup command may run before it is stopped. */
export const SETUP_TIMEOUT_MS = 5 * 60_000
/** Output kept from the command (its tail); a chatty install must not fill memory. */
const MAX_OUTPUT = 64 * 1024
/** Lines of the output a notice shows. */
export const NOTICE_LINES = 20

export interface SetupRun {
  exitCode: number | null
  output: string
  timedOut: boolean
}
export type SetupRunner = (command: string, opts: { cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<SetupRun>

/** Runs `command` in the user's shell; stopped (with its children, where the platform allows) after `timeoutMs`. */
export const runSetupCommand: SetupRunner = (command, { cwd, env, timeoutMs }) =>
  new Promise((done, fail) => {
    const posix = process.platform !== 'win32'
    const child = spawn(command, { cwd, env: { ...process.env, ...env }, shell: true, windowsHide: true, detached: posix, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let timedOut = false
    const take = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT)
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (posix && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill()
      } catch {
        child.kill()
      }
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      fail(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ exitCode: code, output, timedOut })
    })
  })

export const lastLines = (output: string, count = NOTICE_LINES): string =>
  output
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-count)
    .join('\n')

export interface BootstrapReport {
  title: string
  text: string
  failed: boolean
  /** The command's output, for the log. */
  output?: string
}

export interface BootstrapDeps {
  worktrees: Pick<Worktrees, 'copyIncluded'>
  t: (key: string, params?: Record<string, string | number>) => string
  run?: SetupRunner
  timeoutMs?: number
  log?: (message: string) => void
}

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`)

/**
 * Copies the `.worktreeinclude` files and runs the folder's setup command in the new worktree.
 * Returns what to tell the user, or null when there was nothing to do.
 */
export async function bootstrapWorktree(
  deps: BootstrapDeps,
  input: { repoRoot: string; path: string; command?: string; env: Record<string, string> }
): Promise<BootstrapReport | null> {
  const { t, log } = deps
  const lines: string[] = []
  let failed = false
  let output: string | undefined

  let copy: IncludeCopyResult | undefined
  try {
    copy = await deps.worktrees.copyIncluded(input.repoRoot, input.path)
  } catch (err) {
    failed = true
    lines.push(t('worktreeBootstrap.copyFailed', { error: err instanceof Error ? err.message : String(err) }))
  }
  if (copy?.found) {
    log?.(`worktree ${input.path}: .worktreeinclude copied ${copy.copied.length} files (${size(copy.bytes)}): ${copy.copied.join(', ') || 'none'}${copy.skipped.length ? `; left out: ${copy.skipped.map((s) => `${s.path} (${s.reason})`).join(', ')}` : ''}`)
    if (copy.copied.length) lines.push(t('worktreeBootstrap.copied', { count: copy.copied.length, size: size(copy.bytes) }))
    if (copy.skipped.length) lines.push(t('worktreeBootstrap.notCopied', { count: copy.skipped.length, files: MAX_INCLUDE_FILES, mib: MAX_INCLUDE_BYTES / 1024 / 1024 }))
  }

  const command = input.command?.trim()
  if (command) {
    const started = Date.now()
    const timeoutMs = deps.timeoutMs ?? SETUP_TIMEOUT_MS
    try {
      const run = await (deps.run ?? runSetupCommand)(command, { cwd: input.path, env: input.env, timeoutMs })
      output = run.output
      const tail = lastLines(run.output)
      if (run.timedOut) {
        failed = true
        lines.push(t('worktreeBootstrap.setupTimeout', { minutes: Math.round(timeoutMs / 60_000) }), tail)
      } else if (run.exitCode !== 0) {
        failed = true
        lines.push(t('worktreeBootstrap.setupFailed', { code: run.exitCode ?? '?' }), tail)
      } else {
        lines.push(t('worktreeBootstrap.setupOk', { seconds: Math.round((Date.now() - started) / 1000) }))
        if (tail) lines.push(tail)
      }
    } catch (err) {
      failed = true
      lines.push(t('worktreeBootstrap.setupError', { error: err instanceof Error ? err.message : String(err) }))
    }
    log?.(`worktree ${input.path}: setup command ${failed ? 'did not succeed' : 'succeeded'}${output ? `:\n${lastLines(output, 200)}` : ''}`)
  }

  if (!lines.length) return null
  return { title: t(failed ? 'worktreeBootstrap.failedTitle' : 'worktreeBootstrap.title'), text: lines.filter(Boolean).join('\n'), failed, ...(output !== undefined ? { output } : {}) }
}
