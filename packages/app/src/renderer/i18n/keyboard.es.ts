import type { keyboardEn } from './keyboard.en'

/** Spanish copy of the keyboard commands for many sessions: session shortcuts and the command palette. */
export const keyboardEs: Record<keyof typeof keyboardEn, string> = {
  'menu.nextSession': 'Sesión siguiente',
  'menu.previousSession': 'Sesión anterior',
  'menu.nextNeedsYou': 'Siguiente sesión que te necesita',
  'menu.answerRequest': 'Responder la solicitud pendiente',
  'menu.findInChat': 'Buscar en la conversación',
  'menu.commandPalette': 'Paleta de comandos…',
  'keyboard.noneNeedsYou': 'Ninguna otra sesión te necesita',
  'palette.title': 'Paleta de comandos',
  'palette.placeholder': 'Buscar sesiones, pantallas y acciones',
  'palette.results': 'Resultados',
  'palette.empty': 'No hay coincidencias',
  'palette.kind.session': 'Sesión',
  'palette.kind.screen': 'Pantalla',
  'palette.kind.action': 'Acción',
  'palette.kind.setting': 'Ajuste',
  'palette.settingsSection': 'Ajustes: {section}'
}
