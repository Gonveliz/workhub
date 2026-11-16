/** What a quit that waits for the sessions to go idle will do once they do. */
export type QuitIntent = 'quit' | 'restart'

export interface QuitApi {
  /** The quit waiting for idle, or null when none waits. */
  pending(): Promise<QuitIntent | null>
  /** Stops waiting: the app stays open. */
  cancelPending(): Promise<void>
  onPending(cb: (intent: QuitIntent | null) => void): () => void
}
