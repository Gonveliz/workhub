import type { chatToolsEn } from './chatTools.en'

/** Spanish copy of the chat conveniences: find in the conversation and export as Markdown. */
export const chatToolsEs: Record<keyof typeof chatToolsEn, string> = {
  'chat.find.label': 'Buscar en la conversación',
  'chat.find.placeholder': 'Buscar en la conversación',
  'chat.find.count': '{n} de {total}',
  'chat.find.none': 'Sin resultados',
  'chat.find.previous': 'Resultado anterior',
  'chat.find.next': 'Resultado siguiente',
  'chat.find.close': 'Cerrar la búsqueda',
  'session.exportConversation': 'Exportar conversación…',
  'session.exportFailed': 'No se pudo exportar la conversación: {message}',
  'export.exported': 'Exportado',
  'export.user': 'Vos',
  'export.agent': 'Agente',
  'export.error': 'Error',
  'export.tool': 'Llamada a herramienta:',
  'export.permission': 'Permiso:',
  'export.compaction': 'Se compactó la conversación'
} as const
