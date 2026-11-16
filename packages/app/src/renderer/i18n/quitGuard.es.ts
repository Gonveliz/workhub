import type { quitGuardEn } from './quitGuard.en'

/** Spanish copy of the quit guard (asking before quitting while sessions are busy) and the stuck-session notice. */
export const quitGuardEs: Record<keyof typeof quitGuardEn, string> = {
  'quit.title': 'Todavía hay sesiones ocupadas',
  'quit.working.one': '{count} sesión está trabajando',
  'quit.working.other': '{count} sesiones están trabajando',
  'quit.queued.one': '{count} mensaje espera su turno',
  'quit.queued.other': '{count} mensajes esperan su turno',
  'quit.permissions.one': '{count} solicitud espera una respuesta',
  'quit.permissions.other': '{count} solicitudes esperan una respuesta',
  'quit.detail': 'Salir ahora detiene los turnos en curso y descarta los mensajes en cola y las solicitudes sin responder.',
  'quit.detailRestart': 'Reiniciar ahora detiene los turnos en curso y descarta los mensajes en cola y las solicitudes sin responder.',
  'quit.anyway': 'Salir igual',
  'quit.whenIdle': 'Salir al quedar libre',
  'quit.restartAnyway': 'Reiniciar igual',
  'quit.restartWhenIdle': 'Reiniciar al quedar libre',
  'quit.cancel': 'Cancelar',
  'quit.pending.quit': 'Saliendo apenas no haya sesiones ocupadas.',
  'quit.pending.restart': 'Reiniciando para instalar la actualización apenas no haya sesiones ocupadas.',
  'quit.pending.cancel': 'Cancelar',
  'header.activity.stalled': 'Sin salida hace',
  'header.stalledHint': 'El agente no envió nada hace {time}',
  'session.stalled': 'El agente no envió nada hace {time}. Puede estar trabado o seguir pensando.',
  'session.keepWaiting': 'Seguir esperando',
  'settingsV2.general.confirmQuit': 'Preguntar antes de salir si hay sesiones ocupadas',
  'settingsV2.general.confirmQuitHint': 'Si una sesión está trabajando, tiene mensajes en cola o espera una respuesta, salir (o reiniciar para actualizar) pregunta antes. Apagar la computadora nunca espera.',
  'settingsV2.general.stuckSessions': 'Avisar cuando una sesión en curso se queda callada',
  'settingsV2.general.stuckSessionsHint': 'El encabezado de la sesión lo indica cuando su agente no envía nada durante este tiempo y ofrece Detener o Seguir esperando. No se detiene nada solo.',
  'settingsV2.general.stuckOff': 'Nunca',
  'settingsV2.general.stuckAfter': 'Después de {count} min'
}
