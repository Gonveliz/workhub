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

/** Fields of a whole object an agent added or deleted that nobody decides on: its id, where it came from, its profile. */
export const INTERNAL_FIELDS: readonly string[] = ['id', 'source', 'profileId']

/** The fields a change shows: every changed one for an edit; for an added or deleted object, all but the internal ones. */
export function shownFields(change: AgentChange): string[] {
  return change.action === 'update' ? change.fields : change.fields.filter((f) => !INTERNAL_FIELDS.includes(f))
}

/** The words a readable value needs from the caller's language. */
export interface ValueWords {
  yes: string
  no: string
  empty: string
  locale: string
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const isPlain = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

function plain(value: string | number | boolean, words: ValueWords): string {
  if (typeof value === 'boolean') return value ? words.yes : words.no
  if (typeof value === 'string' && DAY.test(value)) {
    const at = new Date(`${value}T00:00:00Z`)
    if (!Number.isNaN(at.getTime())) return new Intl.DateTimeFormat(words.locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(at)
  }
  return String(value)
}

/**
 * A field's value in a short form a person reads, where there is one: yes or no, a day as a date,
 * a list as "a, b", a flat object as "key: value · key: value". Anything deeper stays JSON. Null
 * when the field was not set.
 */
export function readableValue(value: unknown, words: ValueWords): string | null {
  if (value === undefined) return null
  if (value === null) return words.empty
  if (isPlain(value)) return plain(value, words)
  if (Array.isArray(value)) {
    if (value.length === 0) return words.empty
    if (value.every(isPlain)) return value.map((v) => plain(v, words)).join(', ')
    return JSON.stringify(value)
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    if (entries.length === 0) return words.empty
    if (entries.every(([, v]) => isPlain(v))) return entries.map(([k, v]) => `${k}: ${plain(v as string | number | boolean, words)}`).join(' · ')
  }
  return JSON.stringify(value)
}

/** How many changes wait per kind, in a fixed order, kinds with none left out. */
export function countsByKind(changes: readonly AgentChange[]): { kind: AgentChange['kind']; count: number }[] {
  const order: AgentChange['kind'][] = ['automation', 'flowMap', 'milestone', 'inboxItem']
  return order.map((kind) => ({ kind, count: changes.filter((c) => c.kind === kind).length })).filter((k) => k.count > 0)
}

/** When the newest change happened; null for none. */
export function latestChange(changes: readonly AgentChange[]): number | null {
  return changes.length ? Math.max(...changes.map((c) => c.at)) : null
}
