// TranscriptReaders over the host: the readers run where the agents write their transcripts.
import { z } from 'zod'
import type { SessionMonitorSnapshot, SubagentConversation, TranscriptQuery, TranscriptReader } from '@workhub/core'
import type { HostClient } from '../client'
import { HostHandlerError, type HostHandlers } from '../server'
import { objectLike, parseParams, parseResult } from './shared'

const transcriptQuery = z.looseObject({
  agentSessionId: z.string().min(1),
  cwd: z.string(),
  configDir: z.string().optional(),
  ticketPrefixes: z.array(z.string()).optional()
})

const readParams = z.object({ reader: z.string(), query: transcriptQuery })
const forgetParams = z.object({ reader: z.string(), agentSessionId: z.string() })
const subagentParams = z.object({ reader: z.string(), query: transcriptQuery, subagentId: z.string().min(1) })

const describeResult = z.array(z.object({ id: z.string(), subagent: z.boolean() }))
const snapshotResult = objectLike<SessionMonitorSnapshot>().nullable()
const conversationResult = objectLike<SubagentConversation>().nullable()

/** Host side: `transcripts.*` for these readers, picked per call by `reader` (their `id`). */
export function transcriptReaderHandlers(readers: readonly TranscriptReader[]): HostHandlers {
  const byId = new Map(readers.map((r) => [r.id, r]))
  const pick = (id: string, method: string): TranscriptReader => {
    const reader = byId.get(id)
    if (!reader) throw new HostHandlerError('bad_params', `${method}: no transcript reader "${id}"`)
    return reader
  }
  return {
    'transcripts.describe': () => readers.map((r) => ({ id: r.id, subagent: typeof r.subagent === 'function' })),
    'transcripts.read': async (params) => {
      const p = parseParams(readParams, params, 'transcripts.read')
      return (await pick(p.reader, 'transcripts.read').read(p.query as TranscriptQuery)) ?? null
    },
    'transcripts.exists': async (params) => {
      const p = parseParams(readParams, params, 'transcripts.exists')
      return (await pick(p.reader, 'transcripts.exists').exists(p.query as TranscriptQuery)) === true
    },
    'transcripts.forget': (params) => {
      const p = parseParams(forgetParams, params, 'transcripts.forget')
      pick(p.reader, 'transcripts.forget').forget(p.agentSessionId)
      return null
    },
    'transcripts.subagent': async (params) => {
      const p = parseParams(subagentParams, params, 'transcripts.subagent')
      const reader = pick(p.reader, 'transcripts.subagent')
      if (!reader.subagent) throw new HostHandlerError('bad_params', `transcripts.subagent: reader "${p.reader}" has no subagents`)
      return (await reader.subagent(p.query as TranscriptQuery, p.subagentId)) ?? null
    }
  }
}

export interface RemoteTranscriptOptions {
  /** Request timeout for reads (a first read of a long transcript parses the whole file). */
  timeoutMs?: number
  /** `forget` returns nothing; a failure to reach the host is reported here. */
  onError?: (err: unknown) => void
}

class RemoteTranscriptReader implements TranscriptReader {
  subagent?: (query: TranscriptQuery, subagentId: string) => Promise<SubagentConversation | null>

  constructor(
    private readonly client: HostClient,
    readonly id: string,
    hasSubagents: boolean,
    private readonly options: RemoteTranscriptOptions
  ) {
    // Only when the host's reader has it: callers test `reader.subagent` before using it.
    if (hasSubagents) {
      this.subagent = async (query, subagentId) =>
        parseResult(conversationResult, await this.call('transcripts.subagent', { query, subagentId }), 'transcripts.subagent')
    }
  }

  async read(query: TranscriptQuery): Promise<SessionMonitorSnapshot | null> {
    return parseResult(snapshotResult, await this.call('transcripts.read', { query }), 'transcripts.read')
  }

  async exists(query: TranscriptQuery): Promise<boolean> {
    return parseResult(z.boolean(), await this.call('transcripts.exists', { query }), 'transcripts.exists')
  }

  forget(agentSessionId: string): void {
    this.call('transcripts.forget', { agentSessionId }).catch((err: unknown) => this.options.onError?.(err))
  }

  private call(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.client.request(method, { reader: this.id, ...params }, { timeoutMs: this.options.timeoutMs })
  }
}

/** App side: one TranscriptReader per reader the host serves, in the host's order. */
export async function connectRemoteTranscriptReaders(client: HostClient, options: RemoteTranscriptOptions = {}): Promise<TranscriptReader[]> {
  const described = parseResult(describeResult, await client.request('transcripts.describe'), 'transcripts.describe')
  return described.map((d) => new RemoteTranscriptReader(client, d.id, d.subagent, options))
}
