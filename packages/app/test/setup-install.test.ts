import { describe, expect, it } from 'vitest'
import { registerSetupInstallIpc } from '../src/main/setup-ipc'
import { INSTALL_OUTPUT_CAP, runInShell, SetupInstaller } from '../src/main/setup-install'

describe('SetupInstaller', () => {
  it('runs only the table command for the platform', async () => {
    const seen: string[] = []
    const installer = new SetupInstaller({ platform: 'linux', run: async (command) => (seen.push(command), { ok: true, output: 'done' }) })
    expect(await installer.install('claudeCode')).toEqual({ ok: true, output: 'done' })
    expect(seen).toEqual(['curl -fsSL https://claude.ai/install.sh | bash'])
  })
  it('checks Homebrew and npm before choosing, and never runs a command that needs administrator rights', async () => {
    const seen: string[] = []
    const runner = async (command: string) => (seen.push(command), { ok: true, output: '' })
    const withBrew = new SetupInstaller({ platform: 'darwin', context: async () => ({ brew: true }), run: runner })
    expect((await withBrew.install('github')).ok).toBe(true)
    const noBrew = new SetupInstaller({ platform: 'darwin', context: async () => ({ brew: false }), run: runner })
    expect((await noBrew.install('github')).ok).toBe(false)
    expect((await noBrew.install('node')).ok).toBe(true)
    const linux = new SetupInstaller({ platform: 'linux', context: async () => ({ brew: true, npm: true }), run: runner })
    expect((await linux.install('git')).ok).toBe(false)
    expect((await linux.install('github')).ok).toBe(false)
    expect((await new SetupInstaller({ platform: 'win32', run: runner }).install('git')).ok).toBe(false)
    expect(seen).toEqual(['brew install gh', expect.stringContaining('nvm install --lts')])
  })
  it('refuses unknown ids, free-form commands and platforms without an installer', async () => {
    const seen: string[] = []
    const installer = new SetupInstaller({ platform: 'linux', run: async (c) => (seen.push(c), { ok: true, output: '' }) })
    for (const bad of ['rm -rf /', 'toString', 42, null, undefined]) expect((await installer.install(bad)).ok).toBe(false)
    expect((await installer.install('github')).ok).toBe(false)
    expect(seen).toEqual([])
  })
  it('allows one install at a time', async () => {
    let release = () => {}
    const installer = new SetupInstaller({ platform: 'darwin', run: () => new Promise((r) => (release = () => r({ ok: true, output: '' }))) })
    const first = installer.install('codex')
    expect((await installer.install('kiro')).ok).toBe(false)
    release()
    expect((await first).ok).toBe(true)
    release = () => {}
    const again = installer.install('kiro')
    release()
    expect((await again).ok).toBe(true)
  })
  it('caps the output of a real shell run and reports failure', async () => {
    if (process.platform === 'win32') return
    const noisy = await runInShell(`node -e "process.stdout.write('x'.repeat(10000))"`, { platform: process.platform, timeoutMs: 20_000 })
    expect(noisy.ok).toBe(true)
    expect(noisy.output.length).toBe(INSTALL_OUTPUT_CAP)
    expect(await runInShell('echo boom; exit 3', { platform: process.platform, timeoutMs: 20_000 })).toMatchObject({ ok: false, output: expect.stringContaining('boom') })
  })
})

describe('registerSetupInstallIpc', () => {
  it('registers setup:install and passes only the installer id on', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const got: unknown[] = []
    registerSetupInstallIpc({ handle: (c, l) => void handlers.set(c, l as never), on: () => undefined }, { install: async (id) => (got.push(id), { ok: true, output: '' }) })
    await handlers.get('setup:install')!({}, 'codex', 'ignored extra')
    expect(got).toEqual(['codex'])
  })
})

describe('SetupInstaller with the tools Workhub installs itself', () => {
  const fakeManaged = (hasNode: boolean, results: Record<string, { ok: true } | { ok: false; reason: 'checksum'; detail: string }> = {}) => {
    const calls: string[] = []
    let node = hasNode
    return {
      calls,
      hasNode: () => node,
      install: async (id: string) => {
        calls.push(id)
        if (id === 'node') node = true
        return results[id] ?? { ok: true as const }
      }
    }
  }

  it('installs into the tools folder instead of running a command, Node.js first for an npm agent', async () => {
    const shell: string[] = []
    const managed = fakeManaged(false)
    const installer = new SetupInstaller({ platform: 'win32', arch: 'x64', managed: managed as never, run: async (c) => (shell.push(c), { ok: true, output: '' }) })
    expect(await installer.install('opencode')).toEqual({ ok: true, output: '' })
    expect(managed.calls).toEqual(['node', 'opencode'])
    expect(await installer.install('git')).toEqual({ ok: true, output: '' })
    expect(managed.calls).toEqual(['node', 'opencode', 'git'])
    // Claude Code keeps its official script.
    await installer.install('claudeCode')
    expect(shell).toEqual(['irm https://claude.ai/install.ps1 | iex'])
  })

  it('reports why a managed install failed and stops before the agent when Node.js fails', async () => {
    const managed = fakeManaged(false, { node: { ok: false, reason: 'checksum', detail: 'mismatch' } })
    const installer = new SetupInstaller({ platform: 'linux', arch: 'arm64', managed: managed as never })
    expect(await installer.install('gemini')).toEqual({ ok: false, output: 'mismatch', reason: 'checksum' })
    expect(managed.calls).toEqual(['node'])
  })
})
