/**
 * The one-time move of the JSON state files of earlier versions into `workhub.db`.
 *
 * The first run (no `IMPORT_DONE_KEY` yet) reads every legacy file, stores in one transaction what
 * the database has nothing for yet (and the marker), checkpoints the write-ahead log to the main
 * file, and only then renames the files: `<name>.json.migrated` when imported, `.skipped` when not
 * (the key existed, or not an object), `.corrupt` when not JSON. `flow-maps/` and `flow-history/`
 * become `flow-maps.migrated/` and `flow-history.migrated/`. Nothing is deleted.
 *
 * Later runs import nothing: a legacy file that shows up again (an older version run on the same
 * data folder) is renamed to `.skipped` and left there.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkhubDb } from './db'
import { FLOW_HISTORY_DAYS } from './flow-history'
import { PR_EVENTS_KEY } from './pr-events'

/** The state files the main process wrote in the data folder; each becomes the `kv_state` row named after it. */
export const LEGACY_STATE_FILES: readonly string[] = [
  'open-sessions.json',
  'session-names.json',
  'session-windows.json',
  'settings-window.json',
  'session-budgets.json',
  'agent-options.json',
  'remote.json',
  'token-spend.json',
  'api-spend-ledger.json',
  'kiro-usage.json',
  'usage-alerts.json',
  'slack-state.json',
  'automations-state.json',
  'ai-review-state.json',
  'calendar-state.json',
  'planner-state.json',
  'ticket-watch.json',
  'health-alerts.json',
  'flow-alerts.json',
  'metric-alerts.json',
  'update-prompt.json',
  'pr-events.json'
]

/** The `kv_state` key set once the legacy import ran in this data folder. */
export const IMPORT_DONE_KEY = 'storage/import-done'

export const LEGACY_FLOW_MAPS_FOLDER = 'flow-maps'
export const LEGACY_FLOW_HISTORY_FOLDER = 'flow-history'

export interface ImportSummary {
  /** Stored, renamed to `.migrated`. */
  imported: string[]
  /** Not stored (the import ran before, the key existed, or not an object), renamed to `.skipped`. */
  skipped: string[]
  /** Not JSON: renamed to `.corrupt`. */
  corrupt: string[]
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const SAFE_ID = /^[a-z0-9][a-z0-9-_.]*$/i
const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const UPSERT_KV = 'INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'

/** Whether the legacy import ran in this database already. */
export function legacyImportDone(db: WorkhubDb): boolean {
  return Boolean(db.raw.prepare('SELECT 1 FROM kv_state WHERE key = ?').get(IMPORT_DONE_KEY))
}

/** A map id for a file whose map has none usable: its name, lower case, with anything else as `-`. */
export function flowMapIdFromFileName(name: string): string {
  const slug = name
    .replace(/\.json$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9-_.]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[^a-z0-9]+/, '')
  return slug || 'map'
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** `path` + `suffix`, or + `suffix-<now>` when that exists already (a second downgrade). */
function renameAside(path: string, suffix: string, now: () => number): void {
  const target = existsSync(path + suffix) ? `${path}${suffix}-${now()}` : path + suffix
  renameSync(path, target)
}

type Outcome = 'imported' | 'skipped' | 'corrupt'
interface Step {
  label: string
  outcome: Outcome
  /** The write, run inside the import transaction (imported only). */
  store?: () => void
  /** The file move, run after the commit and the checkpoint. */
  move: () => void
}

function parse(path: string): { ok: true; value: unknown } | { ok: false } | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

export function importLegacyJson(db: WorkhubDb, dataDir: string, log: (message: string) => void = (m) => console.warn(m), now: () => number = Date.now): ImportSummary {
  const done = legacyImportDone(db)
  const steps: Step[] = []
  const names = list(dataDir)
  const present = new Set(names)
  const hasKey = db.raw.prepare('SELECT 1 FROM kv_state WHERE key = ?')

  for (const name of LEGACY_STATE_FILES) {
    // Temp files of an interrupted atomic write: incomplete by definition.
    for (const n of names) {
      if (n.startsWith(`${name}.`) && n.endsWith('.tmp')) {
        try {
          unlinkSync(join(dataDir, n))
        } catch {
          // Gone already.
        }
      }
    }
    if (!present.has(name)) continue
    const path = join(dataDir, name)
    const key = name === 'pr-events.json' ? PR_EVENTS_KEY : name.replace(/\.json$/, '')
    const read = parse(path)
    if (!read) continue
    if (!read.ok) {
      steps.push({ label: name, outcome: 'corrupt', move: () => renameAside(path, '.corrupt', now) })
    } else if (done || !isPlainObject(read.value) || hasKey.get(key)) {
      steps.push({ label: name, outcome: 'skipped', move: () => renameAside(path, '.skipped', now) })
    } else {
      const text = JSON.stringify(read.value)
      steps.push({ label: name, outcome: 'imported', store: () => db.raw.prepare('INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, ?)').run(key, text, now()), move: () => renameAside(path, '.migrated', now) })
    }
  }

  const mapsDir = join(dataDir, LEGACY_FLOW_MAPS_FOLDER)
  const mapSteps = isDir(mapsDir) ? flowMapSteps(db, mapsDir, done, now) : null
  const historyDir = join(dataDir, LEGACY_FLOW_HISTORY_FOLDER)
  const historySteps = isDir(historyDir) ? flowHistorySteps(db, historyDir, done, now) : null
  for (const s of [mapSteps, historySteps]) if (s) steps.push(...s)

  if (!done || steps.some((s) => s.store)) {
    db.transaction(() => {
      for (const s of steps) s.store?.()
      if (!done) db.raw.prepare(UPSERT_KV).run(IMPORT_DONE_KEY, JSON.stringify({ at: now() }), now())
    })
  }
  // Everything stored reaches the main database file before a single legacy file is moved.
  checkpoint(db, log)

  const summary: ImportSummary = { imported: [], skipped: [], corrupt: [] }
  for (const s of steps) {
    try {
      s.move()
      summary[s.outcome].push(s.label)
    } catch (err) {
      log(`legacy import: could not rename ${s.label}: ${describe(err)}`)
    }
  }
  // The folders go aside last, whole: `.migrated` when anything in them was stored.
  for (const [dir, folderSteps] of [[mapsDir, mapSteps], [historyDir, historySteps]] as const) {
    if (!folderSteps) continue
    try {
      renameAside(dir, folderSteps.some((s) => s.outcome === 'imported') ? '.migrated' : '.skipped', now)
    } catch (err) {
      log(`legacy import: could not rename ${dir}: ${describe(err)}`)
    }
  }
  return summary
}

function checkpoint(db: WorkhubDb, log: (m: string) => void): void {
  try {
    // macOS: a plain fsync does not reach the disk platter; F_FULLFSYNC for this one step.
    if (process.platform === 'darwin') db.raw.exec('PRAGMA checkpoint_fullfsync=ON')
    db.raw.prepare('PRAGMA wal_checkpoint(FULL)').get()
  } catch (err) {
    log(`legacy import: checkpoint failed: ${describe(err)}`)
  } finally {
    try {
      if (process.platform === 'darwin') db.raw.exec('PRAGMA checkpoint_fullfsync=OFF')
    } catch {
      // Closed or busy: the default comes back with the next open.
    }
  }
}

/** One log line for an import, or null when there was nothing to import. */
export function describeImport(summary: ImportSummary): string | null {
  if (!summary.imported.length && !summary.skipped.length && !summary.corrupt.length) return null
  const part = (label: string, items: string[]) => `${label} ${items.length}${items.length ? ` (${items.join(', ')})` : ''}`
  return `legacy JSON import: ${part('imported', summary.imported)}; ${part('skipped', summary.skipped)}; ${part('corrupt', summary.corrupt)}`
}

/**
 * `flow-maps/*.json` → `flow_maps`, in name order. A map is stored under its own id, else under a
 * slug of its file name (so a bad map can still be deleted); when two files share an id, `<id>.json`
 * wins and the other stays on disk as `.skipped`. A map that does not validate is still stored and
 * listed with its error.
 */
function flowMapSteps(db: WorkhubDb, dir: string, done: boolean, now: () => number): Step[] {
  const steps: Step[] = []
  const has = db.raw.prepare('SELECT 1 FROM flow_maps WHERE id = ?')
  const byId = new Map<string, { name: string; path: string; text: string }[]>()
  for (const name of list(dir)) {
    if (!name.endsWith('.json')) continue
    const path = join(dir, name)
    const label = `${LEGACY_FLOW_MAPS_FOLDER}/${name}`
    const read = parse(path)
    if (!read) continue
    if (!read.ok) {
      steps.push({ label, outcome: 'corrupt', move: () => renameAside(path, '.corrupt', now) })
      continue
    }
    const v = read.value
    const id = isPlainObject(v) && typeof v['id'] === 'string' && SAFE_ID.test(v['id']) && !v['id'].includes('..') ? v['id'] : flowMapIdFromFileName(name)
    byId.set(id, [...(byId.get(id) ?? []), { name, path, text: readFileSync(path, 'utf8') }])
  }
  for (const [id, files] of byId) {
    const winner = files.find((f) => f.name === `${id}.json`) ?? files[0]!
    for (const f of files) {
      const label = `${LEGACY_FLOW_MAPS_FOLDER}/${f.name}`
      if (f !== winner || done || has.get(id)) steps.push({ label, outcome: 'skipped', move: () => renameAside(f.path, '.skipped', now) })
      else steps.push({ label, outcome: 'imported', store: () => db.raw.prepare('INSERT INTO flow_maps (id, json, updated_at) VALUES (?, ?, ?)').run(id, f.text, now()), move: () => {} })
    }
  }
  return steps
}

interface LegacyHistoryFile {
  version?: unknown
  measures?: Record<string, { hours?: unknown; settledUntil?: unknown; fetchedAt?: unknown }>
}

/** `flow-history/<scope hash>.json` → the flow history tables (the hash is the scope), hours within the retention. */
function flowHistorySteps(db: WorkhubDb, dir: string, done: boolean, now: () => number): Step[] {
  const steps: Step[] = []
  const cutoff = now() - FLOW_HISTORY_DAYS * 86_400_000
  const hasMeasure = db.raw.prepare('SELECT 1 FROM flow_history_measures WHERE scope = ? AND measure = ?')
  const insertMeasure = db.raw.prepare('INSERT INTO flow_history_measures (scope, measure, settled_until, fetched_at) VALUES (?, ?, ?, ?)')
  const insertHour = db.raw.prepare('INSERT OR IGNORE INTO flow_history_hours (scope, measure, hour_at, json, fetched_at) VALUES (?, ?, ?, ?, ?)')
  for (const name of list(dir)) {
    if (!name.endsWith('.json')) continue
    const path = join(dir, name)
    const label = `${LEGACY_FLOW_HISTORY_FOLDER}/${name}`
    const read = parse(path)
    if (!read) continue
    if (!read.ok) {
      steps.push({ label, outcome: 'corrupt', move: () => renameAside(path, '.corrupt', now) })
      continue
    }
    const file = read.value as LegacyHistoryFile
    const scope = name.replace(/\.json$/, '')
    if (done || !isPlainObject(file) || file.version !== 1 || !isPlainObject(file.measures)) {
      steps.push({ label, outcome: 'skipped', move: () => renameAside(path, '.skipped', now) })
      continue
    }
    steps.push({
      label,
      outcome: 'imported',
      store: () => {
        for (const [measure, h] of Object.entries(file.measures!)) {
          if (!isPlainObject(h) || typeof h.fetchedAt !== 'number' || hasMeasure.get(scope, measure)) continue
          insertMeasure.run(scope, measure, typeof h.settledUntil === 'number' ? h.settledUntil : 0, h.fetchedAt)
          for (const hour of Array.isArray(h.hours) ? h.hours : []) {
            if (isPlainObject(hour) && typeof hour['at'] === 'number' && hour['at'] >= cutoff) insertHour.run(scope, measure, hour['at'], JSON.stringify(hour), h.fetchedAt)
          }
        }
      },
      move: () => {}
    })
  }
  return steps
}
