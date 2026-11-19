import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteFlowMaps } from '@workhub/adapters/sqlite-store'
import { deleteFlowMap, exportFlowMaps, FLOW_MAP_BUNDLE, importFlowMapFiles, saveFlowMap } from '../src/main/flow-maps'
import { openTestDb } from './test-db'
import { flowMapWindowHash, registerFlowMapsIpc, type FlowMapsIpcDeps } from '../src/main/flow-maps-ipc'
import { parseFlowMapHash } from '../src/renderer/screens/flowMaps/FlowMapWindow'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wh-flow-maps-ipc-'))
  dirs.push(d)
  return d
}
const checkout = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'docs', 'examples', 'flow-maps', 'checkout.json'), 'utf8')) as Record<string, unknown>

describe('flow maps from Settings', () => {
  it('imports the valid files picked and reports the rest with their errors', () => {
    const maps = new SqliteFlowMaps(openTestDb())
    const src = tmp()
    writeFileSync(join(src, 'good.json'), JSON.stringify(checkout))
    writeFileSync(join(src, 'broken.json'), '{ nope')
    writeFileSync(join(src, 'refs.json'), JSON.stringify({ ...checkout, id: 'refs', edges: [{ from: 'bff', to: 'nowhere' }] }))
    const results = importFlowMapFiles(maps, [join(src, 'good.json'), join(src, 'broken.json'), join(src, 'refs.json')])
    expect(results[0]).toEqual({ file: join(src, 'good.json'), ok: true, id: 'checkout' })
    expect(results[1]).toMatchObject({ ok: false, errors: [expect.stringContaining('JSON')] })
    expect(results[2]).toMatchObject({ ok: false, errors: [expect.stringContaining('nowhere')] })
    expect(maps.get('checkout')).not.toBeNull()
    expect(maps.get('refs')).toBeNull()
  })

  it('deletes a map by id and refuses anything that is not an id', () => {
    const maps = new SqliteFlowMaps(openTestDb())
    saveFlowMap(maps, checkout)
    expect(deleteFlowMap(maps, '../checkout')).toBe(false)
    expect(deleteFlowMap(maps, 'checkout/..')).toBe(false)
    expect(deleteFlowMap(maps, 'missing')).toBe(false)
    expect(deleteFlowMap(maps, 'checkout')).toBe(true)
    expect(maps.get('checkout')).toBeNull()
  })

  it('deletes an invalid map whose stored id is not a map id (kept from an old file name)', () => {
    const maps = new SqliteFlowMaps(openTestDb())
    maps.put('Checkout Flow', '{"version":1}')
    expect(deleteFlowMap(maps, 'Checkout Flow')).toBe(true)
    expect(maps.list()).toEqual([])
    expect(deleteFlowMap(maps, 'a/b')).toBe(false)
  })
})

describe('flow map window hash', () => {
  it('round-trips the profile, environment and map, and rejects other hashes', () => {
    const hash = flowMapWindowHash('acme', 'prod', 'checkout')
    expect(parseFlowMapHash(hash)).toEqual({ profileId: 'acme', environmentId: 'prod', mapId: 'checkout' })
    expect(parseFlowMapHash(flowMapWindowHash(null, 'prod', 'a b'))).toEqual({ profileId: null, environmentId: 'prod', mapId: 'a b' })
    expect(parseFlowMapHash('#flow-map?env=prod')).toBeNull()
    expect(parseFlowMapHash('#file?path=x')).toBeNull()
  })
})

describe('flow maps IPC', () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  type Listener = (event: IpcMainEvent, ...args: unknown[]) => void
  const setup = (over: Partial<FlowMapsIpcDeps> = {}) => {
    const handlers = new Map<string, Handler>()
    const listeners = new Map<string, Listener>()
    const win = { isDestroyed: () => false, isMinimized: () => false, restore: vi.fn(), focus: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } }
    const deps: FlowMapsIpcDeps = {
      maps: new SqliteFlowMaps(openTestDb()),
      pickFiles: async () => [],
      saveFile: async () => null,
      createWindow: vi.fn(() => win as never),
      mainWindow: () => win as never,
      writeImage: vi.fn(async () => true),
      ...over
    }
    registerFlowMapsIpc({ handle: (c, h) => handlers.set(c, h as Handler), on: (c, l) => listeners.set(c, l as Listener) }, deps)
    const event = {} as IpcMainInvokeEvent
    return { deps, win, invoke: (c: string, ...a: unknown[]) => handlers.get(c)!(event, ...a), send: (c: string, ...a: unknown[]) => listeners.get(c)!(event as never, ...a) }
  }

  it('serves a stored map by id and no longer offers a maps folder', async () => {
    const { deps, invoke } = setup()
    saveFlowMap(deps.maps, checkout)
    expect(await invoke('flowMaps:get', 'checkout')).toMatchObject({ id: 'checkout', name: 'Checkout' })
    expect(await invoke('flowMaps:get', 'missing')).toBeNull()
    expect(await invoke('flowMaps:remove', 'checkout')).toBe(true)
    expect(await invoke('flowMaps:get', 'checkout')).toBeNull()
  })

  it('opens one window per map and brings an open one to the front', () => {
    const { deps, win, send } = setup()
    send('flowMaps:openWindow', 'acme', 'prod', 'checkout')
    send('flowMaps:openWindow', 'acme', 'prod', 'checkout')
    expect(deps.createWindow).toHaveBeenCalledTimes(1)
    expect(deps.createWindow).toHaveBeenCalledWith('#flow-map?profile=acme&env=prod&id=checkout', 'Flow map')
    expect(win.focus).toHaveBeenCalledTimes(1)
    send('flowMaps:openWindow', 'acme', 42, 'checkout')
    expect(deps.createWindow).toHaveBeenCalledTimes(1)
  })

  it('copies only a PNG data URL, and forwards "Ask Claude" to the main window with its draft', async () => {
    const { deps, win, invoke, send } = setup()
    expect(await invoke('flowMaps:copyImage', 'data:image/png;base64,AAAA')).toBe(true)
    expect(await invoke('flowMaps:copyImage', 'data:text/html;base64,AAAA')).toBe(false)
    expect(deps.writeImage).toHaveBeenCalledTimes(1)
    send('flowMaps:ask', 'Look at this flow', '/w/acme/shop')
    expect(win.webContents.send).toHaveBeenCalledWith('flowMaps:askInMain', 'Look at this flow', '/w/acme/shop')
    send('flowMaps:ask', '   ')
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
  })
})

describe('flow map export and import of several maps', () => {
  const other = { ...checkout, id: 'refunds', name: 'Refunds' }

  it('exports one map as it is stored, and several as one file with all of them', () => {
    const maps = new SqliteFlowMaps(openTestDb())
    saveFlowMap(maps, checkout)
    saveFlowMap(maps, other)
    const one = exportFlowMaps(maps, ['checkout'])!
    expect(one).toMatchObject({ count: 1, name: 'checkout.json' })
    expect(JSON.parse(one.text)).toMatchObject({ id: 'checkout', name: 'Checkout' })
    const all = exportFlowMaps(maps)!
    expect(all).toMatchObject({ count: 2, name: 'flow-maps.json' })
    const parsed = JSON.parse(all.text)
    expect(parsed).toMatchObject({ format: FLOW_MAP_BUNDLE, version: 1 })
    expect(parsed.maps.map((m: { id: string }) => m.id).sort()).toEqual(['checkout', 'refunds'])
    expect(exportFlowMaps(maps, ['missing'])).toBeNull()
    expect(exportFlowMaps(new SqliteFlowMaps(openTestDb()))).toBeNull()
  })

  it('imports an export back, one result per map, and says which ones replaced a map', () => {
    const from = new SqliteFlowMaps(openTestDb())
    saveFlowMap(from, checkout)
    saveFlowMap(from, other)
    const dir = tmp()
    const file = join(dir, 'flow-maps.json')
    writeFileSync(file, exportFlowMaps(from)!.text)
    const to = new SqliteFlowMaps(openTestDb())
    saveFlowMap(to, checkout)
    const results = importFlowMapFiles(to, [file])
    expect(results.map((r) => [r.name, r.ok, r.ok && r.replaced === true])).toEqual(expect.arrayContaining([['Checkout', true, true], ['Refunds', true, false]]))
    expect(to.list().map((m) => m.id).sort()).toEqual(['checkout', 'refunds'])
  })

  it('reports a bad map of an export and still imports the others, and refuses an empty export', () => {
    const dir = tmp()
    const file = join(dir, 'mixed.json')
    writeFileSync(file, JSON.stringify({ format: FLOW_MAP_BUNDLE, version: 1, maps: [checkout, { id: 'broken', name: 'Broken' }] }))
    const maps = new SqliteFlowMaps(openTestDb())
    const results = importFlowMapFiles(maps, [file])
    expect(results.map((r) => [r.name, r.ok])).toEqual([['Checkout', true], ['Broken', false]])
    const empty = join(dir, 'empty.json')
    writeFileSync(empty, JSON.stringify({ format: FLOW_MAP_BUNDLE, version: 1, maps: [] }))
    expect(importFlowMapFiles(maps, [empty])).toEqual([{ file: empty, ok: false, errors: ['The file has no maps'] }])
  })

  it('saves the export where the user picks, and says when there was nothing or it was cancelled', async () => {
    const maps = new SqliteFlowMaps(openTestDb())
    const saved: [string, string][] = []
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    const deps = { maps, pickFiles: async () => [], saveFile: async (name: string, text: string) => (saved.push([name, text]), `/picked/${name}`), createWindow: vi.fn(), mainWindow: () => null, writeImage: vi.fn() } as unknown as FlowMapsIpcDeps
    registerFlowMapsIpc({ handle: (c, h) => handlers.set(c, h as never), on: () => {} }, deps)
    expect(await handlers.get('flowMaps:export')!({}, undefined)).toEqual({ ok: false, reason: 'empty' })
    saveFlowMap(maps, checkout)
    expect(await handlers.get('flowMaps:export')!({}, ['checkout'])).toEqual({ ok: true, file: '/picked/checkout.json', count: 1 })
    expect(saved[0]![0]).toBe('checkout.json')
    deps.saveFile = async () => null
    expect(await handlers.get('flowMaps:export')!({}, ['checkout'])).toEqual({ ok: false, reason: 'canceled' })
  })
})

describe('flow maps dropped in the window', () => {
  it('imports several dropped files at once, one result per map, and refuses what is not a map or too big', async () => {
    const maps = new SqliteFlowMaps(openTestDb())
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    registerFlowMapsIpc({ handle: (c, h) => handlers.set(c, h as never), on: () => {} }, { maps, pickFiles: async () => [], saveFile: async () => null, createWindow: vi.fn(), mainWindow: () => null, writeImage: vi.fn() } as unknown as FlowMapsIpcDeps)
    const drop = (items: unknown) => handlers.get('flowMaps:importTexts')!({}, items) as { file: string; ok: boolean }[]
    const results = drop([
      { name: 'checkout.json', text: JSON.stringify(checkout) },
      { name: 'refunds.json', text: JSON.stringify({ ...checkout, id: 'refunds', name: 'Refunds' }) },
      { name: 'notes.json', text: 'not json' },
      { name: 'big.json', text: ' '.repeat(5_000_001) },
      { name: 3, text: 'x' }
    ])
    expect(results.map((r) => [r.file, r.ok])).toEqual([['checkout.json', true], ['refunds.json', true], ['notes.json', false], ['big.json', false]])
    expect(maps.list().map((m) => m.id).sort()).toEqual(['checkout', 'refunds'])
    expect(drop('nope')).toEqual([])
  })
})
