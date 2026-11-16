import { shell } from 'electron'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { historyOfSessions, type HistoryEntry } from '@workhub/core'
import type { HistorySearchOptions, HistorySearchResult } from '../../shared/api'
import { historySearchOptions } from '../history'
import type { HistoryIndexer } from '../history-indexer'
import type { IpcRegistrar } from '../ipc-guard'
import { opensAsProgram } from '../local-review'

export interface HistoryIpcDeps {
  /** The named listing of past sessions, shared by concurrent calls (see RecentCall). */
  named: { get(maxAgeMs?: number): Promise<{ entries: HistoryEntry[] }> }
  /** Lists one page deeper from now on. */
  deepen: () => void
  /** Whether the last listing went less deep than asked (one already under way when it deepened). */
  listedShallower: () => boolean
  search: (query: string, options: HistorySearchOptions) => Promise<HistorySearchResult>
  indexer: Pick<HistoryIndexer, 'progress'>
}

/** Past sessions of every agent (`history:*`). */
export function registerHistoryIpc(ipc: IpcRegistrar, deps: HistoryIpcDeps): void {
  ipc.handle('history:list', () => deps.named.get())
  ipc.handle('history:listOlder', async () => {
    deps.deepen()
    const result = await deps.named.get()
    // A listing already under way went only as deep as before: list once more.
    return deps.listedShallower() ? deps.named.get() : result
  })
  ipc.handle('history:search', (_e, query: unknown, options: unknown) => deps.search(typeof query === 'string' ? query.slice(0, 500) : '', historySearchOptions(options)))
  ipc.handle('history:indexProgress', () => deps.indexer.progress())
  ipc.handle('history:find', async (_e, keys: unknown) => {
    if (!Array.isArray(keys)) return []
    const wanted = new Set(keys.filter((k): k is string => typeof k === 'string'))
    if (!wanted.size) return []
    return historyOfSessions((await deps.named.get(10_000)).entries, wanted)
  })
  ipc.handle('history:revealFolder', async (_e, path: string) => {
    if (typeof path !== 'string' || !isAbsolute(path)) return false
    const isFolder = await stat(path).then((s) => s.isDirectory(), () => false)
    if (!isFolder) return false
    // A macOS bundle (`Some.app`) is a folder that opening would launch: it is shown in its folder instead.
    if (opensAsProgram(path, { isDirectory: true })) {
      shell.showItemInFolder(path)
      return true
    }
    return (await shell.openPath(path)) === ''
  })
}
