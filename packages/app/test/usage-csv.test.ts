import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/docs' }, dialog: {} }))

import { csvNumber, csvField, createUsageCsvExporter, parseUsageCsvExport, usageCsv, usageCsvName } from '../src/main/usage-csv'
import { csvTable } from '../src/renderer/lib/usageReports'
import type { SpendTotals, UsageCsvExport } from '../src/shared/analytics-api'

const HEADERS = ['Group', 'Input', 'Output', 'Cache', 'Cost (USD)', 'Sessions', 'Agent time (seconds)']
const since = new Date(2026, 9, 1).getTime()
const until = new Date(2026, 9, 28).getTime()
const table = (rows: UsageCsvExport['rows'], over: Partial<UsageCsvExport> = {}): UsageCsvExport => ({ groupBy: 'project', since, until, headers: HEADERS, rows, ...over })
const row = (group: string, over: Partial<UsageCsvExport['rows'][number]> = {}) => ({ group, tokensIn: 1200, tokensOut: 300, cache: 45_000, usd: 1.5, sessions: 3, activeSeconds: 125, ...over })

describe('usage CSV text', () => {
  it('starts with a byte-order mark, ends records with CRLF and lists the columns in the order shown', () => {
    const text = usageCsv(table([row('acme/shop')]))
    expect(text.startsWith('﻿')).toBe(true)
    expect(text.slice(1)).toBe('Group,Input,Output,Cache,Cost (USD),Sessions,Agent time (seconds)\r\nacme/shop,1200,300,45000,1.5,3,125\r\n')
  })

  it('quotes a field with a comma, a quote or a line break, doubling quotes (RFC 4180)', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('two\nlines')).toBe('"two\nlines"')
    expect(csvField('cr\rhere')).toBe('"cr\rhere"')
    expect(csvField('')).toBe('')
    const text = usageCsv(table([row('Shop, "main"\nbranch')]))
    expect(text).toContain('\r\n"Shop, ""main""\nbranch",1200,')
  })

  it('keeps a group that a spreadsheet would run as a formula as text', () => {
    expect(csvField('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(csvField('@cmd')).toBe("'@cmd")
    expect(csvField('-1+1')).toBe("'-1+1")
    expect(csvField('ABC-123')).toBe('ABC-123')
  })

  it('writes numbers raw: no separators, no units, no exponent', () => {
    expect(csvNumber(1234567)).toBe('1234567')
    expect(csvNumber(0.000001)).toBe('0.000001')
    expect(csvNumber(0.1 + 0.2)).toBe('0.3')
    expect(csvNumber(1e-9)).toBe('0')
    expect(csvNumber(1e21)).toBe('1000000000000000000000')
    expect(csvNumber(Number.NaN)).toBe('0')
    expect(usageCsv(table([row('x', { usd: 1234.5678 })]))).toContain(',1234.5678,')
  })

  it('writes a header-only file for an empty table', () => {
    expect(usageCsv(table([])).slice(1)).toBe('Group,Input,Output,Cache,Cost (USD),Sessions,Agent time (seconds)\r\n')
  })

  it('names the file with the grouping and the first and last day of the period', () => {
    expect(usageCsvName(table([]))).toBe('workhub-usage-by-project-2026-10-01_2026-10-27.csv')
    const oneDay = { groupBy: 'agent' as const, since: new Date(2026, 9, 5).getTime(), until: new Date(2026, 9, 6).getTime() }
    expect(usageCsvName(oneDay)).toBe('workhub-usage-by-agent-2026-10-05.csv')
  })
})

describe('the table the screen sends', () => {
  const totals = (group: string | null, over: Partial<SpendTotals> = {}): SpendTotals => ({ group, tokensIn: 10, tokensOut: 20, cacheRead: 100, cacheWrite: 50, usd: 0.25, unpricedTokens: 0, activeMs: 90_400, turns: 4, sessions: 2, ...over })

  it('keeps the order given, sums cache reads and writes, and names a group in full', () => {
    const out = csvTable([totals('/work/b'), totals(null, { sessions: 1 })], 'project', { since, until }, HEADERS, (g) => (g === null ? { text: '(none)' } : { text: '~/b', title: g }))
    expect(out.rows.map((r) => r.group)).toEqual(['/work/b', '(none)'])
    expect(out.rows[0]).toEqual({ group: '/work/b', tokensIn: 10, tokensOut: 20, cache: 150, usd: 0.25, sessions: 2, activeSeconds: 90 })
    expect(out).toMatchObject({ groupBy: 'project', since, until, headers: HEADERS })
  })
})

describe('the export handler', () => {
  const setup = (pick: (path: string) => Promise<string | undefined>) => {
    const written: { path: string; text: string }[] = []
    const picked: string[] = []
    const run = createUsageCsvExporter({
      window: () => null,
      folder: () => '/docs',
      pick: async (path) => {
        picked.push(path)
        return pick(path)
      },
      write: async (path, text) => void written.push({ path, text })
    })
    return { run, written, picked }
  }

  it('offers the dated name in the folder and writes what the user picked', async () => {
    const { run, written, picked } = setup(async () => '/somewhere/usage.csv')
    expect(await run(table([row('a')]))).toEqual({ ok: true, path: '/somewhere/usage.csv' })
    // The product joins with node:path, so the separator is the platform's.
    expect(picked).toEqual([join('/docs', 'workhub-usage-by-project-2026-10-01_2026-10-27.csv')])
    expect(written).toHaveLength(1)
    expect(written[0]!.text.startsWith('﻿Group,')).toBe(true)
  })

  it('writes nothing when the dialog is canceled', async () => {
    const { run, written } = setup(async () => undefined)
    expect(await run(table([row('a')]))).toEqual({ ok: false, canceled: true })
    expect(written).toEqual([])
  })

  it('reports a failed write instead of throwing', async () => {
    const run = createUsageCsvExporter({ window: () => null, folder: () => '/docs', pick: async () => '/x.csv', write: async () => Promise.reject(new Error('disk full')) })
    expect(await run(table([]))).toEqual({ ok: false, canceled: false, error: 'disk full' })
  })

  it('refuses a malformed table before any dialog opens', async () => {
    const { run, picked } = setup(async () => '/x.csv')
    await expect(run({ ...table([]), groupBy: 'nope' })).rejects.toThrow('groupBy')
    await expect(run({ ...table([]), headers: ['a'] })).rejects.toThrow('headers')
    await expect(run({ ...table([]), until: since })).rejects.toThrow('period')
    await expect(run(table([row('a', { usd: -1 })]))).rejects.toThrow('row')
    await expect(run(table([row('a', { tokensIn: Number.NaN })]))).rejects.toThrow('row')
    await expect(run('x')).rejects.toThrow('table')
    expect(picked).toEqual([])
    expect(parseUsageCsvExport(table([row('ok')])).rows).toHaveLength(1)
  })
})
