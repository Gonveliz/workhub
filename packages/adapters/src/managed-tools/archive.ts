/**
 * Unpacks the archives of the tools Workhub installs (.zip and .tar.gz) with Node's own zlib: no
 * system `tar` or `unzip` (Windows may have neither) and no dependency. Every entry is checked
 * before anything is written: no absolute path, no `..`, nothing outside the target folder, no
 * link that points out of it, and nothing written through a link.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, lstat, mkdir, open, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createInflateRaw } from 'node:zlib'

/** An archive that is damaged, of a kind not handled, or that tries to write outside its folder. */
export class ArchiveError extends Error {
  constructor(
    message: string,
    readonly code: 'traversal' | 'corrupt' | 'unsupported'
  ) {
    super(message)
    this.name = 'ArchiveError'
  }
}

const inside = (root: string, target: string): boolean => {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Where an entry goes under `dest`, its first `strip` folders dropped; null for an entry that is
 * only the stripped folders. Throws for an absolute name, a `..` part or a drive letter.
 */
export function entryTarget(dest: string, name: string, strip: number): string | null {
  const normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) throw new ArchiveError(`Absolute path in the archive: ${name}`, 'traversal')
  const parts = normalized.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.includes('..')) throw new ArchiveError(`Path outside the folder in the archive: ${name}`, 'traversal')
  const kept = parts.slice(strip)
  if (kept.length === 0) return null
  const root = resolve(dest)
  const target = resolve(root, ...kept)
  if (!inside(root, target)) throw new ArchiveError(`Path outside the folder in the archive: ${name}`, 'traversal')
  return target
}

/** A link's target must stay inside `dest` (read from the link's own folder) and not be absolute. */
function checkLink(dest: string, target: string, link: string): void {
  if (isAbsolute(link) || /^[a-zA-Z]:/.test(link) || link.startsWith('/') || link.startsWith('\\')) throw new ArchiveError(`Link to an absolute path in the archive: ${link}`, 'traversal')
  const root = resolve(dest)
  const resolved = resolve(dirname(target), link)
  if (resolved !== root && !inside(root, resolved)) throw new ArchiveError(`Link outside the folder in the archive: ${link}`, 'traversal')
}

/** No folder between `dest` and the entry may be a link: writing through one could leave the folder. */
async function checkParents(dest: string, target: string): Promise<void> {
  const root = resolve(dest)
  let dir = dirname(target)
  const chain: string[] = []
  while (dir !== root && inside(root, dir)) {
    chain.push(dir)
    dir = dirname(dir)
  }
  for (const d of chain) {
    const st = await lstat(d).catch(() => null)
    if (st?.isSymbolicLink()) throw new ArchiveError(`Entry written through a link in the archive: ${target}`, 'traversal')
  }
}

async function makeLink(dest: string, target: string, link: string): Promise<void> {
  checkLink(dest, target, link)
  await checkParents(dest, target)
  await mkdir(dirname(target), { recursive: true })
  await symlink(link, target)
}

const fileMode = (mode: number): number => (mode & 0o111 ? 0o755 : 0o644)

// --- tar.gz ---------------------------------------------------------------------------------------

const BLOCK = 512

function octal(buf: Buffer, start: number, length: number): number {
  // Base-256 (GNU) for sizes over 8 GiB: the high bit of the first byte is set.
  if (buf[start]! & 0x80) {
    let n = 0
    for (let i = start + 1; i < start + length; i++) n = n * 256 + buf[i]!
    return n
  }
  const text = buf.toString('ascii', start, start + length).replace(/\0.*$/s, '').trim()
  return text ? Number.parseInt(text, 8) : 0
}

const cString = (buf: Buffer, start: number, length: number): string => {
  const end = buf.indexOf(0, start)
  return buf.toString('utf8', start, end >= 0 && end < start + length ? end : start + length)
}

function paxPaths(data: Buffer): { path?: string; linkpath?: string } {
  const out: { path?: string; linkpath?: string } = {}
  let at = 0
  while (at < data.length) {
    const space = data.indexOf(0x20, at)
    if (space < 0) break
    const length = Number.parseInt(data.toString('ascii', at, space), 10)
    if (!length || length < 0) break
    const record = data.toString('utf8', space + 1, at + length - 1)
    const eq = record.indexOf('=')
    const key = record.slice(0, eq)
    if (key === 'path') out.path = record.slice(eq + 1)
    if (key === 'linkpath') out.linkpath = record.slice(eq + 1)
    at += length
  }
  return out
}

interface TarEntry {
  kind: 'file' | 'meta' | 'skip'
  /** The file written, or for a `meta` entry its type (GNU long name or link, pax header). */
  target: string | null
  remaining: number
  padding: number
  mode: number
  handle?: Awaited<ReturnType<typeof open>>
  meta?: Buffer[]
}

/** Unpacks a .tar.gz into `dest` (streamed: a 200 MB Node.js archive never sits in memory). */
export async function extractTarGz(file: string, dest: string, strip: number, signal?: AbortSignal): Promise<void> {
  await mkdir(dest, { recursive: true })
  let pending: Buffer = Buffer.alloc(0)
  // The current entry; a header is read next when there is none.
  let entry: TarEntry | null = null
  let longName: string | undefined
  let longLink: string | undefined
  let pax: { path?: string; linkpath?: string } = {}
  let ended = false

  const finishEntry = async (): Promise<void> => {
    if (!entry) return
    if (entry.handle) await entry.handle.close()
    entry = null
  }

  const readHeader = async (header: Buffer): Promise<void> => {
    if (header.every((b) => b === 0)) {
      ended = true
      return
    }
    if (header.toString('ascii', 257, 262) !== 'ustar') throw new ArchiveError('Not a tar archive.', 'corrupt')
    const type = String.fromCharCode(header[156] || 0x30)
    const size = octal(header, 124, 12)
    const mode = octal(header, 100, 8)
    const prefix = cString(header, 345, 155)
    const baseName = cString(header, 0, 100)
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${baseName}` : baseName)
    const link = pax.linkpath ?? longLink ?? cString(header, 157, 100)
    const padding = (BLOCK - (size % BLOCK)) % BLOCK
    if (type === 'L' || type === 'K' || type === 'x' || type === 'g') {
      entry = { kind: 'meta', target: type, remaining: size, padding, mode, meta: [] }
      return
    }
    longName = undefined
    longLink = undefined
    pax = {}
    const target = entryTarget(dest, name, strip)
    if (type === '5') {
      if (target) {
        await checkParents(dest, target)
        await mkdir(target, { recursive: true })
      }
      entry = { kind: 'skip', target: null, remaining: size, padding, mode }
    } else if (type === '2') {
      if (target) await makeLink(dest, target, link)
      entry = { kind: 'skip', target: null, remaining: size, padding, mode }
    } else if (type === '1') {
      // A hard link: a copy of an entry already unpacked, both inside the folder.
      const source = entryTarget(dest, link, strip)
      if (target && source) {
        await checkParents(dest, target)
        await mkdir(dirname(target), { recursive: true })
        await copyFile(source, target)
      }
      entry = { kind: 'skip', target: null, remaining: size, padding, mode }
    } else if (type === '0' || type === '7' || header[156] === 0) {
      if (target) {
        await checkParents(dest, target)
        await mkdir(dirname(target), { recursive: true })
      }
      entry = { kind: 'file', target, remaining: size, padding, mode, ...(target ? { handle: await open(target, 'wx', fileMode(mode)) } : {}) }
    } else {
      // Devices, FIFOs and other kinds have no place in a tool's archive.
      entry = { kind: 'skip', target: null, remaining: size, padding, mode }
    }
  }

  const finishMeta = async (): Promise<void> => {
    const e = entry
    if (!e) return
    if (e.kind === 'meta') {
      const data = Buffer.concat(e.meta ?? [])
      if (e.target === 'L') longName = cString(data, 0, data.length)
      else if (e.target === 'K') longLink = cString(data, 0, data.length)
      else if (e.target === 'x') pax = paxPaths(data)
    }
    await finishEntry()
  }

  const input = createReadStream(file).pipe(createGunzip())
  try {
    for await (const chunk of input as AsyncIterable<Buffer>) {
      if (signal?.aborted) throw signal.reason ?? new Error('Canceled.')
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      while (!ended) {
        if (!entry) {
          if (pending.length < BLOCK) break
          const header = pending.subarray(0, BLOCK)
          pending = pending.subarray(BLOCK)
          await readHeader(header)
          continue
        }
        const e: TarEntry = entry
        if (e.remaining > 0) {
          if (pending.length === 0) break
          const take = Math.min(e.remaining, pending.length)
          const part = pending.subarray(0, take)
          pending = pending.subarray(take)
          e.remaining -= take
          if (e.handle) await e.handle.write(part)
          else if (e.meta) e.meta.push(Buffer.from(part))
          continue
        }
        if (pending.length < e.padding) break
        pending = pending.subarray(e.padding)
        e.padding = 0
        await finishMeta()
      }
      if (ended) break
    }
    if (!ended && entry) throw new ArchiveError('The archive ends in the middle of a file.', 'corrupt')
  } catch (err) {
    input.destroy()
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'Z_DATA_ERROR') throw new ArchiveError('The archive is damaged.', 'corrupt')
    throw err
  } finally {
    await finishEntry()
  }
}

// --- zip ------------------------------------------------------------------------------------------

/** Unpacks a .zip into `dest`, one entry at a time from the central directory. Zip64 and encryption are refused. */
export async function extractZip(file: string, dest: string, strip: number, signal?: AbortSignal): Promise<void> {
  await mkdir(dest, { recursive: true })
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const tailLength = Math.min(size, 0xffff + 22)
    const tail = Buffer.alloc(tailLength)
    await handle.read(tail, 0, tailLength, size - tailLength)
    let eocd = -1
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new ArchiveError('Not a zip archive.', 'corrupt')
    const count = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ArchiveError('Zip64 archives are not handled.', 'unsupported')
    if (cdOffset + cdSize > size) throw new ArchiveError('The archive is damaged.', 'corrupt')
    const cd = Buffer.alloc(cdSize)
    await handle.read(cd, 0, cdSize, cdOffset)
    let at = 0
    for (let n = 0; n < count; n++) {
      if (signal?.aborted) throw signal.reason ?? new Error('Canceled.')
      if (at + 46 > cd.length || cd.readUInt32LE(at) !== 0x02014b50) throw new ArchiveError('The archive is damaged.', 'corrupt')
      const madeBy = cd.readUInt16LE(at + 4)
      const flags = cd.readUInt16LE(at + 8)
      const method = cd.readUInt16LE(at + 10)
      const compressed = cd.readUInt32LE(at + 20)
      const nameLength = cd.readUInt16LE(at + 28)
      const extraLength = cd.readUInt16LE(at + 30)
      const commentLength = cd.readUInt16LE(at + 32)
      const external = cd.readUInt32LE(at + 38)
      const local = cd.readUInt32LE(at + 42)
      const name = cd.toString('utf8', at + 46, at + 46 + nameLength)
      at += 46 + nameLength + extraLength + commentLength
      if (flags & 1) throw new ArchiveError('Encrypted archives are not handled.', 'unsupported')
      const target = entryTarget(dest, name, strip)
      // Unix permissions in the high bits when the archive was made on Unix (the GitHub CLI for macOS).
      const unixMode = madeBy >> 8 === 3 ? external >>> 16 : 0
      const isDir = name.endsWith('/') || name.endsWith('\\') || (unixMode & 0o170000) === 0o040000
      if (!target) continue
      if (isDir) {
        await checkParents(dest, target)
        await mkdir(target, { recursive: true })
        continue
      }
      const header = Buffer.alloc(30)
      await handle.read(header, 0, 30, local)
      if (header.readUInt32LE(0) !== 0x04034b50) throw new ArchiveError('The archive is damaged.', 'corrupt')
      const start = local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
      if (method !== 0 && method !== 8) throw new ArchiveError(`Compression method ${method} is not handled.`, 'unsupported')
      if (start + compressed > size) throw new ArchiveError('The archive is damaged.', 'corrupt')
      await checkParents(dest, target)
      await mkdir(dirname(target), { recursive: true })
      if ((unixMode & 0o170000) === 0o120000) {
        const link = Buffer.alloc(compressed)
        await handle.read(link, 0, compressed, start)
        if (method !== 0) throw new ArchiveError('A compressed link is not handled.', 'unsupported')
        await makeLink(dest, target, link.toString('utf8'))
        continue
      }
      const out = createWriteStream(target, { flags: 'wx', mode: unixMode ? fileMode(unixMode) : 0o644 })
      if (compressed === 0) {
        await new Promise<void>((done, fail) => out.end((err?: Error | null) => (err ? fail(err) : done())))
        continue
      }
      const raw = createReadStream(file, { start, end: start + compressed - 1 })
      try {
        await (method === 8 ? pipeline(raw, createInflateRaw(), out, { signal }) : pipeline(raw, out, { signal }))
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code?.startsWith('Z_')) throw new ArchiveError('The archive is damaged.', 'corrupt')
        throw err
      }
    }
  } finally {
    await handle.close()
  }
}

export async function extractArchive(format: 'zip' | 'tar.gz', file: string, dest: string, strip: number, signal?: AbortSignal): Promise<void> {
  return format === 'zip' ? extractZip(file, dest, strip, signal) : extractTarGz(file, dest, strip, signal)
}

