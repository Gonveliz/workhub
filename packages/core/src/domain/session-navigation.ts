/**
 * Moving between sessions from the keyboard: the next and previous session in the order the
 * sidebar shows them, and the next one that needs the user (a question or permission waiting, an
 * unread reply, a failure).
 */
import { statusLevel, type AttentionInput } from './attention'
import type { GroupRow, SidebarRow } from './session-groups'

/**
 * The open sessions in the order the sidebar lists them, top to bottom: a group's sub-groups come
 * before its own sessions, as drawn. Folded groups count too (opening a session unfolds its group);
 * closed members, which have no session, do not.
 */
export function sidebarOrder<T extends { key: string }>(rows: readonly SidebarRow<T>[]): T[] {
  const out: T[] = []
  const group = (row: GroupRow<T>) => {
    for (const child of row.children) group(child)
    for (const m of row.members) if (m.session) out.push(m.session)
  }
  for (const row of rows) {
    if (row.type === 'session') out.push(row.session)
    else group(row)
  }
  return out
}

/**
 * The session one step away from `current` in `order`, wrapping around at either end. With no
 * current session (or one not in the list) the first goes forward and the last goes back.
 */
export function stepSession(order: readonly string[], current: string | null | undefined, step: 1 | -1): string | null {
  if (!order.length) return null
  const at = current ? order.indexOf(current) : -1
  if (at < 0) return step === 1 ? order[0]! : order[order.length - 1]!
  return order[(at + step + order.length) % order.length]!
}

/** Whether a session asks for the user: the states the app badge counts (working ones do not). */
export function needsYou(s: AttentionInput): boolean {
  const level = statusLevel(s)
  return level !== null && level !== 'working'
}

/**
 * The next session after `current`, in sidebar order and wrapping around, that needs the user;
 * pressed again it cycles through all of them. Null when no other session needs the user.
 */
export function nextNeedingYou(order: readonly { id: string; attention: AttentionInput }[], current: string | null | undefined): string | null {
  const at = current ? order.findIndex((s) => s.id === current) : -1
  for (let i = 1; i <= order.length; i++) {
    const s = order[(at + i + order.length) % order.length]!
    if (s.id !== current && needsYou(s.attention)) return s.id
  }
  return null
}
