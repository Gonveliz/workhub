/**
 * Text written by other people (chat replies, calendar invites) that is typed into an agent
 * session. Agents there can run tools, so such text must read as quoted data, never as
 * instructions: it goes inside a fence, after a sentence saying so.
 */

/** The fence around untrusted text. */
const FENCE = '```'

/**
 * Untrusted text as a fenced block. Runs of backticks in the text that could close the fence are
 * replaced by apostrophes, and the text is cut to `max` characters (with an ellipsis).
 */
export function fenceUntrusted(text: string, max?: number): string {
  const cut = max !== undefined && text.length > max ? `${text.slice(0, max)}…` : text
  return `${FENCE}text\n${cut.replace(/`{3,}/g, (run) => "'".repeat(run.length)).trim()}\n${FENCE}`
}
