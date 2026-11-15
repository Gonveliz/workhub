/** English copy of Settings → Advanced → Data: the database, its size and its backups. */
export const storageEn = {
  'storage.database': 'Database',
  'storage.databaseHint': 'Sessions, watchers, spend, Plan and flow maps are kept in this SQLite file. A copy goes to the backups folder about 30 seconds after start and then once a day (the last 7 daily copies are kept, and the last 7 made with Back up now).',
  'storage.lastBackup': 'Last backup: {name}',
  'storage.noBackup': 'No backup yet',
  'storage.backupNow': 'Back up now',
  'storage.backedUp': 'Database backed up to {path}',
  'storage.backupFailed': 'The backup failed. Try again in a moment.',
  'storage.backupNotWritten': 'No backup was written. Try again.',
  'storage.backupNoSpace': 'The backup failed: the disk is full.',
  'storage.backupNoAccess': 'The backup failed: Workhub cannot write to the backups folder.',
  'storage.revealBackups': 'Show backups folder',
  'storage.recovered': 'On {date} the database could not be read and was moved aside to {path}; Workhub started with an empty one. Earlier copies are in {folder} (see Troubleshooting, "The database").'
}
