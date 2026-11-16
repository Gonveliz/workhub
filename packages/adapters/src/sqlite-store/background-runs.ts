/**
 * The model runs Workhub starts by itself (the Slack watcher's reads, Listen summaries) as usage.
 * They leave no transcript, so the turn scan never reads them: each run becomes one row in `turns`
 * here, under a session of its own per kind and account whose agent is `BACKGROUND_AGENT`, which
 * the reports show as "Workhub background". A run is keyed by its id, so recording it twice
 * changes nothing.
 */
import { BACKGROUND_AGENT, backgroundSessionId, type BackgroundKind, type BackgroundSpend, type BackgroundSummary, type RunUsage } from '@workhub/core'
import type { WorkhubDb } from './db'
import { retentionState } from './retention'
import { refreshSessionTotals } from './turns'

export interface BackgroundRun {
  /** Unique per run: the turn's key. */
  id: string
  kind: BackgroundKind
  /** Epoch ms the run started. */
  at: number
  durationMs: number
  /** The Claude account it ran on; null for the default one. */
  accountId: string | null
  usage?: RunUsage
  /** Dollars the helper reported; unset leaves the turn unpriced. */
  costUsd?: number
  /** The model asked for, when the helper did not say which answered. */
  model?: string
}

/** Session titles, in English like the rest of the stored data (the renderer names the agent). */
const TITLE: Record<BackgroundKind, string> = { slackWatch: 'Slack watcher reads', listenSummary: 'Listen summaries' }

export class BackgroundRuns {
  constructor(private readonly db: WorkhubDb) {}

  /** Stores one run as one turn; returns false when it was already recorded (or the database is closed). */
  record(run: BackgroundRun): boolean {
    if (!this.db.isOpen) return false
    const sessionId = backgroundSessionId(run.kind, run.accountId)
    const u = run.usage
    const model = u?.model ?? run.model ?? null
    // A day already summed by the retention is not reopened (see retention.ts).
    if (run.at < retentionState(this.db).rolledUntil) return false
    return this.db.transaction(() => {
      const inserted = this.db.raw
        .prepare(
          `INSERT INTO turns (session_id, agent, msg_key, at, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, usd, cwd, project, turn_ms, sidechain)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 0) ON CONFLICT (session_id, msg_key) DO NOTHING`
        )
        .run(sessionId, BACKGROUND_AGENT, run.id, run.at, model, u?.inputTokens ?? 0, u?.outputTokens ?? 0, u?.cacheWriteTokens ?? 0, u?.cacheReadTokens ?? 0, run.costUsd ?? null, Math.max(0, Math.round(run.durationMs)))
      if (!Number(inserted.changes)) return false
      this.db.raw
        .prepare(
          `INSERT INTO sessions (id, agent, account_id, profile_id, cwd, title, started_at, ended_at, source, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 'workhub', ?)
           ON CONFLICT (id) DO UPDATE SET ended_at = MAX(COALESCE(sessions.ended_at, 0), excluded.ended_at), updated_at = excluded.updated_at`
        )
        // Never "still open": it ends with its latest run.
        .run(sessionId, BACKGROUND_AGENT, run.accountId, TITLE[run.kind], run.at, run.at, run.at)
      refreshSessionTotals(this.db, sessionId)
      return true
    })
  }

  /** A kind's runs, tokens and dollars since `todayStart` and since `weekStart` (epoch ms), every account together. */
  summary(kind: BackgroundKind, todayStart: number, weekStart: number): BackgroundSummary {
    const prefix = `${BACKGROUND_AGENT}:${kind}:`
    const spend = (since: number): BackgroundSpend => {
      if (!this.db.isOpen) return { runs: 0, tokens: 0, usd: 0 }
      const row = this.db.raw
        .prepare(
          `SELECT COUNT(*) AS runs, COALESCE(SUM(input_tokens + output_tokens + cache_write_tokens + cache_read_tokens), 0) AS tokens, TOTAL(usd) AS usd
           FROM turns WHERE agent = ? AND substr(session_id, 1, length(?)) = ? AND at >= ?`
        )
        .get(BACKGROUND_AGENT, prefix, prefix, since) as { runs: number; tokens: number; usd: number }
      return { runs: Number(row.runs), tokens: Number(row.tokens), usd: Number(row.usd) }
    }
    return { today: spend(todayStart), week: spend(weekStart) }
  }

  /** Every kind together since `since` (Home's token spend card). */
  total(since: number): BackgroundSpend {
    if (!this.db.isOpen) return { runs: 0, tokens: 0, usd: 0 }
    const row = this.db.raw
      .prepare(
        `SELECT COUNT(*) AS runs, COALESCE(SUM(input_tokens + output_tokens + cache_write_tokens + cache_read_tokens), 0) AS tokens, TOTAL(usd) AS usd
         FROM turns WHERE agent = ? AND at >= ?`
      )
      .get(BACKGROUND_AGENT, since) as { runs: number; tokens: number; usd: number }
    return { runs: Number(row.runs), tokens: Number(row.tokens), usd: Number(row.usd) }
  }
}
