import { app, dialog, shell, type BrowserWindow } from 'electron'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { arch, release, type } from 'node:os'
import type { DiagnosticsExportResult, StorageInfo } from '../shared/api'
import { exportDiagnostics } from './diagnostics-export'
import type { JobStatus } from './job-reporter'

export interface DiagnosticsExporterDeps {
  /** The window the folder picker sits on, when there is one. */
  window: () => BrowserWindow | null
  logsDir: string
  flush: () => void
  jobs: () => JobStatus[]
  storage: () => StorageInfo | null
  config: () => Promise<unknown>
}

/** Help → Export diagnostics… and its button in Settings: asks for a folder, writes the export there, shows it. */
export function createDiagnosticsExporter(deps: DiagnosticsExporterDeps): () => Promise<DiagnosticsExportResult> {
  return async () => {
    try {
      const owner = deps.window()
      const options = { properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>, defaultPath: app.getPath('desktop') }
      const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
      const target = picked.filePaths[0]
      if (picked.canceled || !target) return { ok: false, canceled: true }
      deps.flush()
      const config = await deps.config().catch(() => null)
      const done = await exportDiagnostics({
        fs: { mkdir: (p) => mkdir(p, { recursive: true }).then(() => undefined), readdir, readFile: (p) => readFile(p, 'utf8'), writeFile: (p, text) => writeFile(p, text, { mode: 0o600 }) },
        target,
        logsDir: deps.logsDir,
        info: { app: app.getVersion(), electron: process.versions.electron ?? '?', node: process.versions.node, chrome: process.versions.chrome ?? '?', os: `${type()} ${release()}`, arch: arch(), packaged: app.isPackaged },
        jobs: deps.jobs(),
        storage: deps.storage(),
        config
      })
      shell.showItemInFolder(done.folder)
      return { ok: true, folder: done.folder, files: done.files.length }
    } catch (err) {
      return { ok: false, canceled: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
