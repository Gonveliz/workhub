import type { ConversationExportResult } from '@shared/api'
import { conversationMarkdown, type ExportLabels } from '../../shared/chat-export'
import type { MessageKey } from '../i18n/translate'
import { sessionTitle } from './windows'
import type { SessionData } from '../store'

/** The chat as Markdown in the user's language, handed to main, which asks where to save it. */
export function exportConversation(data: SessionData, t: (key: MessageKey) => string): Promise<ConversationExportResult> {
  const v = data.view
  const name = v.name || v.agentTitle || sessionTitle(v)
  const labels: ExportLabels = {
    user: t('export.user'),
    agent: t('export.agent'),
    error: t('export.error'),
    tool: t('export.tool'),
    permission: t('export.permission'),
    compaction: t('export.compaction'),
    exported: t('export.exported')
  }
  return window.hub.sessions.exportConversation({ name, markdown: conversationMarkdown(name, data.items, labels, Date.now()) })
}
