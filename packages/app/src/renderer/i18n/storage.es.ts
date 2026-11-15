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
  'storage.recovered': 'El {date} la base de datos no se pudo leer y se movió a {path}; Workhub arrancó con una vacía. Las copias anteriores están en {folder} (ver Solución de problemas, "La base de datos").'
}
