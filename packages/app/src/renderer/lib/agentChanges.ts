import type { AgentChange } from '@shared/agent-changes-api'

/** Characters of one value a diff line shows; the full value is in its tooltip. */
export const DIFF_VALUE_CHARS = 160

/** A field's value as one line of text: strings as they are, anything else as compact JSON; null when the field was not set. */
export function changeValue(value: unknown): string | null {
  if (value === undefined) return null
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** The value cut to a diff line. */
export const shortValue = (text: string) => (text.length > DIFF_VALUE_CHARS ? `${text.slice(0, DIFF_VALUE_CHARS - 1)}…` : text)

/** The unreviewed changes to one object, newest first (the marker on an automation's card). */
export function changesOf(changes: readonly AgentChange[], kind: AgentChange['kind'], id: string): AgentChange[] {
  return changes.filter((c) => c.kind === kind && c.object.id === id)
}
