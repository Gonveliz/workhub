import type { storageEn } from './storage.en'

/** Spanish copy of Settings → Advanced → Data: the database, its size and its backups. */
export const storageEs: Record<keyof typeof storageEn, string> = {
  'storage.database': 'Base de datos',
  'storage.databaseHint': 'Las sesiones, los vigilantes, el gasto, Plan y los mapas de flujo se guardan en este archivo SQLite. Unos 30 segundos después de abrir y luego una vez por día se hace una copia en la carpeta backups (se guardan las últimas 7 diarias y las últimas 7 hechas con Hacer copia ahora).',
  'storage.lastBackup': 'Última copia: {name}',
  'storage.noBackup': 'Todavía no hay copias',
  'storage.backupNow': 'Hacer copia ahora',
  'storage.backedUp': 'Copia de la base de datos guardada en {path}',
  'storage.backupFailed': 'La copia falló. Probá de nuevo en un momento.',
  'storage.backupNotWritten': 'No se escribió ninguna copia. Probá de nuevo.',
  'storage.backupNoSpace': 'La copia falló: el disco está lleno.',
  'storage.backupNoAccess': 'La copia falló: Workhub no puede escribir en la carpeta de copias.',
  'storage.revealBackups': 'Mostrar carpeta de copias',
  'storage.recovered': 'El {date} la base de datos no se pudo leer y se movió a {path}; Workhub arrancó con una vacía. Las copias anteriores están en {folder} (ver Solución de problemas, "La base de datos").',
  'storage.usage': 'Lo que ocupan los datos',
  'storage.retention': 'El detalle de uso, los eventos de pull requests y tickets y las ejecuciones de automatizaciones se guardan {months} meses; el uso anterior queda en resúmenes diarios, así los reportes siguen sumando lo mismo. Corre una vez por día.',
  'storage.group.usageDetail': 'Detalle de uso',
  'storage.group.usageSummaries': 'Resúmenes de uso',
  'storage.group.historyIndex': 'Índice de búsqueda del Historial',
  'storage.group.events': 'Eventos y ejecuciones de automatizaciones',
  'storage.group.state': 'Estado de la app',
  'storage.rows': '{count} filas',
  'storage.sizeUnknown': 'tamaño desconocido',
  'storage.free': 'Espacio libre en el archivo: {size}',
  'storage.lastRun': 'Última vez: {date}',
  'storage.usageFailed': 'No se pudieron leer las cifras. Probá de nuevo en un momento.',
  'storage.compactNow': 'Compactar ahora',
  'storage.compacting': 'Compactando…',
  'storage.compactHint': 'Hace ahora la limpieza diaria y después reescribe el archivo para sacar el espacio libre. Con una base de datos grande puede tardar.',
  'storage.compacted': 'Base de datos compactada: {before} → {after}',
  'storage.compactFailed': 'No se pudo compactar. Probá de nuevo en un momento.'
}
