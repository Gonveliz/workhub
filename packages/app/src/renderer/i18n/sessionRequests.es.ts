import type { sessionRequestsEn } from './sessionRequests.en'

/** Spanish copy of what agents ask of other sessions (neutral). Same keys as `sessionRequestsEn`. */
export const sessionRequestsEs: Record<keyof typeof sessionRequestsEn, string> = {
  'sessionRequests.title': 'Pedidos del agente de esta sesión',
  'sessionRequests.start': 'El agente propone una sesión nueva de {agent} en {folder}.',
  'sessionRequests.startNamed': 'El agente propone una sesión nueva de {agent}, “{name}”, en {folder}.',
  'sessionRequests.startHint': 'Aprobar la inicia con este primer prompt, en un modo que pregunta antes de actuar.',
  'sessionRequests.message': 'El agente quiere enviarle un mensaje a {to}.',
  'sessionRequests.messageHint': 'Permitirlo también deja pasar los mensajes siguientes de esta sesión a {to} hasta que cierres Workhub. Llegan marcados como enviados por esta sesión.',
  'sessionRequests.prompt': 'Primer prompt',
  'sessionRequests.text': 'Mensaje',
  'sessionRequests.approveStart': 'Iniciar sesión',
  'sessionRequests.approveMessage': 'Permitir y enviar',
  'sessionRequests.dismiss': 'Descartar',
  'sessionRequests.badge.one': '{count} pedido te espera',
  'sessionRequests.badge.other': '{count} pedidos te esperan',
  'sessionRequests.notify.start': '{name} propone una sesión nueva',
  'sessionRequests.notify.message': '{name} quiere enviarle un mensaje a {to}',
  'sessionRequests.error.gone': 'Ese pedido ya no está esperando, o la sesión que nombra ya no existe.',
  'sessionRequests.error.agent': 'Este perfil ya no ofrece ese agente.',
  'sessionRequests.error.folder': 'Esa carpeta ya no es una de las carpetas de este perfil.',
  'sessionRequests.error.unattended': 'Ese agente arranca sin pedir permisos y no tiene un modo que pregunte: inicia la sesión desde Nueva sesión.',
  'sessionRequests.error.failed': 'La sesión no se inició: {detail}'
}
