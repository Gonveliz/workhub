/**
 * The usage of the model runs Workhub starts by itself (the Slack watcher's reads, Listen
 * summaries): each run is stored as one turn (see `BackgroundRuns`), so the Usage screen counts it
 * as "Workhub background", and summed for the Slack screen and Home's token spend card.
 */
import { randomUUID } from 'node:crypto'
import { SPEND_DAYS, startOfLocalDay, type BackgroundKind, type BackgroundSpend, type BackgroundSummary, type RunUsage } from '@workhub/core'
import type { BackgroundRuns } from '@workhub/adapters/sqlite-store'

/** What one finished run reports; `id` defaults to a new one (a run is recorded once). */
export interface BackgroundRunReport {
  id?: string
  kind: BackgroundKind
  accountId: string | null
  /** Epoch ms it started. */
  at: number
  durationMs: number
  usage?: RunUsage
  costUsd?: number
  /** The model asked for, in case the helper did not say which answered. */
  model?: string
}

export interface BackgroundUsage {
  /** Stores a run; a failure is logged, never thrown (the caller's work goes on). */
  record(run: BackgroundRunReport): void
  /** A kind's spend today and over the last 7 days. */
  summary(kind: BackgroundKind): BackgroundSummary
  /** Every kind over the last 7 days (Home). */
  week(): BackgroundSpend
}

export function backgroundUsage(runs: BackgroundRuns, options: { log?: (message: string) => void; now?: () => number } = {}): BackgroundUsage {
  const now = options.now ?? Date.now
  return {
    record(run) {
      try {
        runs.record({
          id: run.id ?? randomUUID(),
          kind: run.kind,
          at: run.at,
          durationMs: run.durationMs,
          accountId: run.accountId,
          ...(run.usage ? { usage: run.usage } : {}),
          ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
          ...(run.model ? { model: run.model } : {})
        })
      } catch (err) {
        options.log?.(`background run not recorded: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    summary(kind) {
      const t = now()
      return runs.summary(kind, startOfLocalDay(t), startOfLocalDay(t, SPEND_DAYS - 1))
    },
    week() {
      return runs.total(startOfLocalDay(now(), SPEND_DAYS - 1))
    }
  }
}
