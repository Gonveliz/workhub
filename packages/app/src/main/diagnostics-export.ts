import { redactConfig, redactText } from '@workhub/core'
import type { StorageInfo } from '../shared/api'
import type { JobStatus } from './job-reporter'

/** The few file operations the export needs, so a test can run it on a fake disk. */
export interface ExportFs {
  mkdir(path: string): Promise<void>
  readdir(path: string): Promise<string[]>
  readFile(path: string): Promise<string>
  writeFile(path: string, text: string): Promise<void>
}

export interface DiagnosticsInput {
  fs: ExportFs
  /** The folder the user picked; the export makes its own subfolder inside it. */
  target: string
  logsDir: string
  /** `<dataDir>/logs` files are `main.log` and `main.<n>.log`. */
  logName?: string
  info: { app: string; electron: string; node: string; chrome: string; os: string; arch: string; packaged: boolean }
  jobs: readonly JobStatus[]
  /** The database readout of Settings → Advanced → Data. */
  storage: StorageInfo | null
  /** The config as loaded; every secret-like value and path is masked before it is written. */
  config: unknown
  now?: () => Date
}

export interface DiagnosticsExport {
  folder: string
  /** File names written inside `folder`. */
  files: string[]
}

/**
 * Writes a folder of diagnostics a person can read before sending: the log and its rotated copies
 * (credential-looking text masked again), versions, the background jobs' table, the database
 * size and the config with secrets and paths masked. It never reads `secrets.json` or the
 * database, and copies no other file of the data folder.
 */
export async function exportDiagnostics(input: DiagnosticsInput): Promise<DiagnosticsExport> {
  const { fs } = input
  const at = (input.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const folder = joinPath(input.target, `workhub-diagnostics-${at}`)
  await fs.mkdir(folder)
  const files: string[] = []
  const write = async (name: string, text: string): Promise<void> => {
    await fs.writeFile(joinPath(folder, name), text)
    files.push(name)
  }

  const name = input.logName ?? 'main'
  const logFile = new RegExp(`^${name}(\\.\\d+)?\\.log$`)
  for (const file of (await fs.readdir(input.logsDir).catch(() => [])).filter((f) => logFile.test(f)).sort()) {
    const text = await fs.readFile(joinPath(input.logsDir, file)).catch(() => null)
    if (text !== null) await write(file, redactText(text, Infinity))
  }
  await write('versions.json', json(input.info))
  await write('jobs.json', json(input.jobs))
  // The database's own path is left out: it holds the user's home folder.
  await write('database.json', json(input.storage ? { sizeBytes: input.storage.sizeBytes, lastBackup: input.storage.lastBackup ? 'present' : null, recovered: input.storage.recovered ? { at: input.storage.recovered.at } : null } : null))
  await write('config.redacted.json', json(redactConfig(input.config)))
  return { folder, files }
}

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`

/** Joins with the platform separator already used by `base` (no `node:path` here, so a fake disk can use any style). */
function joinPath(base: string, name: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return base.endsWith(sep) ? `${base}${name}` : `${base}${sep}${name}`
}
