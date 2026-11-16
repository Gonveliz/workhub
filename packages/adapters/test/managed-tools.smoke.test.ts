/**
 * A real run of the managed tools installer (not part of the normal suite): downloads and checks
 * Workhub's own Node.js, installs OpenCode with it into a temporary tools folder, and runs both from
 * there. CI runs it on Windows and Linux (`managed-tools` job); locally:
 * `WORKHUB_MANAGED_TOOLS_SMOKE=1 npx vitest run --project adapters test/managed-tools.smoke.test.ts`.
 * It writes nothing outside its temporary folder (npm's cache goes in there too).
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { privateNode } from '@workhub/core'
import { ManagedToolsInstaller, type ManagedProgress } from '../src/managed-tools'

const enabled = process.env['WORKHUB_MANAGED_TOOLS_SMOKE'] === '1'
const toolsDir = enabled ? mkdtempSync(join(tmpdir(), 'workhub-tools-')) : ''
const log = (line: string) => console.log(`[managed-tools] ${line}`)

function runFile(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    // A `.cmd` shim (npm on Windows) needs cmd.exe; the path is fixed, nothing comes from input.
    execFile(file, args, { env, windowsHide: true, timeout: 120_000, shell: /\.cmd$/i.test(file) }, (err, stdout, stderr) => {
      done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, output: `${stdout}${stderr}`.trim() })
    })
  })
}

describe.skipIf(!enabled)('managed tools, for real', () => {
  const installer = new ManagedToolsInstaller({
    toolsDir,
    platform: process.platform,
    arch: process.arch,
    fetch: (url, init) => fetch(url, init),
    env: () => ({ ...process.env, npm_config_cache: join(toolsDir, '.npm-cache') })
  })
  const env = () => {
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    const delimiter = process.platform === 'win32' ? ';' : ':'
    return { ...process.env, [key]: [...installer.pathFolders(), process.env[key] ?? ''].join(delimiter) }
  }
  let lastPhase = ''
  const progress = (name: string) => (p: ManagedProgress) => {
    if (p.phase === lastPhase) return
    lastPhase = p.phase
    log(`${name}: ${p.phase}${p.total ? ` (${Math.round(p.total / 1e6)} MB)` : ''}`)
  }

  afterAll(() => {
    if (process.env['WORKHUB_MANAGED_TOOLS_KEEP'] !== '1') rmSync(toolsDir, { recursive: true, force: true })
  })

  it('installs Node.js and runs it from the tools folder', async () => {
    log(`tools folder: ${toolsDir} (${process.platform}-${process.arch})`)
    const result = await installer.install('node', { onProgress: progress('node') })
    log(`node: ${JSON.stringify(result)}`)
    expect(result).toEqual({ ok: true })
    const r = await runFile(privateNode(toolsDir, process.platform).node, ['--version'], env())
    log(`node --version -> exit ${r.code}: ${r.output}`)
    expect(r.code).toBe(0)
  }, 600_000)

  it('installs OpenCode with that Node.js and runs it', async () => {
    const { node, npmCli } = privateNode(toolsDir, process.platform)
    log(`npm --version -> ${(await runFile(node, [npmCli, '--version'], env())).output}`)
    const result = await installer.install('opencode', { onProgress: progress('opencode') })
    log(`opencode: ${result.ok ? 'ok' : `${result.reason}\n${result.detail}`}`)
    expect(result.ok).toBe(true)
    const bin = process.platform === 'win32' ? join(toolsDir, 'npm', 'opencode.cmd') : join(toolsDir, 'npm', 'bin', 'opencode')
    const r = await runFile(bin, ['--version'], env())
    log(`opencode --version -> exit ${r.code}: ${r.output}`)
    expect(r.code).toBe(0)
    log(`installed: ${JSON.stringify(await installer.installed())}`)
  }, 900_000)
})
