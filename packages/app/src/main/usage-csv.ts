/**
 * Usage and reports → Export CSV: the totals table as the screen shows it (filtered, grouped,
 * sorted) in a file the user picks. The renderer sends the rows and never a path; this module
 * checks the shape, builds the text (UTF-8 with a byte-order mark so a spreadsheet reads the
 * accents, RFC 4180 quoting, raw numbers) and writes it where the save dialog says.
 */
import { app, dialog, type BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { REPORT_GROUPS, type ReportGroupBy, type UsageCsvExport, type UsageCsvResult, type UsageCsvRow } from '../shared/analytics-api'

const BOM = '﻿'
const COLUMNS = 7
/** More rows than any grouping of a period can have; a bigger table is a malformed request. */
const MAX_ROWS = 100_000
const MAX_TEXT = 4096

/** A number as plain digits: no thousands separators, no exponent, no more decimals than a cost needs. */
export function csvNumber(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const text = String(Math.round(n * 1e6) / 1e6)
  // `String` writes values of 1e21 and more as an exponent; a spreadsheet wants digits.
  return /e/i.test(text) ? BigInt(Math.round(n)).toString() : text
}

/**
 * One text field: quoted when it holds a comma, a quote or a line break (quotes doubled), as RFC 4180
 * says. A value a spreadsheet would run as a formula (`=`, `+`, `-`, `@`, tab, CR first) gets a
 * leading apostrophe: group names come from tags and branch names, which anyone can write.
 */
export function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** The file's text: BOM, the header, then one record per row, each ending CRLF. */
export function usageCsv(table: Pick<UsageCsvExport, 'headers' | 'rows'>): string {
  const lines = [table.headers.map(csvField).join(',')]
  for (const r of table.rows) {
    lines.push([csvField(r.group), csvNumber(r.tokensIn), csvNumber(r.tokensOut), csvNumber(r.cache), csvNumber(r.usd), csvNumber(r.sessions), csvNumber(r.activeSeconds)].join(','))
  }
  return BOM + lines.join('\r\n') + '\r\n'
}

const pad = (n: number) => String(n).padStart(2, '0')
const localDate = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `workhub-usage-by-agent-2026-10-01_2026-10-27.csv`: the grouping and the period's first and last day. */
export function usageCsvName(table: Pick<UsageCsvExport, 'groupBy' | 'since' | 'until'>): string {
  const first = localDate(table.since)
  const last = localDate(Math.max(table.since, table.until - 1))
  return `workhub-usage-by-${table.groupBy}-${first === last ? first : `${first}_${last}`}.csv`
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 8.64e15
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const isText = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_TEXT

function invalid(what: string): never {
  throw new Error(`Invalid CSV export: ${what}`)
}

/** Checks what the renderer sent (it is not trusted with shapes); a malformed table is refused. */
export function parseUsageCsvExport(raw: unknown): UsageCsvExport {
  if (!isObject(raw)) invalid('table')
  const { groupBy, since, until, headers, rows } = raw
  if (typeof groupBy !== 'string' || !REPORT_GROUPS.includes(groupBy as ReportGroupBy)) invalid('groupBy')
  if (!isTime(since) || !isTime(until) || until <= since) invalid('period')
  if (!Array.isArray(headers) || headers.length !== COLUMNS || !headers.every(isText)) invalid('headers')
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) invalid('rows')
  const parsed: UsageCsvRow[] = rows.map((r: unknown) => {
    if (!isObject(r) || !isText(r['group'])) invalid('row')
    const { tokensIn, tokensOut, cache, usd, sessions, activeSeconds } = r
    if (![tokensIn, tokensOut, cache, usd, sessions, activeSeconds].every(isAmount)) invalid('row')
    return { group: r['group'], tokensIn: tokensIn as number, tokensOut: tokensOut as number, cache: cache as number, usd: usd as number, sessions: sessions as number, activeSeconds: activeSeconds as number }
  })
  return { groupBy: groupBy as ReportGroupBy, since, until, headers: headers as string[], rows: parsed }
}

export interface UsageCsvExporterDeps {
  /** The window the save dialog sits on, when there is one. */
  window: () => BrowserWindow | null
  /** Where the dialog opens (the user's Documents folder by default). */
  folder?: () => string
  /** Asks where to save; undefined when the user cancels. Replaceable for tests. */
  pick?: (defaultPath: string, owner: BrowserWindow | null) => Promise<string | undefined>
  write?: (path: string, text: string) => Promise<void>
}

/** The `analytics:exportCsv` handler: validate, ask where, write. A canceled dialog is not an error. */
export function createUsageCsvExporter(deps: UsageCsvExporterDeps): (raw: unknown) => Promise<UsageCsvResult> {
  const pick =
    deps.pick ??
    (async (defaultPath, owner) => {
      const options = { defaultPath, filters: [{ name: 'CSV', extensions: ['csv'] }] }
      const picked = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
      return picked.canceled ? undefined : picked.filePath || undefined
    })
  const write = deps.write ?? ((path, text) => writeFile(path, text, { encoding: 'utf8' }))
  return async (raw) => {
    const table = parseUsageCsvExport(raw)
    try {
      const folder = deps.folder?.() ?? app.getPath('documents')
      const target = await pick(join(folder, usageCsvName(table)), deps.window())
      if (!target) return { ok: false, canceled: true }
      await write(target, usageCsv(table))
      return { ok: true, path: target }
    } catch (err) {
      return { ok: false, canceled: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
