import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { AutomationsSnapshot, SlackSnapshot } from '@shared/chat-api'
import type { SessionRequest } from '@shared/session-requests-api'
import type { AgentChange } from '@shared/agent-changes-api'

/** The Slack watcher's and the automations' snapshots, and the agents' session requests, pushed by the main process. */
function liveSnapshot<T>(load: () => Promise<T>, subscribe: (cb: (s: T) => void) => () => void) {
  let value: T | null = null
  let started = false
  const listeners = new Set<() => void>()
  const set = (next: T) => {
    value = next
    for (const l of listeners) l()
  }
  const start = () => {
    if (started) return
    started = true
    subscribe(set)
    void load().then(set, () => undefined)
  }
  return {
    reload: () => load().then(set, () => undefined),
    use(): T | null {
      useEffect(start, [])
      return useSyncExternalStore(
        (l) => {
          listeners.add(l)
          return () => listeners.delete(l)
        },
        () => value
      )
    }
  }
}

const slack = liveSnapshot<SlackSnapshot>(
  () => window.hub.slack.get(),
  (cb) => window.hub.slack.onChanged(cb)
)
const automations = liveSnapshot<AutomationsSnapshot>(
  () => window.hub.automations.get(),
  (cb) => window.hub.automations.onChanged(cb)
)

const sessionRequests = liveSnapshot<SessionRequest[]>(
  () => window.hub.sessionRequests.list(),
  (cb) => window.hub.sessionRequests.onChanged(cb)
)

export const useSlack = () => slack.use()
export const reloadSlack = () => slack.reload()
export const useAutomations = () => automations.use()
export const reloadAutomations = () => automations.reload()

const NO_REQUESTS: SessionRequest[] = []
/** What agents asked of other sessions, waiting for the user: all of them, or those one session made. */
export function useSessionRequests(fromSessionId?: string): SessionRequest[] {
  const all = sessionRequests.use() ?? NO_REQUESTS
  return useMemo(() => (fromSessionId === undefined ? all : all.filter((r) => r.fromSessionId === fromSessionId)), [all, fromSessionId])
}

const agentChanges = liveSnapshot<AgentChange[]>(
  () => window.hub.agentChanges.list(),
  (cb) => window.hub.agentChanges.onChanged(cb)
)
const NO_CHANGES: AgentChange[] = []
/** What agents changed of Workhub's objects and the user has not kept or reverted yet, newest first. */
export const useAgentChanges = (): AgentChange[] => agentChanges.use() ?? NO_CHANGES
