// Sub-agents and background tasks reach the phone as live monitor updates, which only come on a
// change. After a (re)connect the phone reads them for every listed session in one call, so Home's
// sub-agent tree and a chat's activity rows are right even for work that started while it was away.
import type { AgentEvent } from '@workhub/core'
import { REMOTE_FEATURES, type RemoteActivityById } from '../shared/remote-api'

export interface ActivityClient {
  supports(feature: string): boolean
  transport: { invoke(channel: string, ...args: unknown[]): Promise<unknown> }
}

/** Reads the activity of `ids` and applies it as monitor updates; nothing from a desktop that does not offer it. */
export async function refreshActivity(client: ActivityClient, ids: readonly string[], apply: (e: AgentEvent) => void): Promise<void> {
  if (ids.length === 0 || !client.supports(REMOTE_FEATURES.activity)) return
  let byId: RemoteActivityById
  try {
    byId = (await client.transport.invoke('remote:activity', [...ids])) as RemoteActivityById
  } catch {
    return
  }
  if (!byId || typeof byId !== 'object') return
  for (const id of ids) {
    const a = byId[id]
    if (a) apply({ sessionId: id, type: 'monitor', snapshot: { subagents: a.subagents ?? [], backgroundTasks: a.backgroundTasks ?? [] } })
  }
}
