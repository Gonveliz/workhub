import type { SignInPrompt, SignInTool } from '@workhub/core'

/**
 * Where a sign-in stands: the tool's command is running (and its status is checked every few
 * seconds), the check said signed in, the command ended without a sign-in, the person cancelled,
 * or the command could not start (not installed).
 */
export type SignInPhase = 'running' | 'signedIn' | 'ended' | 'cancelled' | 'failed'

/** What the sign-in window shows above its terminal. */
export interface SignInView {
  tool: SignInTool
  /** The Claude account's name; empty for the default folder and the other tools. */
  accountName: string
  phase: SignInPhase
  /** The web address and one-time code read from the output, once printed. */
  prompt: SignInPrompt
  /** Why it could not start, for `failed`. */
  error?: string
}

/** What main sends a sign-in window (`signIn:event`). */
export type SignInEvent = { type: 'output'; data: string } | { type: 'view'; view: SignInView }

/** The sign-in window's own calls: its flow is named by the id in the window's hash (`#signin?id=…`). */
export interface SignInPaneApi {
  /** Starts the flow's command (once) and returns what to show; null for an unknown or finished flow. */
  attach(id: string): Promise<SignInView | null>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  /** Opens the address the flow printed through the link service, then types what the tool waits for (Enter for the GitHub CLI). */
  openBrowser(id: string): void
  /** Stops the process. */
  cancel(id: string): void
  onEvent(cb: (id: string, event: SignInEvent) => void): () => void
}

/** The window's hash for one flow. */
export const signInHash = (id: string): string => `#signin?id=${encodeURIComponent(id)}`

/** The flow id of a `#signin?id=…` hash, or null for another window. */
export function parseSignInHash(hash: string): string | null {
  if (!hash.startsWith('#signin?')) return null
  const id = new URLSearchParams(hash.slice('#signin?'.length)).get('id')
  return id || null
}
