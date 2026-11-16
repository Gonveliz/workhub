/**
 * Session menu → Export conversation: the chat as a Markdown file the user picks. The renderer
 * sends the finished text and the session's name and never a path; this module checks the shape,
 * names the file from the session's name and the date, asks where in a save dialog and writes it.
 */
import { app, dialog, type BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConversationExport, ConversationExportResult } from '../shared/api'
import { exportFileName } from '../shared/chat-export'

/** A very long chat is a few megabytes of text; more than this is a malformed request. */
const MAX_MARKDOWN = 64 * 1024 * 1024
const MAX_NAME = 1024

/** Checks what the renderer sent (it is not trusted with shapes). */
export function parseConversationExport(raw: unknown): ConversationExport {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null
  if (!r || typeof r['name'] !== 'string' || r['name'].length > MAX_NAME) throw new Error('Invalid conversation export: name')
  if (typeof r['markdown'] !== 'string' || r['markdown'].length > MAX_MARKDOWN) throw new Error('Invalid conversation export: markdown')
  return { name: r['name'], markdown: r['markdown'] }
}

export interface ConversationExporterDeps {
  /** The window the save dialog sits on, when there is one. */
  window: () => BrowserWindow | null
  /** Where the dialog opens (the user's Documents folder by default). */
  folder?: () => string
  now?: () => number
  /** Asks where to save; undefined when the user cancels. Replaceable for tests. */
  pick?: (defaultPath: string, owner: BrowserWindow | null) => Promise<string | undefined>
  write?: (path: string, text: string) => Promise<void>
}

/** The `sessions:exportConversation` handler: validate, ask where, write. A canceled dialog is not an error. */
export function createConversationExporter(deps: ConversationExporterDeps): (raw: unknown) => Promise<ConversationExportResult> {
  const pick =
    deps.pick ??
    (async (defaultPath, owner) => {
      const options = { defaultPath, filters: [{ name: 'Markdown', extensions: ['md'] }] }
      const picked = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
      return picked.canceled ? undefined : picked.filePath || undefined
    })
  const write = deps.write ?? ((path, text) => writeFile(path, text, { encoding: 'utf8' }))
  return async (raw) => {
    const conversation = parseConversationExport(raw)
    try {
      const folder = deps.folder?.() ?? app.getPath('documents')
      const target = await pick(join(folder, exportFileName(conversation.name, (deps.now ?? Date.now)())), deps.window())
      if (!target) return { ok: false, canceled: true }
      await write(target, conversation.markdown)
      return { ok: true, path: target }
    } catch (err) {
      return { ok: false, canceled: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
