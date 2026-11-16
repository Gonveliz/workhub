import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_VERSION } from '@workhub/core'
import { JsonConfigStore } from '../src/config-json'

let dir: string
let path: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workhub-config-copy-'))
  path = join(dir, 'config.json')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const old = (version: number, name = 'Acme'): string => JSON.stringify({ version, profiles: [{ id: 'acme', name }] })
const copies = async (): Promise<string[]> => (await readdir(dir)).filter((n) => n.endsWith('.bak')).sort()

describe('config copy before the first save after a migration', () => {
  it('copies a migrated file once, owner-only, with the original bytes', async () => {
    const original = old(3)
    await writeFile(path, original)
    const store = new JsonConfigStore(path)
    const config = await store.load()
    expect(await copies()).toEqual([])
    await store.save(config)
    await store.save({ ...config, activeProfileId: 'acme' })
    expect(await copies()).toEqual(['config.json.v3.bak'])
    const copy = join(dir, 'config.json.v3.bak')
    expect(await readFile(copy, 'utf8')).toBe(original)
    if (process.platform !== 'win32') expect((await stat(copy)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(CONFIG_VERSION)
  })

  it('copies an unversioned file as version 0', async () => {
    await writeFile(path, JSON.stringify({ profiles: [{ id: 'acme', name: 'Acme' }] }))
    const store = new JsonConfigStore(path)
    await store.save(await store.load())
    expect(await copies()).toEqual(['config.json.v0.bak'])
  })

  it('copies nothing for a file at the current version or a missing file', async () => {
    const store = new JsonConfigStore(path)
    await store.save(await store.load())
    await store.save(await store.load())
    expect(await copies()).toEqual([])
  })

  it('copies nothing after a failed load', async () => {
    await writeFile(path, old(3))
    const store = new JsonConfigStore(path)
    const config = await store.load()
    await writeFile(path, '{ not json')
    await expect(store.load()).rejects.toThrow()
    await store.save(config)
    expect(await copies()).toEqual([])
  })

  it('never overwrites an existing copy of the same version', async () => {
    await writeFile(join(dir, 'config.json.v3.bak'), 'first original')
    await writeFile(path, old(3, 'Changed'))
    const store = new JsonConfigStore(path)
    await store.save(await store.load())
    expect(await readFile(join(dir, 'config.json.v3.bak'), 'utf8')).toBe('first original')
  })

  it('keeps only the 3 newest copies', async () => {
    const now = Date.now() / 1000
    for (const [i, v] of [0, 1, 2].entries()) {
      const file = join(dir, `config.json.v${v}.bak`)
      await writeFile(file, old(v))
      await utimes(file, now - 1000 + i, now - 1000 + i)
    }
    await writeFile(path, old(5))
    const store = new JsonConfigStore(path)
    await store.save(await store.load())
    expect(await copies()).toEqual(['config.json.v1.bak', 'config.json.v2.bak', 'config.json.v5.bak'])
  })
})
