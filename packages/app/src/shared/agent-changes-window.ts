// The hash route of the "Changes by agents" window, built by main and read by the renderer. There is
// one such window: opening it again brings the open one to the front.

export const AGENT_CHANGES_WINDOW_HASH = '#agent-changes'

export function isAgentChangesHash(hash: string): boolean {
  return hash === AGENT_CHANGES_WINDOW_HASH
}
