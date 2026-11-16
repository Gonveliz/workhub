import { describe, expect, it } from 'vitest'
import {
  BUILTIN_AGENTS,
  checksumFor,
  codexItem,
  installFix,
  installMethod,
  installPlanEntry,
  installQueue,
  managedAvailable,
  managedDownload,
  managedPathFolders,
  MANAGED_TOOLS,
  missingInstallers,
  npmHasAllowScripts,
  npmInstallArgs,
  npmWarmArgs,
  privateNode,
  type NpmTool,
  type SetupItem
} from '../src'

const archives = Object.values(MANAGED_TOOLS).flatMap((t) => (t.kind === 'archive' ? Object.entries(t.downloads).map(([key, d]) => ({ id: t.id, key, ...d! })) : []))

describe('managed tools table', () => {
  it('every address is fixed, HTTPS and on the vendor’s own host, with a checksum', () => {
    expect(archives.length).toBe(20)
    const hosts: Record<string, string> = { node: 'nodejs.org', git: 'github.com', github: 'github.com', gitlab: 'gitlab.com' }
    for (const d of archives) {
      expect(d.url, d.url).toMatch(new RegExp(`^https://${hosts[d.id]!.replace('.', '\\.')}/[A-Za-z0-9._/-]+$`))
      expect(d.url).not.toMatch(/\$\{|\.\.|\s/)
      if ('sha256' in d.checksum) expect(d.checksum.sha256).toMatch(/^[0-9a-f]{64}$/)
      else expect(d.checksum.list).toMatch(new RegExp(`^https://${hosts[d.id]!.replace('.', '\\.')}/`))
      expect(d.bytes).toBeGreaterThan(1_000_000)
    }
    // Git for Windows publishes its sums in the release notes only: they are pinned here.
    expect(archives.filter((d) => 'sha256' in d.checksum).map((d) => d.id)).toEqual(['git', 'git'])
  })

  it('has archives for x64 and arm64 on the three systems, and Git only on Windows', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      for (const arch of ['x64', 'arm64']) {
        expect(managedDownload('node', platform, arch)).not.toBeNull()
        expect(managedDownload('github', platform, arch)).not.toBeNull()
        expect(managedDownload('gitlab', platform, arch)).not.toBeNull()
        expect(managedDownload('git', platform, arch) !== null).toBe(platform === 'win32')
      }
    }
    expect(managedDownload('node', 'linux', 'ia32')).toBeNull()
    expect(managedAvailable('opencode', 'win32', 'x64')).toBe(true)
    expect(managedAvailable('opencode', 'freebsd', 'x64')).toBe(false)
  })

  it('warms the exact package Codex sessions start through npx', () => {
    const codex = BUILTIN_AGENTS.find((a) => a.id === 'codex')!
    const tool = MANAGED_TOOLS.codexAdapter as NpmTool
    expect(codex.args).toContain(tool.spec)
    expect(tool.packageName).toBe('@agentclientprotocol/codex-acp')
  })
})

describe('npm arguments', () => {
  const opencode = MANAGED_TOOLS.opencode as NpmTool
  it('allows install scripts for exactly the package installed, where npm has the setting', () => {
    expect(npmHasAllowScripts('11.16.0')).toBe(true)
    expect(npmHasAllowScripts('12.2.2')).toBe(true)
    expect(npmHasAllowScripts('11.15.9')).toBe(false)
    expect(npmHasAllowScripts('10.9.4')).toBe(false)
    const args = npmInstallArgs(opencode, '/tools/npm', '11.20.0')
    expect(args).toEqual(['install', '--global', '--prefix=/tools/npm', '--ignore-scripts=false', '--allow-scripts=opencode-ai', '--no-fund', '--no-audit', '--loglevel=error', 'opencode-ai'])
    expect(args.filter((a) => a.startsWith('--allow-scripts'))).toHaveLength(1)
    expect(args).not.toContain('--dangerously-allow-all-scripts')
    // Older npm runs every install script by default and does not know the flag.
    expect(npmInstallArgs(opencode, '/tools/npm', '10.9.4')).not.toContainEqual(expect.stringContaining('allow-scripts'))
  })
  it('warms the npx cache with the same package list as `npx -y <spec>`', () => {
    const codex = MANAGED_TOOLS.codexAdapter as NpmTool
    expect(npmWarmArgs(codex, '12.0.0')).toEqual(['exec', '--yes', `--package=${codex.spec}`, '--ignore-scripts=false', '--allow-scripts=@agentclientprotocol/codex-acp', '--loglevel=error', '--', 'node', '-e', '0'])
  })
})

describe('paths', () => {
  it('puts Node.js and the npm prefix first, then the code tools', () => {
    expect(managedPathFolders('C:\\Users\\a\\AppData\\Roaming\\W\\tools', 'win32')).toEqual([
      'C:\\Users\\a\\AppData\\Roaming\\W\\tools\\node',
      'C:\\Users\\a\\AppData\\Roaming\\W\\tools\\npm',
      'C:\\Users\\a\\AppData\\Roaming\\W\\tools\\git\\cmd',
      'C:\\Users\\a\\AppData\\Roaming\\W\\tools\\github\\bin',
      'C:\\Users\\a\\AppData\\Roaming\\W\\tools\\gitlab\\bin'
    ])
    expect(managedPathFolders('/data/tools', 'linux')).toEqual(['/data/tools/node/bin', '/data/tools/npm/bin', '/data/tools/github/bin', '/data/tools/gitlab/bin'])
    expect(privateNode('/data/tools', 'darwin')).toEqual({ node: '/data/tools/node/bin/node', npmCli: '/data/tools/node/lib/node_modules/npm/bin/npm-cli.js' })
    expect(privateNode('C:\\t', 'win32').npmCli).toBe('C:\\t\\node\\node_modules\\npm\\bin\\npm-cli.js')
  })
})

describe('checksumFor', () => {
  it('reads the line of one file, in either sum format', () => {
    const a = 'a'.repeat(64)
    const b = 'B'.repeat(64)
    const list = `${a}  node-v1-linux-x64.tar.gz\n${b} *gh_1_windows_amd64.zip\r\n`
    expect(checksumFor(list, 'node-v1-linux-x64.tar.gz')).toBe(a)
    expect(checksumFor(list, 'gh_1_windows_amd64.zip')).toBe('b'.repeat(64))
    expect(checksumFor(list, 'linux-x64.tar.gz')).toBeNull()
    expect(checksumFor('not a sum  file.zip', 'file.zip')).toBeNull()
  })
})

describe('install queue and plan', () => {
  const win = { platform: 'win32', arch: 'x64' }
  it('Windows: every row Workhub can install itself, with no administrator rights', () => {
    for (const id of ['node', 'git', 'github', 'gitlab', 'opencode', 'gemini', 'codexAdapter'] as const) expect(installMethod(id, win)?.managed, id).toBe(id)
    expect(installFix('opencode', win)).toMatchObject({ kind: 'install', installer: 'opencode', managed: true })
    // Without an archive for the processor, today's methods stay.
    expect(installFix('node', 'win32')).toMatchObject({ kind: 'link', admin: true })
  })
  it('runs Node.js first when an npm tool needs it, in a fixed order, without repeats or unknown ids', () => {
    expect(installQueue(['gemini', 'opencode', 'git', 'opencode', 'rm -rf /', 42], win, false)).toEqual(['node', 'git', 'opencode', 'gemini'])
    expect(installQueue(['opencode'], win, true)).toEqual(['opencode'])
    expect(installQueue(['github', 'claudeCode'], win, false)).toEqual(['github', 'claudeCode'])
    // A copy-only method is never queued.
    expect(installQueue(['git'], { platform: 'linux', arch: 'x64' }, false)).toEqual([])
  })
  it('says where each download comes from, how large it is, and whether it is checked', () => {
    expect(installPlanEntry('node', win)).toEqual({ installer: 'node', source: 'nodejs.org', bytes: 41_166_246, managed: true, version: '26.13.1', checksum: true })
    expect(installPlanEntry('opencode', win)).toMatchObject({ source: 'registry.npmjs.org', managed: true, checksum: true })
    expect(installPlanEntry('claudeCode', win)).toEqual({ installer: 'claudeCode', source: 'claude.ai', bytes: null, managed: false, version: null, checksum: false })
  })
  it('codex: fetches its adapter (with Workhub’s Node.js) where it can', () => {
    const missing = { result: 'notFound' as const, output: '' }
    expect(codexItem(missing, missing, win).fix).toMatchObject({ kind: 'install', installer: 'codexAdapter', managed: true })
    expect(codexItem(missing, missing, 'win32').fix).toMatchObject({ kind: 'link' })
  })
  it('missingInstallers: needed rows that are not ready and have an Install fix', () => {
    const row = (kind: SetupItem['kind'], status: SetupItem['status'], optional: boolean, installer?: string): SetupItem => ({ id: kind, kind, status, code: '', params: {}, optional, ...(installer ? { fix: { kind: 'install', installer: installer as never, command: '' } } : {}) })
    expect(missingInstallers([row('node', 'missing', false, 'node'), row('git', 'ok', false, 'git'), row('gitlab', 'missing', true, 'gitlab'), row('codex', 'missing', false, 'codexAdapter'), row('profile', 'missing', false)])).toEqual(['node', 'codexAdapter'])
  })
})
