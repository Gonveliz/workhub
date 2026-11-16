// The automations screen's data: the desktop answers a page at a time (`remote:automations`), and
// the screen wants the whole list (a profile has a handful), so the pages are joined here.
import type { RemoteAutomation, RemotePage } from '../shared/remote-api'

export const AUTOMATIONS_PAGE_LIMIT = 50
/** A desktop with more pages than this is not one the phone follows to the end. */
const MAX_PAGES = 20

export async function loadAutomations(read: (request: { limit: number; cursor?: string }) => Promise<RemotePage<RemoteAutomation>>): Promise<RemoteAutomation[]> {
  const all: RemoteAutomation[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await read(cursor ? { limit: AUTOMATIONS_PAGE_LIMIT, cursor } : { limit: AUTOMATIONS_PAGE_LIMIT })
    for (const row of page?.items ?? []) {
      // A row can come twice when the list moved between pages.
      if (seen.has(row.id)) continue
      seen.add(row.id)
      all.push(row)
    }
    if (typeof page?.nextCursor !== 'string') break
    cursor = page.nextCursor
  }
  return all
}
