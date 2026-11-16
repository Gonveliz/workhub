/**
 * Model runs Workhub starts by itself, outside any session (the Slack watcher's reads, the chat's
 * Listen summaries). They leave no transcript, so the transcript scan never sees them: each run is
 * recorded as one turn of its own, under the agent family below, so the usage reports and Home can
 * show it as "Workhub background".
 */

/** The `sessions.agent` (spend agent family) of every background run. */
export const BACKGROUND_AGENT = 'workhub-background'

/** What started a background run. */
export type BackgroundKind = 'slackWatch' | 'listenSummary'

/** The tokens one run used, as the helper reported them. */
export interface RunUsage {
  /** The model that answered, when the helper said. */
  model?: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
}

/** All four kinds of tokens of a run. */
export function runTokens(usage: RunUsage | undefined): number {
  return usage ? usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens + usage.cacheReadTokens : 0
}

/**
 * The session a background run is counted under: one per kind and Claude account, so the reports
 * can group them by account too. Never an agent's own session id.
 */
export function backgroundSessionId(kind: BackgroundKind, accountId: string | null): string {
  return `${BACKGROUND_AGENT}:${kind}:${accountId ?? 'default'}`
}

/** Runs, tokens (all four kinds) and dollars over a span. */
export interface BackgroundSpend {
  runs: number
  tokens: number
  usd: number
}

/** A kind's spend today (since local midnight) and over the last 7 days, today included. */
export interface BackgroundSummary {
  today: BackgroundSpend
  week: BackgroundSpend
}

export const EMPTY_BACKGROUND_SPEND: BackgroundSpend = { runs: 0, tokens: 0, usd: 0 }
