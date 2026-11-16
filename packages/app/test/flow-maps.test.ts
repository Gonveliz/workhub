import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { controlSocketPath, startControlServer } from '../src/main/control-server'
import { SqliteFlowMaps } from '@workhub/adapters/sqlite-store'
import { flowMapSummaries, readFlowMapFiles, saveFlowMap } from '../src/main/flow-maps'
import { openTestDb } from './test-db'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wh-flow-maps-'))
  dirs.push(d)
  return d
}

const checkout = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'docs', 'examples', 'flow-maps', 'checkout.json'), 'utf8')) as Record<string, unknown>

describe('stored flow maps', () => {
  it('lists every stored map, the bad ones with their error', () => {
    const maps = new SqliteFlowMaps(openTestDb())
    expect(readFlowMapFiles(maps)).toEqual([])
    maps.put('checkout', JSON.stringify(checkout))
    maps.put('broken', '{ not json')
    maps.put('refs', JSON.stringify({ ...checkout, id: 'refs', edges: [{ from: 'bff', to: 'nowhere' }] }))
    const files = readFlowMapFiles(maps)
    expect(files.map((f) => [f.file, Boolean(f.map)])).toEqual([['broken.json', false], ['checkout.json', true], ['refs.json', false]])
    const summaries = flowMapSummaries(files)
    expect(summaries[1]).toMatchObject({ id: 'checkout', name: 'Checkout', nodes: 6, edges: 6 })
    expect(summaries[0]).toMatchObject({ id: 'broken', error: expect.stringContaining('JSON') })
    expect(summaries[2]?.error).toContain('unknown node "nowhere"')
  })

  it('reads nothing when the store fails', () => {
    const failing = { list: () => { throw new Error('closed') }, get: () => null, put: () => {}, remove: () => false }
    expect(readFlowMapFiles(failing)).toEqual([])
  })

  it('saves a valid map under its id and refuses an invalid one with the field errors', () => {
    const maps = new SqliteFlowMaps(openTestDb())
    const saved = saveFlowMap(maps, checkout)
    expect(saved).toMatchObject({ ok: true, id: 'checkout', file: 'checkout.json' })
    expect(readFlowMapFiles(maps)[0]?.map?.name).toBe('Checkout')
    const bad = saveFlowMap(maps, { ...checkout, lanes: [] })
    expect(bad).toMatchObject({ ok: false, errors: [expect.stringContaining('lanes')] })
    expect(maps.list()).toHaveLength(1)
  })

  it('takes a map over the control endpoint', async () => {
    const dir = tmp()
    const maps = new SqliteFlowMaps(openTestDb())
    // A socket file in a temp folder, or a named pipe on Windows.
    const socket = controlSocketPath(dir)
    const stored: unknown[] = []
    const server = await startControlServer(socket, {
      auth: { sessionOf: (t) => (t === 't-s1' ? 's1' : undefined), readOnly: () => false },
      openReview: () => ({ ok: true }),
      saveFlowMap: (map) => {
        stored.push(map)
        return saveFlowMap(maps, map)
      }
    })
    expect(server).not.toBeNull()
    const call = (body: unknown) =>
      new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
        const req = request({ socketPath: socket, method: 'POST', path: '/v1/flow-maps', headers: { 'content-type': 'application/json', 'x-workhub-token': 't-s1' } }, (res) => {
          let text = ''
          res.on('data', (c) => (text += c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }))
        })
        req.on('error', reject)
        req.end(JSON.stringify(body))
      })
    try {
      const ok = await call(checkout)
      expect(ok.status).toBe(200)
      expect(ok.json).toMatchObject({ ok: true, id: 'checkout' })
      expect(readFlowMapFiles(maps)).toHaveLength(1)
      const bad = await call({ version: 1 })
      expect(bad.status).toBe(400)
      expect(bad.json.errors).toEqual(expect.arrayContaining([expect.stringContaining('id')]))
    } finally {
      await new Promise((r) => server!.close(r))
    }
  })
})
