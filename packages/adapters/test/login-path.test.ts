import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_AGENTS } from '@workhub/core'
import type * as nodePty from 'node-pty'
import { createCliRunner } from '../src/shared/cli'
import { runGit } from '../src/git-review'
import { runWorktreeGit } from '../src/git-worktree'
import { TerminalRuntime } from '../src/agent-terminal'
import { augmentedPath, parsePrintedPath, PRINT_PATH_COMMAND, readLoginShellPath, refreshLoginPath, utf8LocaleEnv, withFoldersFirst } from '../src/shared/login-path'

const launchd = '/usr/bin:/bin:/usr/sbin:/sbin'

describe('parsePrintedPath', () => {
  it('reads the PATH between the markers and ignores profile banners around it', () => {
    expect(parsePrintedPath('Welcome!\n__WORKHUB_PATH__/opt/homebrew/bin:/usr/bin__WORKHUB_PATH__\nbye')).toBe('/opt/homebrew/bin:/usr/bin')
    expect(parsePrintedPath('no markers here')).toBeNull()
    expect(parsePrintedPath('__WORKHUB_PATH__/usr/bin')).toBeNull()
    expect(parsePrintedPath('__WORKHUB_PATH____WORKHUB_PATH__')).toBeNull()
  })
})

describe('augmentedPath', () => {
  it('puts the login shell PATH first, then the inherited one, then the usual CLI folders, without duplicates', () => {
    expect(augmentedPath({ platform: 'darwin', inherited: launchd, loginShell: '/Users/dana/.nvm/bin:/opt/homebrew/bin:/usr/bin', home: '/Users/dana' })).toBe(
      '/Users/dana/.nvm/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/Users/dana/.local/bin'
    )
  })
  it('falls back to the inherited PATH plus the usual CLI folders without a login shell PATH', () => {
    expect(augmentedPath({ platform: 'darwin', inherited: launchd, loginShell: null, home: '/Users/dana' })).toBe(`${launchd}:/opt/homebrew/bin:/usr/local/bin:/Users/dana/.local/bin`)
    expect(augmentedPath({ platform: 'linux', inherited: undefined, loginShell: null, home: '/home/dana' })).toBe('/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:/home/dana/.local/bin')
  })
  it('leaves Windows alone', () => {
    expect(augmentedPath({ platform: 'win32', inherited: 'C:\\Windows;C:\\Tools', loginShell: '/usr/bin' })).toBe('C:\\Windows;C:\\Tools')
  })
})

describe('readLoginShellPath', () => {
  it('runs the login shell interactively with a timeout and parses its output', async () => {
    const calls: [string, string[], number][] = []
    const path = await readLoginShellPath({
      platform: 'darwin',
      shell: '/bin/zsh',
      timeoutMs: 1234,
      run: async (shell, args, timeoutMs) => (calls.push([shell, args, timeoutMs]), 'motd\n__WORKHUB_PATH__/opt/homebrew/bin:/usr/bin__WORKHUB_PATH__')
    })
    expect(path).toBe('/opt/homebrew/bin:/usr/bin')
    expect(calls).toEqual([['/bin/zsh', ['-ilc', PRINT_PATH_COMMAND], 1234]])
  })
  it('gives null on a failure or a timeout, and never runs a shell on Windows', async () => {
    expect(await readLoginShellPath({ platform: 'linux', shell: '/bin/bash', run: async () => Promise.reject(new Error('timed out')) })).toBeNull()
    let ran = false
    expect(await readLoginShellPath({ platform: 'win32', run: async () => ((ran = true), '') })).toBeNull()
    expect(ran).toBe(false)
  })
  it.skipIf(process.platform === 'win32')('reads a real shell', async () => {
    expect(await readLoginShellPath({ shell: '/bin/sh' })).toBeTruthy()
  })
})

describe('TerminalRuntime PATH', () => {
  it('starts a session with the given PATH and the fallback folders last', async () => {
    let env: Record<string, string> | undefined
    const fakePty = { onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill() {}, write() {}, resize() {} }
    const spawn = ((_file: string, _args: string[], options: { env?: Record<string, string> }) => ((env = options.env), fakePty)) as unknown as typeof nodePty.spawn
    const rt = new TerminalRuntime({ spawn, path: () => '/opt/homebrew/bin:/usr/bin', fallbackPath: ['/bundle/claude'] })
    const shell = BUILTIN_AGENTS.find((a) => a.id === 'shell')!
    await rt.start({ sessionId: 'p1', agent: shell, account: null, cwd: process.cwd(), env: { ACME: '1' } })
    const key = Object.keys(env!).find((k) => k.toUpperCase() === 'PATH')!
    const sep = process.platform === 'win32' ? ';' : ':'
    expect(env![key]).toBe(['/opt/homebrew/bin:/usr/bin', '/bundle/claude'].join(sep))
    expect(env!['ACME']).toBe('1')
  })
})

describe('TerminalRuntime on Windows', () => {
  it('starts a command by its full path found on the session PATH, the bundled folder included', async () => {
    const bundle = mkdtempSync(join(tmpdir(), 'wh-bundle-'))
    writeFileSync(join(bundle, 'claude.exe'), '')
    const files: string[] = []
    const fakePty = { onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), kill() {}, write() {}, resize() {} }
    const spawn = ((file: string) => (files.push(file), fakePty)) as unknown as typeof nodePty.spawn
    try {
      const rt = new TerminalRuntime({ spawn, platform: 'win32', path: () => join(bundle, 'empty'), fallbackPath: [bundle] })
      const claude = { ...BUILTIN_AGENTS.find((a) => a.id === 'shell')!, command: 'claude', args: [] }
      await rt.start({ sessionId: 'w1', agent: claude, account: null, cwd: process.cwd(), env: {} })
      // A command found nowhere is passed as is, so node-pty reports it.
      await rt.start({ sessionId: 'w2', agent: { ...claude, command: 'workhub-no-such-cli' }, account: null, cwd: process.cwd(), env: {} })
      expect(files).toEqual([join(bundle, 'claude.exe'), 'workhub-no-such-cli'])
    } finally {
      rmSync(bundle, { recursive: true, force: true })
    }
  })
})

describe('utf8LocaleEnv', () => {
  it('sets a UTF-8 character type only when no locale variable is set, and never on Windows', () => {
    expect(utf8LocaleEnv('darwin', {})).toEqual({ LC_CTYPE: 'UTF-8' })
    expect(utf8LocaleEnv('linux', { LANG: '' })).toEqual({ LC_CTYPE: 'C.UTF-8' })
    expect(utf8LocaleEnv('darwin', { LANG: 'es_AR.UTF-8' })).toEqual({})
    expect(utf8LocaleEnv('darwin', { LC_ALL: 'C' })).toEqual({})
    expect(utf8LocaleEnv('win32', {})).toEqual({})
  })
})

describe('refreshLoginPath', () => {
  const run = async () => `banner__WORKHUB_PATH__/Users/dana/.nvm/bin:/usr/bin__WORKHUB_PATH__`

  it('writes the login shell PATH into the environment, from the PATH the app started with', async () => {
    const env: Record<string, string | undefined> = { PATH: 'stale:/usr/bin' }
    const path = await refreshLoginPath(env, launchd, { platform: 'darwin', home: '/Users/dana', run })
    expect(path).toBe(`/Users/dana/.nvm/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:/Users/dana/.local/bin`)
    expect(env['PATH']).toBe(path)
  })

  it('leaves the environment alone on Windows and when the shell cannot be read', async () => {
    const env: Record<string, string | undefined> = { Path: 'C:\\Windows' }
    expect(await refreshLoginPath(env, 'C:\\Windows', { platform: 'win32', run })).toBeNull()
    expect(await refreshLoginPath(env, launchd, { platform: 'darwin', run: async () => { throw new Error('timeout') } })).toBeNull()
    expect(env).toEqual({ Path: 'C:\\Windows' })
  })
})

describe.skipIf(process.platform === 'win32')('child processes use the PATH set in the environment', () => {
  const saved = process.env['PATH']
  let dir: string
  afterEach(() => {
    process.env['PATH'] = saved
    rmSync(dir, { recursive: true, force: true })
  })

  it('gh/glab runner, git review and git worktree runners all resolve and see the same PATH', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wh-path-'))
    // A `git` that only exists in a folder the process was not started with, and echoes its PATH.
    const fake = join(dir, 'git')
    writeFileSync(fake, '#!/bin/sh\necho "$PATH"\n')
    chmodSync(fake, 0o755)
    process.env['PATH'] = `${dir}:${saved ?? ''}`
    const review = await runGit(dir, [])
    const worktree = await runWorktreeGit(dir, [])
    expect(review.stdout.trim().startsWith(dir)).toBe(true)
    expect(worktree.stdout.trim().startsWith(dir)).toBe(true)
    const cli = await createCliRunner([])('git', [])
    expect(cli.stdout.trim().startsWith(dir)).toBe(true)
  })
})

describe('withFoldersFirst', () => {
  it('puts Workhub’s tools folders first, once, on every system', () => {
    const tools = ['/data/tools/node/bin', '/data/tools/npm/bin']
    expect(withFoldersFirst('/opt/homebrew/bin:/usr/bin', tools, ':')).toBe('/data/tools/node/bin:/data/tools/npm/bin:/opt/homebrew/bin:/usr/bin')
    // Read again after an install: no duplicates, and a folder the PATH had later moves to the front.
    expect(withFoldersFirst('/data/tools/node/bin:/usr/bin:/data/tools/npm/bin', tools, ':')).toBe('/data/tools/node/bin:/data/tools/npm/bin:/usr/bin')
    const win = ['C:\\d\\tools\\node', 'C:\\d\\tools\\git\\cmd']
    expect(withFoldersFirst('C:\\Windows\\system32;;C:\\Program Files\\nodejs', win, ';')).toBe('C:\\d\\tools\\node;C:\\d\\tools\\git\\cmd;C:\\Windows\\system32;C:\\Program Files\\nodejs')
    expect(withFoldersFirst('', tools, ':')).toBe('/data/tools/node/bin:/data/tools/npm/bin')
  })
})
