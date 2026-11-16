import type { RendererReport } from '@shared/api'

/** What an error boundary holds: the error it caught, or null while its children render. */
export interface BoundaryState {
  error: Error | null
}

export const BOUNDARY_CLEAR: BoundaryState = { error: null }

/** React may throw anything; the fallback and the log want an Error. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(typeof value === 'string' ? value : 'Unknown error')
}

export function boundaryCaught(value: unknown): BoundaryState {
  return { error: toError(value) }
}

/** "Try again" remounts the children; the next render error is caught afresh. */
export function boundaryReset(): BoundaryState {
  return BOUNDARY_CLEAR
}

/** The main-log line for a caught error: its name and message and the component, never the stack text of a chat. */
export function boundaryReport(error: Error, where: string): RendererReport {
  return { kind: 'error', message: `${where}: ${error.name}: ${error.message}` }
}
