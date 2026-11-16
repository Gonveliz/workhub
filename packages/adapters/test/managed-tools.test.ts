import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { managedDownload, npmPrefixOf, privateNode } from '@workhub/core'
import { ArchiveError, classifyFailure, entryTarget, extractTarGz, extractZip, HttpError, ManagedToolsInstaller, type Fetcher, type ProgramRunner } from '../src/managed-tools'

// --- tiny archive builders -------------------------------------------------------------------------

type TarEntry = { name: string; body?: string; type?: '0' | '5' | '2'; link?: string; mode?: number }

function tarHeader(e: TarEntry, size: number): Buffer {
  const h = Buffer.alloc(512)
  h.write(e.name, 0, 100, 'utf8')
  h.write(`${(e.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100, 'ascii')
  h.write('0000000\0', 108, 'ascii')
  h.write('0000000\0', 116, 'ascii')
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  h.write('00000000000\0', 136, 'ascii')
  h.write('        ', 148, 'ascii')
  h.write(e.type ?? '0', 156, 'ascii')
  if (e.link) h.write(e.link, 157, 100, 'utf8')
  h.write('ustar\0', 257, 'ascii')
  h.write('00', 263, 'ascii')
  let sum = 0
  for (const b of h) sum += b
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return h
}

function tarGz(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = []
  for (const e of entries) {
    const body = Buffer.from(e.body ?? '')
    parts.push(tarHeader(e, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

/** A zip with stored (uncompressed) entries. */
function zip(entries: { name: string; body: string }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const body = Buffer.from(e.body)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(body.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wh-managed-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const write = (name: string, data: Buffer) => {
  const file = join(dir, name)
  writeFileSync(file, data)
  return file
}

describe('archives', () => {
  it('unpacks a tar.gz without its top folder, keeping the executable bit', async () => {
    const file = write('a.tar.gz', tarGz([{ name: 'top/', type: '5' }, { name: 'top/bin/tool', body: 'hi', mode: 0o755 }, { name: 'top/README', body: 'r' }]))
    await extractTarGz(file, join(dir, 'out'), 1)
    expect(readFileSync(join(dir, 'out', 'bin', 'tool'), 'utf8')).toBe('hi')
    if (process.platform !== 'win32') expect(statSync(join(dir, 'out', 'bin', 'tool')).mode & 0o111).not.toBe(0)
  })

  it('refuses a tar entry that climbs out of the folder, and writes nothing outside', async () => {
    const file = write('evil.tar.gz', tarGz([{ name: 'top/../../escaped', body: 'x' }]))
    await expect(extractTarGz(file, join(dir, 'out'), 1)).rejects.toBeInstanceOf(ArchiveError)
    expect(existsSync(join(dir, 'escaped'))).toBe(false)
    await expect(extractTarGz(write('abs.tar.gz', tarGz([{ name: '/etc/evil', body: 'x' }])), join(dir, 'out2'), 0)).rejects.toMatchObject({ code: 'traversal' })
  })

  it('refuses a link out of the folder and a file written through a link', async () => {
    if (process.platform === 'win32') return
    await expect(extractTarGz(write('l.tar.gz', tarGz([{ name: 'top/up', type: '2', link: '../../..' }])), join(dir, 'o1'), 1)).rejects.toMatchObject({ code: 'traversal' })
    const through = tarGz([{ name: 'top/inner', type: '5' }, { name: 'top/here', type: '2', link: 'inner' }, { name: 'top/here/file', body: 'x' }])
    await expect(extractTarGz(write('t.tar.gz', through), join(dir, 'o2'), 1)).rejects.toMatchObject({ code: 'traversal' })
  })

  it('unpacks a zip, and refuses one with a path out of the folder', async () => {
    await extractZip(write('a.zip', zip([{ name: 'bin/gh.exe', body: 'MZ' }, { name: 'LICENSE', body: 'l' }])), join(dir, 'z'), 0)
    expect(readFileSync(join(dir, 'z', 'bin', 'gh.exe'), 'utf8')).toBe('MZ')
    await expect(extractZip(write('b.zip', zip([{ name: '..\\..\\evil.exe', body: 'x' }])), join(dir, 'z2'), 0)).rejects.toMatchObject({ code: 'traversal' })
    await expect(extractZip(write('c.zip', zip([{ name: 'C:/Windows/evil.exe', body: 'x' }])), join(dir, 'z3'), 0)).rejects.toMatchObject({ code: 'traversal' })
    expect(existsSync(join(dir, 'evil.exe'))).toBe(false)
  })

  it('entryTarget drops the stripped folders and refuses `..`', () => {
    expect(entryTarget('/x', 'top/', 1)).toBeNull()
    expect(entryTarget('/x', 'top/a/b', 1)).toBe(resolve('/x', 'a', 'b'))
    expect(() => entryTarget('/x', 'top/a/../../b', 1)).toThrow(ArchiveError)
  })
})

// --- the installer, with fake downloads ------------------------------------------------------------

/** Serves fixed bodies by address; anything else is a 404. Records what was asked for. */
function fakeFetch(bodies: Record<string, Buffer | string | (() => Response)>): Fetcher & { asked: string[] } {
  const asked: string[] = []
  const f: Fetcher = async (url) => {
    asked.push(url)
    const body = bodies[url]
    if (typeof body === 'function') return body()
    if (body === undefined) return new Response('no', { status: 404 })
    return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status: 200 })
  }
  return Object.assign(f, { asked })
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

describe('ManagedToolsInstaller', () => {
  const download = managedDownload('node', 'linux', 'x64')!
  const name = download.url.split('/').pop()!
  const archive = () => tarGz([{ name: 'node-v/bin/node', body: '#!node', mode: 0o755 }, { name: 'node-v/lib/node_modules/npm/bin/npm-cli.js', body: '' }])

  it('downloads, verifies against the published list and moves the folder into place', async () => {
    const body = archive()
    const fetch = fakeFetch({ [download.url]: body, [(download.checksum as { list: string }).list]: `${'0'.repeat(64)}  other.tar.gz\n${sha(body)}  ${name}\n` })
    const tools = join(dir, 'tools')
    const phases: string[] = []
    const installer = new ManagedToolsInstaller({ toolsDir: tools, platform: 'linux', arch: 'x64', fetch })
    expect(await installer.install('node', { onProgress: (p) => phases.push(p.phase) })).toEqual({ ok: true })
    expect(fetch.asked.every((u) => u.startsWith('https://'))).toBe(true)
    expect([...new Set(phases)]).toEqual(['downloading', 'verifying', 'unpacking'])
    expect(readFileSync(privateNode(tools, 'linux').node, 'utf8')).toBe('#!node')
    expect(installer.hasNode()).toBe(true)
    expect(readdirSync(join(tools, '.partial'))).toEqual([])
    expect(await installer.installed()).toEqual([{ id: 'node', version: '26.13.1', bytes: expect.any(Number) }])
  })

  it('a checksum mismatch throws the download away and leaves the old install as it was', async () => {
    const tools = join(dir, 'tools')
    mkdirSync(join(tools, 'node', 'bin'), { recursive: true })
    writeFileSync(join(tools, 'node', 'bin', 'node'), 'old')
    const fetch = fakeFetch({ [download.url]: archive(), [(download.checksum as { list: string }).list]: `${'f'.repeat(64)}  ${name}\n` })
    const result = await new ManagedToolsInstaller({ toolsDir: tools, platform: 'linux', arch: 'x64', fetch }).install('node')
    expect(result).toMatchObject({ ok: false, reason: 'checksum' })
    expect(readFileSync(join(tools, 'node', 'bin', 'node'), 'utf8')).toBe('old')
    expect(readdirSync(join(tools, '.partial'))).toEqual([])
  })

  it('a file missing from the published list is a checksum failure too', async () => {
    const fetch = fakeFetch({ [download.url]: archive(), [(download.checksum as { list: string }).list]: '' })
    expect(await new ManagedToolsInstaller({ toolsDir: join(dir, 't'), platform: 'linux', arch: 'x64', fetch }).install('node')).toMatchObject({ ok: false, reason: 'checksum' })
  })

  it('a pinned checksum (Git for Windows) is checked without a list', async () => {
    const git = managedDownload('git', 'win32', 'x64')!
    const fetch = fakeFetch({ [git.url]: zip([{ name: 'cmd/git.exe', body: 'MZ' }]) })
    const result = await new ManagedToolsInstaller({ toolsDir: join(dir, 't'), platform: 'win32', arch: 'x64', fetch }).install('git')
    expect(result).toMatchObject({ ok: false, reason: 'checksum' })
    expect(fetch.asked).toEqual([git.url])
  })

  it('names the reason: proxy, server, network, no archive for this system', async () => {
    const make = (fetch: Fetcher, arch = 'x64') => new ManagedToolsInstaller({ toolsDir: join(dir, 't'), platform: 'linux', arch, fetch })
    expect(await make(fakeFetch({ [download.url]: () => new Response('', { status: 407 }) })).install('node')).toMatchObject({ reason: 'proxy' })
    expect(await make(fakeFetch({})).install('node')).toMatchObject({ reason: 'http', detail: '404' })
    const offline: Fetcher = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND nodejs.org'), { code: 'ENOTFOUND' }) })
    }
    expect(await make(offline).install('node')).toMatchObject({ reason: 'offline' })
    expect(await make(fakeFetch({}), 'ia32').install('node')).toMatchObject({ reason: 'unsupported' })
    expect(existsSync(join(dir, 't', 'node'))).toBe(false)
  })

  it('refuses a redirect to plain HTTP', async () => {
    const redirected: Fetcher = async () => Object.defineProperty(new Response('x'), 'url', { value: 'http://nodejs.org/x' })
    expect(await new ManagedToolsInstaller({ toolsDir: join(dir, 't'), platform: 'linux', arch: 'x64', fetch: redirected }).install('node')).toMatchObject({ ok: false, reason: 'failed', detail: expect.stringContaining('not HTTPS') })
  })

  it('cancel stops the download and leaves nothing', async () => {
    const controller = new AbortController()
    const slow: Fetcher = async (_url, init) =>
      new Response(
        new ReadableStream({
          pull(c) {
            if (init.signal?.aborted) return c.error(init.signal.reason)
            c.enqueue(new Uint8Array(1024))
            controller.abort()
          }
        })
      )
    const result = await new ManagedToolsInstaller({ toolsDir: join(dir, 't'), platform: 'linux', arch: 'x64', fetch: slow }).install('node', { signal: controller.signal })
    expect(result).toMatchObject({ ok: false, reason: 'canceled' })
    expect(existsSync(join(dir, 't', 'node'))).toBe(false)
    expect(readdirSync(join(dir, 't', '.partial'))).toEqual([])
  })

  it('installs an npm agent with its own Node.js, allowing scripts for that package only', async () => {
    const tools = join(dir, 'tools')
    const { node, npmCli } = privateNode(tools, 'linux')
    mkdirSync(join(tools, 'node', 'bin'), { recursive: true })
    writeFileSync(node, '')
    const calls: { file: string; args: string[]; path: string | undefined }[] = []
    const run: ProgramRunner = async (file, args, { env }) => {
      calls.push({ file, args, path: env['PATH'] })
      if (args[1] === '--version') return { ok: true, output: '12.2.2' }
      mkdirSync(join(tools, 'npm', 'lib', 'node_modules', 'opencode-ai'), { recursive: true })
      writeFileSync(join(tools, 'npm', 'lib', 'node_modules', 'opencode-ai', 'package.json'), '{"version":"1.2.3"}')
      return { ok: true, output: '' }
    }
    const installer = new ManagedToolsInstaller({ toolsDir: tools, platform: 'linux', arch: 'x64', fetch: fakeFetch({}), run, env: () => ({ PATH: '/usr/bin' }) })
    expect(await installer.install('opencode')).toEqual({ ok: true })
    const install = calls[1]!
    expect(install.file).toBe(node)
    expect(install.args[0]).toBe(npmCli)
    expect(install.args).toContain('--allow-scripts=opencode-ai')
    // Paths are built for the target platform, not the host: compare with the same helpers.
    expect(install.args).toContain(`--prefix=${npmPrefixOf(tools, 'linux')}`)
    expect(install.path?.startsWith(`${node.slice(0, node.lastIndexOf('/'))}:`)).toBe(true)
    expect(await installer.installed()).toEqual([{ id: 'opencode', version: '1.2.3', bytes: expect.any(Number) }])
  })

  it('an npm agent without Node.js, or a failing npm, ends with a plain reason', async () => {
    const tools = join(dir, 'tools')
    const none = new ManagedToolsInstaller({ toolsDir: tools, platform: 'linux', arch: 'x64', fetch: fakeFetch({}) })
    expect(await none.install('gemini')).toMatchObject({ ok: false, reason: 'needsNode' })
    mkdirSync(join(tools, 'node', 'bin'), { recursive: true })
    writeFileSync(privateNode(tools, 'linux').node, '')
    const run: ProgramRunner = async (_f, args) => (args[1] === '--version' ? { ok: true, output: '10.9.4' } : { ok: false, output: 'npm error code ENOSPC' })
    expect(await new ManagedToolsInstaller({ toolsDir: tools, platform: 'linux', arch: 'x64', fetch: fakeFetch({}), run }).install('gemini')).toMatchObject({ ok: false, reason: 'diskFull' })
  })

  it('removing a scoped npm tool leaves no empty scope folder', async () => {
    const tools = join(dir, 'tools')
    const scope = join(tools, 'npm', 'lib', 'node_modules', '@openai')
    mkdirSync(join(scope, 'codex'), { recursive: true })
    writeFileSync(join(scope, 'codex', 'package.json'), '{"version":"1.0.0"}')
    expect(await new ManagedToolsInstaller({ toolsDir: tools, platform: 'linux', arch: 'x64', fetch: fakeFetch({}) }).remove('codex')).toEqual({ ok: true })
    expect(existsSync(scope)).toBe(false)
    // Another package of the same scope keeps the folder.
    mkdirSync(join(scope, 'codex'), { recursive: true })
    mkdirSync(join(scope, 'other'), { recursive: true })
    expect(await new ManagedToolsInstaller({ toolsDir: tools, platform: 'linux', arch: 'x64', fetch: fakeFetch({}) }).remove('codex')).toEqual({ ok: true })
    expect(existsSync(join(scope, 'other'))).toBe(true)
  })

  it('removing Node.js takes the npm agents along', async () => {
    const tools = join(dir, 'tools')
    mkdirSync(join(tools, 'node', 'bin'), { recursive: true })
    mkdirSync(join(tools, 'npm', 'lib'), { recursive: true })
    expect(await new ManagedToolsInstaller({ toolsDir: tools, platform: 'linux', arch: 'x64', fetch: fakeFetch({}) }).remove('node')).toEqual({ ok: true })
    expect(existsSync(join(tools, 'node'))).toBe(false)
    expect(existsSync(join(tools, 'npm'))).toBe(false)
  })
})

describe('classifyFailure', () => {
  it('reads Electron, Node and file system errors', () => {
    expect(classifyFailure(new Error('net::ERR_INTERNET_DISCONNECTED')).reason).toBe('offline')
    expect(classifyFailure(new Error('net::ERR_PROXY_CONNECTION_FAILED')).reason).toBe('proxy')
    expect(classifyFailure(Object.assign(new Error('no space'), { code: 'ENOSPC' })).reason).toBe('diskFull')
    expect(classifyFailure(Object.assign(new Error('operation not permitted, rename'), { code: 'EPERM' })).reason).toBe('locked')
    expect(classifyFailure(new HttpError(503))).toEqual({ reason: 'http', detail: '503' })
  })
})
