/**
 * Installs the tools of the managed table (core setup/managed-tools.ts) into Workhub's tools
 * folder: an archive is downloaded to a temporary name, checked against its checksum, unpacked into
 * a staging folder and only then moved into place; an npm package is installed with Workhub's own
 * Node.js. A failure leaves the previous state: nothing half-installed.
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import {
  checksumFor,
  downloadFileName,
  managedDownload,
  managedExecutable,
  managedPathFolders,
  MANAGED_TOOLS,
  npmInstallArgs,
  npmPackageDir,
  npmPrefixOf,
  npmUninstallArgs,
  npmWarmArgs,
  privateNode,
  type ManagedFailure,
  type ManagedPhase,
  type ManagedToolId,
  type NpmTool
} from '@workhub/core'
import { ArchiveError, extractArchive } from './archive'

export type ManagedResult = { ok: true } | { ok: false; reason: ManagedFailure; detail: string }

export type { ManagedFailure, ManagedPhase }

export interface ManagedProgress {
  phase: ManagedPhase
  /** Bytes downloaded so far and the total when the server said it (downloading only). */
  received?: number
  total?: number
}

/** What Settings lists: a tool in the tools folder, its version and the space it takes. */
export interface InstalledManagedTool {
  id: ManagedToolId
  version: string
  bytes: number
}

/** `fetch` (Electron's `net.fetch` in the app, so the system proxy applies). */
export type Fetcher = (url: string, init: { signal?: AbortSignal }) => Promise<Response>

/** Runs a program with arguments, never through a shell. */
export type ProgramRunner = (file: string, args: string[], options: { env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number }) => Promise<{ ok: boolean; output: string }>

export interface ManagedToolsDeps {
  toolsDir: string
  platform: NodeJS.Platform
  arch: string
  fetch: Fetcher
  run?: ProgramRunner
  /** The environment npm runs with; the tools folder is put first on its PATH. */
  env?: () => NodeJS.ProcessEnv
  /** How long a rename may be retried while something (an antivirus) holds the file. */
  renameRetries?: number
  renameDelayMs?: number
}

/** An HTTP answer that is not a success. */
export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
    this.name = 'HttpError'
  }
}

export class ChecksumError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChecksumError'
  }
}

/** One file at most this big comes down (the largest archive is under 100 MB). */
const MAX_DOWNLOAD = 400 * 1024 * 1024
const NPM_TIMEOUT_MS = 15 * 60_000
const OUTPUT_TAIL = 2000
const MANIFEST = '.workhub-tool.json'
const PARTIAL = '.partial'

const isHttps = (url: string): boolean => /^https:\/\//i.test(url)

/** Downloads one address to `dest` (created new), hashing it on the way. HTTPS only, redirects included. */
export async function downloadTo(fetcher: Fetcher, url: string, dest: string, options: { signal?: AbortSignal; onProgress?: (received: number, total?: number) => void } = {}): Promise<string> {
  if (!isHttps(url)) throw new Error(`Refused a download that is not HTTPS: ${url}`)
  const response = await fetcher(url, { signal: options.signal })
  if (response.url && !isHttps(response.url)) throw new Error(`Refused a redirect that is not HTTPS: ${response.url}`)
  if (!response.ok) throw new HttpError(response.status)
  if (!response.body) throw new Error('The server sent no file.')
  const totalHeader = Number(response.headers.get('content-length'))
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : undefined
  const hash = createHash('sha256')
  const handle = await open(dest, 'wx')
  let received = 0
  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > MAX_DOWNLOAD) throw new Error('The download is larger than expected.')
      hash.update(value)
      await handle.write(value)
      options.onProgress?.(received, total)
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

async function fetchText(fetcher: Fetcher, url: string, signal?: AbortSignal): Promise<string> {
  if (!isHttps(url)) throw new Error(`Refused a download that is not HTTPS: ${url}`)
  const response = await fetcher(url, { signal })
  if (response.url && !isHttps(response.url)) throw new Error(`Refused a redirect that is not HTTPS: ${response.url}`)
  if (!response.ok) throw new HttpError(response.status)
  const text = await response.text()
  if (text.length > 1024 * 1024) throw new Error('The checksum list is larger than expected.')
  return text
}

const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'])

/** The reason of a failure, from the error (Node's fetch, Electron's net, the file system). */
export function classifyFailure(err: unknown, signal?: AbortSignal): { reason: ManagedFailure; detail: string } {
  const message = err instanceof Error ? err.message : String(err)
  if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) return { reason: 'canceled', detail: '' }
  if (err instanceof ChecksumError) return { reason: 'checksum', detail: message }
  if (err instanceof ArchiveError) return { reason: 'badArchive', detail: message }
  if (err instanceof HttpError) return { reason: err.status === 407 ? 'proxy' : 'http', detail: String(err.status) }
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? ((err as { cause?: NodeJS.ErrnoException } | undefined)?.cause?.code as string | undefined)
  if (code === 'ENOSPC' || /ENOSPC|no space left/i.test(message)) return { reason: 'diskFull', detail: message }
  if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') return { reason: 'locked', detail: message }
  if (/ERR_PROXY|ERR_TUNNEL_CONNECTION_FAILED|proxy/i.test(message)) return { reason: 'proxy', detail: message }
  if ((code && NETWORK_CODES.has(code)) || /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_|NETWORK_|TIMED_OUT|ADDRESS_UNREACHABLE)|fetch failed/i.test(message)) return { reason: 'offline', detail: message }
  return { reason: 'failed', detail: message }
}

/** npm's output says why it failed: the network, a proxy, the disk or a locked file. */
export function classifyNpmOutput(output: string): ManagedFailure {
  if (/ENOSPC/.test(output)) return 'diskFull'
  if (/E407|proxy/i.test(output)) return 'proxy'
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|network/i.test(output)) return 'offline'
  if (/EPERM|EBUSY|EACCES/.test(output)) return 'locked'
  return 'npm'
}

const tail = (text: string): string => (text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text).trim()

export const runProgram: ProgramRunner = (file, args, { env, signal, timeoutMs }) =>
  new Promise((done) => {
    execFile(file, args, { env, signal, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      const output = tail(`${stdout}\n${stderr}`)
      if (!err) return done({ ok: true, output })
      done({ ok: false, output: output || err.message })
    })
  })

async function folderSize(path: string): Promise<number> {
  let total = 0
  const st = await lstat(path).catch(() => null)
  if (!st) return 0
  if (!st.isDirectory()) return st.size
  for (const name of await readdir(path).catch(() => [] as string[])) total += await folderSize(join(path, name))
  return total
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class ManagedToolsInstaller {
  constructor(private readonly deps: ManagedToolsDeps) {}

  get toolsDir(): string {
    return this.deps.toolsDir
  }

  /** The tools folder's folders that go first on PATH. */
  pathFolders(): string[] {
    return managedPathFolders(this.deps.toolsDir, this.deps.platform)
  }

  /** Workhub's own Node.js is installed. */
  hasNode(): boolean {
    return existsSync(privateNode(this.deps.toolsDir, this.deps.platform).node)
  }

  async install(id: ManagedToolId, options: { signal?: AbortSignal; onProgress?: (p: ManagedProgress) => void } = {}): Promise<ManagedResult> {
    try {
      const tool = MANAGED_TOOLS[id]
      if (tool.kind === 'npm') return await this.installNpm(tool, options)
      if (!managedDownload(id, this.deps.platform, this.deps.arch)) return { ok: false, reason: 'unsupported', detail: `${this.deps.platform}-${this.deps.arch}` }
      await this.installArchive(id, options)
      return { ok: true }
    } catch (err) {
      return { ok: false, ...classifyFailure(err, options.signal) }
    }
  }

  private async installArchive(id: ManagedToolId, { signal, onProgress }: { signal?: AbortSignal; onProgress?: (p: ManagedProgress) => void }): Promise<void> {
    const tool = MANAGED_TOOLS[id]
    const download = managedDownload(id, this.deps.platform, this.deps.arch)
    if (tool.kind !== 'archive' || !download) throw new Error('No archive for this system.')
    const partial = join(this.deps.toolsDir, PARTIAL)
    // Whatever an earlier install left (the app was closed in the middle) goes first.
    await rm(partial, { recursive: true, force: true })
    await mkdir(partial, { recursive: true })
    const token = randomBytes(6).toString('hex')
    const file = join(partial, `${id}-${token}.download`)
    const staging = join(partial, `${id}-${token}`)
    try {
      onProgress?.({ phase: 'downloading', received: 0, total: download.bytes })
      const actual = await downloadTo(this.deps.fetch, download.url, file, { signal, onProgress: (received, total) => onProgress?.({ phase: 'downloading', received, total: total ?? download.bytes }) })
      onProgress?.({ phase: 'verifying' })
      const expected = 'sha256' in download.checksum ? download.checksum.sha256 : checksumFor(await fetchText(this.deps.fetch, download.checksum.list, signal), downloadFileName(download.url))
      if (!expected) throw new ChecksumError(`${downloadFileName(download.url)} is not in the published checksum list.`)
      if (expected.toLowerCase() !== actual) throw new ChecksumError(`${downloadFileName(download.url)}: expected ${expected.toLowerCase()}, got ${actual}.`)
      onProgress?.({ phase: 'unpacking' })
      await extractArchive(download.format, file, staging, download.strip, signal)
      // The program the tool must have, at the same place under the staging folder.
      const exe = managedExecutable(this.deps.toolsDir, this.deps.platform, id)
      const inStaging = exe ? join(staging, relative(join(this.deps.toolsDir, tool.folder), exe)) : null
      if (inStaging && !existsSync(inStaging)) throw new ArchiveError('The archive does not have the expected program.', 'corrupt')
      await writeFile(join(staging, MANIFEST), JSON.stringify({ id, version: tool.version, url: download.url }))
      await this.moveIntoPlace(staging, join(this.deps.toolsDir, tool.folder), join(partial, `${id}-${token}-old`))
    } finally {
      await rm(file, { force: true }).catch(() => undefined)
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** Swaps the staging folder in; the previous one comes back if the swap fails. */
  private async moveIntoPlace(staging: string, final: string, old: string): Promise<void> {
    const hadOld = existsSync(final)
    if (hadOld) await this.renameRetrying(final, old)
    try {
      await this.renameRetrying(staging, final)
    } catch (err) {
      if (hadOld) await rename(old, final).catch(() => undefined)
      throw err
    }
    if (hadOld) await rm(old, { recursive: true, force: true }).catch(() => undefined)
  }

  /** An antivirus scanning a new file holds it for a moment on Windows: a few tries before giving up. */
  private async renameRetrying(from: string, to: string): Promise<void> {
    const tries = this.deps.renameRetries ?? 8
    for (let i = 0; ; i++) {
      try {
        await rename(from, to)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (i >= tries || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
        await sleep(this.deps.renameDelayMs ?? 500)
      }
    }
  }

  private npmEnv(): NodeJS.ProcessEnv {
    const env = { ...(this.deps.env?.() ?? process.env) }
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    const delimiter = this.deps.platform === 'win32' ? ';' : ':'
    // Install scripts call `node`: Workhub's own comes first.
    env[key] = [...this.pathFolders(), ...(env[key] ?? '').split(delimiter)].filter(Boolean).join(delimiter)
    env['npm_config_update_notifier'] = 'false'
    return env
  }

  private async npmVersion(env: NodeJS.ProcessEnv): Promise<string> {
    const { node, npmCli } = privateNode(this.deps.toolsDir, this.deps.platform)
    const r = await (this.deps.run ?? runProgram)(node, [npmCli, '--version'], { env, timeoutMs: 60_000 })
    return r.ok ? r.output.trim().split(/\s+/).pop()! : '0.0.0'
  }

  private async installNpm(tool: NpmTool, { signal, onProgress }: { signal?: AbortSignal; onProgress?: (p: ManagedProgress) => void }): Promise<ManagedResult> {
    if (!this.hasNode()) return { ok: false, reason: 'needsNode', detail: '' }
    onProgress?.({ phase: 'installing' })
    const env = this.npmEnv()
    const version = await this.npmVersion(env)
    const { node, npmCli } = privateNode(this.deps.toolsDir, this.deps.platform)
    const prefix = npmPrefixOf(this.deps.toolsDir, this.deps.platform)
    await mkdir(prefix, { recursive: true })
    const args = tool.mode === 'global' ? npmInstallArgs(tool, prefix, version) : npmWarmArgs(tool, version)
    const r = await (this.deps.run ?? runProgram)(node, [npmCli, ...args], { env, signal, timeoutMs: NPM_TIMEOUT_MS })
    if (signal?.aborted) return { ok: false, reason: 'canceled', detail: '' }
    if (!r.ok) return { ok: false, reason: classifyNpmOutput(r.output), detail: r.output }
    if (tool.mode === 'global' && !existsSync(npmPackageDir(this.deps.toolsDir, this.deps.platform, tool.packageName))) return { ok: false, reason: 'npm', detail: r.output }
    return { ok: true }
  }

  /** The tools in the folder: archives by their manifest, npm packages by their package.json. */
  async installed(): Promise<InstalledManagedTool[]> {
    const out: InstalledManagedTool[] = []
    for (const tool of Object.values(MANAGED_TOOLS)) {
      if (tool.kind === 'archive') {
        const dir = join(this.deps.toolsDir, tool.folder)
        const manifest = await readFile(join(dir, MANIFEST), 'utf8').catch(() => null)
        if (!manifest) continue
        const version = (() => {
          try {
            return String((JSON.parse(manifest) as { version?: unknown }).version ?? '')
          } catch {
            return ''
          }
        })()
        out.push({ id: tool.id, version, bytes: await folderSize(dir) })
      } else if (tool.mode === 'global') {
        const dir = npmPackageDir(this.deps.toolsDir, this.deps.platform, tool.packageName)
        const pkg = await readFile(join(dir, 'package.json'), 'utf8').catch(() => null)
        if (!pkg) continue
        let version = ''
        try {
          version = String((JSON.parse(pkg) as { version?: unknown }).version ?? '')
        } catch {
          /* unreadable: listed without a version */
        }
        out.push({ id: tool.id, version, bytes: await folderSize(dir) })
      }
    }
    return out
  }

  /**
   * Removes one tool from the folder. Node.js takes the agents installed with it along (they cannot
   * run without it). A file in use (the tool is running) ends as `locked`.
   */
  async remove(id: ManagedToolId): Promise<ManagedResult> {
    const tool = MANAGED_TOOLS[id]
    try {
      if (tool.kind === 'archive') {
        if (id === 'node') await rm(npmPrefixOf(this.deps.toolsDir, this.deps.platform), { recursive: true, force: true })
        await rm(join(this.deps.toolsDir, tool.folder), { recursive: true, force: true })
        return { ok: true }
      }
      if (tool.mode !== 'global') return { ok: true }
      if (this.hasNode()) {
        const env = this.npmEnv()
        const { node, npmCli } = privateNode(this.deps.toolsDir, this.deps.platform)
        const r = await (this.deps.run ?? runProgram)(node, [npmCli, ...npmUninstallArgs(tool, npmPrefixOf(this.deps.toolsDir, this.deps.platform))], { env, timeoutMs: NPM_TIMEOUT_MS })
        if (!r.ok) return { ok: false, reason: classifyNpmOutput(r.output), detail: r.output }
      } else {
        await rm(npmPackageDir(this.deps.toolsDir, this.deps.platform, tool.packageName), { recursive: true, force: true })
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, ...classifyFailure(err) }
    }
  }
}
