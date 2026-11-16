import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerFileViewerIpc } from '../src/main/file-viewer'
import type { IpcRegistrar } from '../src/main/ipc-guard'

describe('files:openDefault', () => {
  it.skipIf(process.platform === 'win32')('shows a file that could run in its folder and opens the rest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-viewer-'))
    try {
      writeFileSync(join(dir, 'notes.md'), '# notes')
      writeFileSync(join(dir, 'run.command'), 'echo hi')
      writeFileSync(join(dir, 'tool'), 'echo hi')
      chmodSync(join(dir, 'tool'), 0o755)
      const handlers = new Map<string, (...args: any[]) => unknown>()
      const ipc: IpcRegistrar = { handle: (c, l) => void handlers.set(c, l), on: () => undefined }
      const opened: string[] = []
      const shown: string[] = []
      const windows: Array<{ id: number }> = []
      const { open } = registerFileViewerIpc(ipc, {
        createWindow: () => {
          const win = { webContents: { id: windows.length + 1 }, on: () => undefined, isDestroyed: () => false }
          windows.push(win.webContents)
          return win as never
        },
        home: dir,
        showItemInFolder: (p) => void shown.push(p),
        openPath: async (p) => (opened.push(p), ''),
        writeClipboard: () => undefined
      })
      const names = ['notes.md', 'run.command', 'tool']
      for (const name of names) open(join(dir, name))
      const openDefault = (i: number, name: string) => handlers.get('files:openDefault')!({ sender: { id: i + 1 } }, join(dir, name))
      for (const [i, name] of names.entries()) await openDefault(i, name)
      expect(opened).toEqual([join(dir, 'notes.md')])
      expect(shown).toEqual([join(dir, 'run.command'), join(dir, 'tool')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
