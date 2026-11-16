/**
 * Recalling a session's earlier prompts in the composer, as a shell does: ↑ goes back, ↓ comes
 * forward, Esc puts back what was being typed. The prompts are the session's own user messages
 * (its chat, rebuilt from main's journal), newest first.
 */

/** How many earlier prompts the composer recalls. */
export const PROMPT_HISTORY_LIMIT = 50

/** While browsing: which prompt is shown (0 is the newest) and the draft it replaced. Null: not browsing. */
export type PromptHistoryState = { index: number; draft: string } | null

export type PromptHistoryKey = 'up' | 'down' | 'escape'

/** The session's prompts, newest first: no empty ones, a prompt sent twice in a row once, at most `limit`. */
export function promptHistory(items: readonly { kind: string; text?: string }[], limit = PROMPT_HISTORY_LIMIT): string[] {
  const out: string[] = []
  for (let i = items.length - 1; i >= 0 && out.length < limit; i--) {
    const item = items[i]!
    if (item.kind !== 'user') continue
    const text = item.text?.trim()
    if (text && out[out.length - 1] !== text) out.push(text)
  }
  return out
}

/** Whether the caret sits on the text's first line (↑ there leaves the text), or on its last (↓). */
export const onFirstLine = (text: string, caret: number): boolean => !text.slice(0, caret).includes('\n')
export const onLastLine = (text: string, caret: number): boolean => !text.slice(caret).includes('\n')

/**
 * What a key does to the composer: the next state and the text to show, or null when the key is
 * not for the history (the textarea handles it: moving between lines, Esc interrupting).
 * ↑ starts browsing only from the caret on the first line; ↓ and Esc act only while browsing.
 */
export function historyKey(state: PromptHistoryState, key: PromptHistoryKey, prompts: readonly string[], text: string, caret: number): { state: PromptHistoryState; text: string } | null {
  if (key === 'up') {
    if (!onFirstLine(text, caret)) return null
    const index = state ? state.index + 1 : 0
    if (index >= prompts.length) return null
    return { state: { index, draft: state ? state.draft : text }, text: prompts[index]! }
  }
  if (!state) return null
  if (key === 'escape') return { state: null, text: state.draft }
  if (!onLastLine(text, caret)) return null
  if (state.index === 0) return { state: null, text: state.draft }
  return { state: { index: state.index - 1, draft: state.draft }, text: prompts[state.index - 1]! }
}
