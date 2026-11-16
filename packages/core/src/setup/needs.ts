/**
 * Which setup rows are needed, from the goal and the choices in the config. Everything else stays
 * in the check as optional: shown, never counted as a problem.
 */
import type { WorkhubConfig } from '../config/schema'
import type { AgentDefinition } from '../domain/agent'
import { BUILTIN_AGENTS } from '../domain/builtin-agents'
import type { SetupItem, SetupItemId } from './checks'
import { DEFAULT_SETUP_GOAL, goalIncludesCode, type SetupGoal } from './goal'

type NeedsConfig = Pick<WorkhubConfig, 'profiles' | 'connections' | 'accounts' | 'options'>

/** The stored goal, `both` until the person picks one. */
export function setupGoal(config: Pick<WorkhubConfig, 'options'>): SetupGoal {
  return config.options?.setupGoal ?? DEFAULT_SETUP_GOAL
}

export interface SetupNeeds {
  goal: SetupGoal
  /** Agent ids chosen: a profile offers or prefers them, or an account belongs to them. Claude when none is. */
  agents: string[]
  /** Code hosts a profile uses (`github`, `gitlab`), only for the code goal. */
  codeHosts: string[]
  /** git, for the code goal. */
  git: boolean
  /** Names of the chosen agents that run on an installed Node.js; empty: Node is not needed. */
  node: string[]
  /** A profile tracks tickets in Linear, for the code goal. */
  linear: boolean
}

/** Agents that run on Node.js even when installed on their own (an npm package); `npx` ones are found by command. */
const NODE_AGENTS = new Set(['gemini', 'claude-acp'])

const runsOnNode = (agent: Pick<AgentDefinition, 'id' | 'command'>): boolean => NODE_AGENTS.has(agent.id) || ['npx', 'node', 'npm'].includes(agent.command)

/** What the person's goal and choices need. `agents` are the known agents (built-in ones by default) for names and commands. */
export function setupNeeds(config: NeedsConfig, agents: readonly AgentDefinition[] = BUILTIN_AGENTS): SetupNeeds {
  const goal = setupGoal(config)
  const code = goalIncludesCode(goal)
  const chosen = new Set<string>()
  for (const profile of config.profiles) {
    for (const id of profile.agentIds ?? []) chosen.add(id)
    const first = profile.preferredAgents?.[0]
    if (first) chosen.add(first.split(':')[0]!)
    for (const accountId of profile.accountIds) {
      const account = config.accounts.find((a) => a.id === accountId)
      if (account) chosen.add(account.agentId)
    }
  }
  for (const account of config.accounts) chosen.add(account.agentId)
  // The plain shell needs nothing; a new session takes Claude first when nothing else is chosen.
  chosen.delete('shell')
  if (chosen.size === 0) chosen.add('claude')

  const hosts = new Set<string>()
  let linear = false
  if (code) {
    for (const profile of config.profiles) {
      const byId = (id: string | undefined) => (id ? config.connections.find((c) => c.id === id) : undefined)
      const host = byId(profile.connections.codeHost)
      if (host && (host.provider === 'github' || host.provider === 'gitlab')) hosts.add(host.provider)
      const tracker = byId(profile.connections.tracker)
      // GitHub Issues are read through gh as well.
      if (tracker?.provider === 'github-issues') hosts.add('github')
      if (tracker?.provider === 'linear') linear = true
    }
  }
  const node = [...chosen].flatMap((id) => {
    const agent = agents.find((a) => a.id === id)
    return agent && runsOnNode(agent) ? [agent.name] : []
  })
  return { goal, agents: [...chosen], codeHosts: [...hosts], git: code, node, linear }
}

/** Whether a row of this kind is needed. Claude's rows follow either Claude engine; the profile is always needed. */
export function isNeeded(kind: SetupItemId, needs: SetupNeeds): boolean {
  switch (kind) {
    case 'claudeCode':
    case 'claudeSignIn':
      return needs.agents.includes('claude') || needs.agents.includes('claude-acp')
    case 'codex':
    case 'kiro':
    case 'opencode':
    case 'gemini':
      return needs.agents.includes(kind)
    case 'node':
      return needs.node.length > 0
    case 'git':
      return needs.git
    case 'github':
    case 'gitlab':
      return needs.codeHosts.includes(kind)
    case 'linear':
      return needs.linear
    case 'profile':
      return true
    default:
      return false
  }
}

/** The rows with `optional` set from what is needed. */
export function applyNeeds(items: readonly SetupItem[], needs: SetupNeeds): SetupItem[] {
  return items.map((i) => ({ ...i, optional: !isNeeded(i.kind, needs) }))
}

/** The setup row of an agent (what New session offers to install), or null for one the check has no row for. */
export function agentSetupKind(agentId: string): Extract<SetupItemId, 'claudeCode' | 'codex' | 'kiro' | 'opencode' | 'gemini'> | null {
  if (agentId === 'claude') return 'claudeCode'
  return agentId === 'codex' || agentId === 'kiro' || agentId === 'opencode' || agentId === 'gemini' ? agentId : null
}
