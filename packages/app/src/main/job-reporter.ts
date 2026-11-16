import { redactText } from '@workhub/core'
import { NULL_LOGGER, type Logger } from './log-file'

/** What `main.log` and the diagnostics export say of one background job. */
export interface JobStatus {
  name: string
  /** When the job last finished a run, well or not (epoch ms). */
  lastRunAt: number | null
  lastOkAt: number | null
  /** The error text of the latest failure, redacted and cut; cleared by the next success. */
  lastError: string | null
  /** Failures in the current streak (0 when the last run went well). */
  failures: number
}

/** Longest error text kept or logged. */
const ERROR_CHARS = 300

/**
 * One background job's health. Background ticks catch their errors and carry on, so a job that
 * silently stopped working cannot be told from one with nothing to do. The first failure of a
 * streak is logged, the next ones are only counted, and the recovery is logged with how long the
 * streak lasted. Only the error text is kept, redacted and cut: never what the job was reading.
 */
export class JobReporter {
  private lastRunAt: number | null = null
  private lastOkAt: number | null = null
  private lastError: string | null = null
  private failures = 0
  private since = 0

  constructor(
    readonly name: string,
    private readonly log: () => Logger,
    private readonly now: () => number = Date.now
  ) {}

  /** A run finished without failing. */
  ok(): void {
    const at = this.now()
    if (this.failures > 0) this.log().info(`job ${this.name} recovered after ${formatSpan(at - this.since)}, ${this.failures} failed ${this.failures === 1 ? 'run' : 'runs'}`)
    this.lastRunAt = this.lastOkAt = at
    this.lastError = null
    this.failures = 0
  }

  /** A run failed; only the first of a streak is logged. */
  failed(err: unknown): void {
    const at = this.now()
    this.lastRunAt = at
    this.lastError = errorText(err)
    if (this.failures === 0) {
      this.since = at
      this.log().warn(`job ${this.name} failed: ${this.lastError}`)
    }
    this.failures += 1
  }

  status(): JobStatus {
    return { name: this.name, lastRunAt: this.lastRunAt, lastOkAt: this.lastOkAt, lastError: this.lastError, failures: this.failures }
  }
}

/** The jobs of this process, by name, writing to one log once `attach` has given it. */
export class JobReports {
  private readonly jobs = new Map<string, JobReporter>()
  private logger: Logger = NULL_LOGGER

  constructor(private readonly now: () => number = Date.now) {}

  /** Where the first failure and the recovery lines go. */
  attach(log: Logger): void {
    this.logger = log
  }

  /** The reporter of a job, created on first use. */
  job(name: string): JobReporter {
    let job = this.jobs.get(name)
    if (!job) this.jobs.set(name, (job = new JobReporter(name, () => this.logger, this.now)))
    return job
  }

  table(): JobStatus[] {
    return [...this.jobs.values()].map((j) => j.status()).sort((a, b) => a.name.localeCompare(b.name))
  }
}

/** The reporters the app's jobs use. */
export const jobReports = new JobReports()

function errorText(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : typeof err === 'string' ? err : 'non-error thrown'
  return redactText(text.replace(/\s+/g, ' '), ERROR_CHARS)
}

function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}
