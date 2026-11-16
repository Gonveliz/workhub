import type { fileMentionsEn } from './fileMentions.en'

/** Copy en español del menú de archivos `@` del compositor. */
export const fileMentionsEs: Record<keyof typeof fileMentionsEn, string> = {
  'mention.menu': 'Archivos',
  'chat.keyFiles': 'archivos'
}
