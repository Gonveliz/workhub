import type { agentChangesEn } from './agentChanges.en'

/** Spanish copy of "Cambios de agentes" on Home (neutral). Same keys as `agentChangesEn`. */
export const agentChangesEs: Record<keyof typeof agentChangesEn, string> = {
  'agentChanges.title': 'Cambios de agentes',
  'agentChanges.hint': 'Los agentes cambiaron esto desde Workhub. Conservar marca un cambio como revisado; Revertir vuelve a poner los valores de antes.',
  'agentChanges.count.one': '{count} cambio espera revisión',
  'agentChanges.count.other': '{count} cambios esperan revisión',
  'agentChanges.kind.automation': 'Automatización',
  'agentChanges.kind.flowMap': 'Mapa de flujo',
  'agentChanges.kind.milestone': 'Hito',
  'agentChanges.kind.inboxItem': 'Elemento de la bandeja',
  'agentChanges.action.create': 'agregado',
  'agentChanges.action.update': 'editado',
  'agentChanges.action.delete': 'eliminado',
  'agentChanges.bySession': 'Por {name} ({agent})',
  'agentChanges.bySessionOnly': 'Por {name}',
  'agentChanges.byUnknown': 'Por un agente',
  'agentChanges.unset': '(sin valor)',
  'agentChanges.held': 'se aplica al conservar',
  'agentChanges.inEffect': 'Los nuevos límites de alerta ya están en vigor: los anteriores ya no encajan en el mapa redibujado.',
  'agentChanges.keep': 'Conservar',
  'agentChanges.revert': 'Revertir',
  'agentChanges.marker': 'Cambiada por un agente',
  'agentChanges.markerTitle': 'Consérvala o reviértela en “Cambios de agentes”, en Inicio',
  'agentChanges.error.gone': 'Este cambio, o lo que cambió, ya no existe.',
  'agentChanges.error.changed': 'Cambió otra vez después del cambio del agente, así que quedó como está. Cámbialo a mano si hace falta.',
  'agentChanges.error.cut': 'Un valor era demasiado largo, o parecía un secreto, para guardarlo en el registro: cámbialo a mano.',
  'agentChanges.error.failed': 'Workhub no pudo hacerlo: {detail}'
}
