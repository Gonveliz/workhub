// The order the main process starts its services in once the window is up, and the order it stops
// them in at quit. Each list is the single place that order is written: index.ts supplies one
// function per step (the type makes it supply every step) and these run them one after the other.
// A new service adds its step here, where it belongs in the order, and its function in index.ts.

/** Started once the main window and the tray are up, in this order. */
export const START_ORDER = [
  'usage',
  'tokenSpend',
  'permissionReminders',
  // Opt-in: nothing contacts GitHub unless the user turned this on (packaged builds only).
  'updateChecks',
  'prEvents',
  'slack',
  'automations',
  'aiReview',
  'healthWatcher',
  'flowAlertWatcher',
  'metricAlerts',
  'ticketWatcher',
  // The first calendar check runs before the renderer reports its language: word it in the system's.
  'trayLocale',
  'calendarWatcher',
  // The network is often not up yet when the laptop wakes: the calendars are read again then.
  'calendarOnResume',
  'planner',
  'historyIndexer'
] as const

/** Stopped at quit once busy sessions are settled, in this order, before the agents are stopped. */
export const STOP_ORDER = [
  'usage',
  'permissionReminders',
  'kiroUsage',
  'tokenSpend',
  'prEvents',
  'slack',
  'automations',
  'aiReview',
  'localReview',
  'controlServer',
  'healthWatcher',
  'flowAlertWatcher',
  'metricAlerts',
  'ticketWatcher',
  'calendarWatcher',
  'planner',
  'historyIndexer',
  'sessionNames',
  'database'
] as const

export type StartStep = (typeof START_ORDER)[number]
export type StopStep = (typeof STOP_ORDER)[number]

/** Runs every start step in START_ORDER; a step that throws stops the ones after it, as inline calls would. */
export function startServices(steps: Record<StartStep, () => void>): void {
  for (const step of START_ORDER) steps[step]()
}

/** Runs every stop step in STOP_ORDER. */
export function stopServices(steps: Record<StopStep, () => void>): void {
  for (const step of STOP_ORDER) steps[step]()
}
