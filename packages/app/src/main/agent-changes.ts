/**
 * The changes agents make to Workhub's own objects through the control endpoint (automations, flow
 * maps and their alert limits, milestones applied without asking, inbox items), kept in a small
 * journal (the `agent-changes` key of `kv_state`) until the user keeps or reverts each one on Home.
 *
 * Every entry holds the changed fields before and after, capped; a value that is too long or looks
 * like a secret is kept shortened and is never restored. A revert puts the "before" values back
 * through the service the UI uses, and only when the object still has the values the agent left.
 * A flow map's new alert limits are held: the map is saved with its old limits, and the new ones
 * take effect when the user keeps the change. Marking a change as reviewed is not offered to agents
 * nor to paired devices: there is no endpoint for it.
 */
import { createHash, randomUUID } from 'node:crypto'
import { parseFlowMap, type AutomationDefinition, type InboxItem, type Milestone, type Result, type StateStore, type WorkhubConfig } from '@workhub/core'
import type { AgentChange, AgentChangeAnswer, AgentChangeKind } from '../shared/agent-changes-api'
import type { ControlCaller } from './control-auth'
import type { ControlDeps, ControlReply } from './control-server'
import { deleteFlowMap, saveFlowMap, setFlowMapAlerts, type FlowMapRows, type SaveFlowMapResult } from './flow-maps'
import type { IpcRegistrar } from './ipc-guard'

/** How much the journal keeps: entries in all, fields per entry, characters of one value's JSON and of a name. */
export const AGENT_CHANGE_CAPS = { entries: 200, fields: 40, value: 2000, preview: 200, name: 200 } as const

/** Fields that only say who changed what when: never shown, compared nor restored. */
const BOOKKEEPING = ['updatedAt', 'updatedBy', 'createdAt']
/** A name that says its value is a secret, at any depth. */
const SECRET_NAME = /(secret|token|passw(?:or)?d|credential|authorization|api[-_]?key)/i
/** Strings that look like a credential whatever their name (the prefixes `redact.ts` masks). */
const SECRET_VALUE = [/\b(xox[abposr]-|xapp-)[\w-]+/i, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bglpat-[\w-]{10,}/, /\bsk-[\w-]{10,}/, /\bbearer\s+[\w.~+/=-]{8,}/i, /:\/\/[^\s/@:]+:[^\s/@]+@/]

export interface AgentChangeState {
  entries: AgentChange[]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** JSON with object keys sorted, so two equal values always give the same text. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : stableJson(v))).join(',')}]`
  if (isObj(value))
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(',')}}`
  return value === undefined ? 'null' : JSON.stringify(value)
}

/** The digest of some fields of an object (missing fields count as missing): what a revert compares. */
export function fieldsDigest(obj: Obj | null | undefined, fields: readonly string[]): string {
  const picked: Obj = {}
  if (obj) for (const f of fields) if (obj[f] !== undefined) picked[f] = obj[f]
  return createHash('sha256').update(stableJson(obj ? picked : null)).digest('hex').slice(0, 32)
}

/** Whether a value holds something that looks like a secret: a secret-like name or a credential-like string. */
function looksSecret(value: unknown, key = ''): boolean {
  if (typeof value === 'string') return (SECRET_NAME.test(key) && value.length > 0) || SECRET_VALUE.some((p) => p.test(value))
  if (Array.isArray(value)) return value.some((v) => looksSecret(v, key))
  if (isObj(value)) return Object.entries(value).some(([k, v]) => looksSecret(v, k))
  return false
}

/** A value as the journal keeps it: as is, or a short preview (and `cut`) when it is long or looks secret. */
function compact(field: string, value: unknown): { value: unknown; cut: boolean } {
  if (looksSecret(value, field)) return { value: '[redacted]', cut: true }
  const json = JSON.stringify(value) ?? ''
  if (json.length <= AGENT_CHANGE_CAPS.value) return { value, cut: false }
  return { value: `${json.slice(0, AGENT_CHANGE_CAPS.preview)}…`, cut: true }
}

const capText = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export interface RecordInput {
  kind: AgentChangeKind
  object: { id: string; name: string }
  /** The object before (null: it did not exist) and as the agent asked it (null: deleted). */
  before: Obj | null
  after: Obj | null
  /** The object as stored now, when it differs from `after` (held fields); `after` otherwise. */
  stored?: Obj | null
  /** Fields saved but not in effect yet. */
  held?: string[]
  session?: AgentChange['session']
  profileId?: string | null
}

export interface AgentChangeJournalDeps {
  store: StateStore<AgentChangeState>
  changed?: (unreviewed: AgentChange[]) => void
  now?: () => number
  newId?: () => string
}

/** The append-only journal of agents' changes; entries are only marked reviewed, and the oldest go past the cap. */
export class AgentChangeJournal {
  private entries: AgentChange[]
  private readonly now: () => number
  private readonly newId: () => string

  constructor(private readonly deps: AgentChangeJournalDeps) {
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? randomUUID
    const loaded = deps.store.load({ entries: [] })
    this.entries = Array.isArray(loaded.entries) ? loaded.entries.filter((e) => isObj(e) && typeof e.id === 'string') : []
  }

  /** Records a change; null when no field changed. */
  record(input: RecordInput): AgentChange | null {
    const before = input.before ?? {}
    const after = input.after ?? {}
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !BOOKKEEPING.includes(k))
    const fields = keys.filter((k) => stableJson(before[k]) !== stableJson(after[k])).slice(0, AGENT_CHANGE_CAPS.fields)
    if (fields.length === 0) return null
    const cut = new Set<string>()
    const side = (obj: Obj) => {
      const out: Obj = {}
      for (const f of fields) {
        if (obj[f] === undefined) continue
        const c = compact(f, obj[f])
        out[f] = c.value
        if (c.cut) cut.add(f)
      }
      return out
    }
    const action = input.before === null ? 'create' : input.after === null ? 'delete' : 'update'
    // A field past the cap is still changed: the entry cannot be restored in full.
    if (keys.filter((k) => stableJson(before[k]) !== stableJson(after[k])).length > fields.length) cut.add('…')
    const held = (input.held ?? []).filter((f) => fields.includes(f))
    const entry: AgentChange = {
      id: this.newId(),
      at: this.now(),
      ...(input.session ? { session: input.session } : {}),
      ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
      kind: input.kind,
      action,
      object: { id: input.object.id, name: capText(input.object.name || input.object.id, AGENT_CHANGE_CAPS.name) },
      fields,
      before: side(before),
      after: side(after),
      ...(cut.size ? { cut: [...cut] } : {}),
      ...(held.length ? { held } : {}),
      check: fieldsDigest(input.stored === undefined ? input.after : input.stored, fields)
    }
    this.entries.push(entry)
    this.trim()
    this.persist()
    return entry
  }

  get(id: string): AgentChange | undefined {
    return this.entries.find((e) => e.id === id)
  }

  /** The changes not reviewed yet, newest first. */
  unreviewed(): AgentChange[] {
    // Entries are appended in order, so the newest is last (two changes in the same millisecond too).
    return this.entries.filter((e) => !e.reviewed).reverse()
  }

  markReviewed(id: string, outcome: 'kept' | 'reverted'): void {
    const e = this.get(id)
    if (!e || e.reviewed) return
    e.reviewed = { at: this.now(), outcome }
    this.persist()
  }

  /** Over the cap, reviewed entries go first, oldest first; then the oldest unreviewed ones. */
  private trim(): void {
    let over = this.entries.length - AGENT_CHANGE_CAPS.entries
    if (over <= 0) return
    const drop = new Set<string>()
    for (const pass of [(e: AgentChange) => !!e.reviewed, () => true]) {
      for (const e of this.entries) {
        if (over <= 0) break
        if (drop.has(e.id) || !pass(e)) continue
        drop.add(e.id)
        over--
      }
    }
    this.entries = this.entries.filter((e) => !drop.has(e.id))
  }

  private persist(): void {
    this.deps.store.save({ entries: this.entries })
    this.deps.store.flush()
    this.deps.changed?.(this.unreviewed())
  }
}

/** Where the journal reads objects as they are now, and how it writes them back (the services the UI uses). */
export interface AgentChangeTargets {
  automations: {
    get(id: string): AutomationDefinition | undefined
    save(automation: AutomationDefinition): Promise<Result<WorkhubConfig>>
    remove(id: string): Promise<Result<WorkhubConfig>>
  }
  flowMaps: FlowMapRows
  planner: {
    findMilestone(id: string): { profileId: string; milestone: Milestone } | undefined
    findItem(id: string): { profileId: string; item: InboxItem } | undefined
    saveMilestone(profileId: string, milestone: Milestone): Promise<{ ok: true } | { ok: false; error: string }>
    deleteMilestone(profileId: string, id: string): Promise<{ ok: true } | { ok: false; error: string }>
    restoreItem(profileId: string, item: InboxItem): Promise<{ ok: true } | { ok: false; error: string }>
    act(profileId: string, id: string, action: 'discard'): Promise<{ ok: true } | { ok: false; error: string }>
  }
  /** A session's name, its agent's name and its profile, while it is open. */
  session(id: string): { name?: string; agent?: string; profileId?: string | null } | undefined
}

/** A stored flow map as an object, or null (none, not JSON). */
function storedMap(rows: FlowMapRows, id: string): Obj | null {
  try {
    const text = rows.get(id)
    const parsed = text === null ? null : (JSON.parse(text) as unknown)
    return isObj(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** The object a change is about, as it is now (null when it does not exist). */
function current(t: AgentChangeTargets, kind: AgentChangeKind, id: string): Obj | null {
  switch (kind) {
    case 'automation':
      return (t.automations.get(id) as unknown as Obj | undefined) ?? null
    case 'flowMap':
      return storedMap(t.flowMaps, id)
    case 'milestone':
      return (t.planner.findMilestone(id)?.milestone as unknown as Obj | undefined) ?? null
    case 'inboxItem':
      return (t.planner.findItem(id)?.item as unknown as Obj | undefined) ?? null
  }
}

/** `base` with the change's fields set to `values` (a field missing there is removed). */
function withFields(base: Obj, fields: readonly string[], values: Obj): Obj {
  const out: Obj = { ...base }
  for (const f of fields) {
    if (values[f] === undefined) delete out[f]
    else out[f] = values[f]
  }
  return out
}

const failed = (r: { ok: boolean; error?: string; issues?: { message: string }[] }): AgentChangeAnswer => ({ ok: false, error: 'failed', detail: r.error ?? r.issues?.map((i) => i.message).join('; ') ?? '' })
const flowFailed = (r: SaveFlowMapResult): AgentChangeAnswer => ({ ok: false, error: 'failed', detail: r.ok ? '' : r.errors.join('; ') })

/** Whether the object still has what the agent left (for a delete: it is still gone). */
function unchangedSince(entry: AgentChange, now: Obj | null): boolean {
  if (entry.action === 'delete') return now === null
  return now !== null && fieldsDigest(now, entry.fields) === entry.check
}

/** Keep: marks the change reviewed; held fields (a flow map's limits) are written first, if nothing changed them since. */
export async function keepAgentChange(journal: AgentChangeJournal, t: AgentChangeTargets, id: string): Promise<AgentChangeAnswer> {
  const entry = journal.get(id)
  if (!entry || entry.reviewed) return { ok: false, error: 'gone' }
  if (entry.held?.length && entry.kind === 'flowMap') {
    const now = current(t, entry.kind, entry.object.id)
    if (!now) return { ok: false, error: 'gone' }
    if (!unchangedSince(entry, now)) return { ok: false, error: 'changed' }
    if (entry.held.some((f) => entry.cut?.includes(f))) return { ok: false, error: 'cut' }
    const alerts = entry.after['alerts']
    const r = setFlowMapAlerts(t.flowMaps, entry.object.id, (isObj(alerts) ? alerts : null) as Parameters<typeof setFlowMapAlerts>[2])
    if (!r.ok) return flowFailed(r)
  }
  journal.markReviewed(id, 'kept')
  return { ok: true }
}

/** Revert: puts the "before" values back through the services the UI uses, refusing when the object changed since. */
export async function revertAgentChange(journal: AgentChangeJournal, t: AgentChangeTargets, id: string): Promise<AgentChangeAnswer> {
  const entry = journal.get(id)
  if (!entry || entry.reviewed) return { ok: false, error: 'gone' }
  const now = current(t, entry.kind, entry.object.id)
  if (entry.action !== 'delete' && now === null) return { ok: false, error: 'gone' }
  if (!unchangedSince(entry, now)) return { ok: false, error: 'changed' }
  // Held fields never took effect: their "before" is what is stored, so a cut one does not matter.
  if (entry.cut?.some((f) => !entry.held?.includes(f))) return { ok: false, error: 'cut' }
  const answer = await restore(entry, now, t)
  if (answer.ok) journal.markReviewed(id, 'reverted')
  return answer
}

async function restore(entry: AgentChange, now: Obj | null, t: AgentChangeTargets): Promise<AgentChangeAnswer> {
  const objectId = entry.object.id
  const back = withFields(now ?? {}, entry.fields, entry.before)
  switch (entry.kind) {
    case 'automation': {
      const r = entry.action === 'create' ? await t.automations.remove(objectId) : await t.automations.save(back as unknown as AutomationDefinition)
      return r.ok ? { ok: true } : failed(r)
    }
    case 'flowMap': {
      if (entry.action === 'create') return deleteFlowMap(t.flowMaps, objectId) ? { ok: true } : { ok: false, error: 'gone' }
      const r = saveFlowMap(t.flowMaps, back)
      return r.ok ? { ok: true } : flowFailed(r)
    }
    case 'milestone': {
      const profileId = t.planner.findMilestone(objectId)?.profileId ?? entry.profileId
      if (!profileId) return { ok: false, error: 'gone' }
      const r = entry.action === 'create' ? await t.planner.deleteMilestone(profileId, objectId) : await t.planner.saveMilestone(profileId, back as unknown as Milestone)
      return r.ok ? { ok: true } : failed(r)
    }
    case 'inboxItem': {
      const found = t.planner.findItem(objectId)
      if (!found) return { ok: false, error: 'gone' }
      // A proposed item is discarded, as the user would on the Plan screen; an edited one gets its fields back.
      const r = entry.action === 'create' ? await t.planner.act(found.profileId, objectId, 'discard') : await t.planner.restoreItem(found.profileId, back as unknown as InboxItem)
      return r.ok ? { ok: true } : failed(r)
    }
  }
}

/** A flow map written in memory only: to see what `saveFlowMap` would store without storing it. */
function scratchRows(id: string, text: string | null): FlowMapRows & { text: string | null } {
  const rows = {
    text,
    list: () => (rows.text === null ? [] : [{ id, json: rows.text }]),
    get: (key: string) => (key === id ? rows.text : null),
    put: (_key: string, json: string) => void (rows.text = json),
    remove: () => false
  }
  return rows
}

/**
 * Saves a flow map an agent posted (`POST /v1/flow-maps`) and records it. New alert limits are held:
 * the map is stored with the limits it had, and the new ones wait for the user's "Keep". When the
 * old limits no longer fit the redrawn map, the map is stored as asked and the limits apply now.
 */
export function saveAgentFlowMap(rows: FlowMapRows, input: unknown, journal: AgentChangeJournal, who: Pick<RecordInput, 'session' | 'profileId'>): SaveFlowMapResult & { note?: string } {
  const id = isObj(input) && typeof input['id'] === 'string' ? input['id'] : null
  let beforeText: string | null = null
  try {
    beforeText = id ? rows.get(id) : null
  } catch {
    beforeText = null
  }
  const scratch = scratchRows(id ?? '', beforeText)
  const asked = saveFlowMap(scratch, input, { keepAlerts: true })
  if (!asked.ok || !id || scratch.text === null) return asked
  const before = storedMap(rows, id)
  const after = JSON.parse(scratch.text) as Obj
  let stored = after
  let text = scratch.text
  let held: string[] = []
  if (stableJson(after['alerts']) !== stableJson(before?.['alerts'])) {
    const parsed = parseFlowMap(withFields(after, ['alerts'], before ?? {}))
    if (parsed.ok) {
      text = JSON.stringify(parsed.map, null, 2) + '\n'
      stored = JSON.parse(text) as Obj
      held = ['alerts']
    }
  }
  rows.put(id, text)
  journal.record({ kind: 'flowMap', object: { id, name: typeof after['name'] === 'string' ? after['name'] : id }, before, after, stored, held, ...who })
  return held.length ? { ...asked, note: 'The new alert limits wait for the user: they take effect once the user keeps this change on Home.' } : asked
}

/** The session of a request and its name, agent and profile; the session is the caller's (bound by its token). */
function whoOf(t: AgentChangeTargets, session: unknown): Pick<RecordInput, 'session' | 'profileId'> {
  if (typeof session !== 'string' || !session) return {}
  const s = t.session(session)
  return {
    session: { id: session, ...(s?.name ? { name: capText(s.name, AGENT_CHANGE_CAPS.name) } : {}), ...(s?.agent ? { agent: capText(s.agent, AGENT_CHANGE_CAPS.name) } : {}) },
    ...(s && s.profileId !== undefined ? { profileId: s.profileId } : {})
  }
}

const sessionOf = (body: unknown) => (isObj(body) ? body['session'] : undefined)
const okReply = (r: ControlReply) => r.status >= 200 && r.status < 300 && r.body['ok'] === true

/**
 * The control endpoint's handlers with every change an agent makes recorded in the journal: the
 * object is read before and after the handler runs. Reads and refused changes are not recorded, nor
 * are milestone changes that only wait as proposals (Plan already shows those for review).
 */
export function journalControl(deps: ControlDeps, { journal, targets: t }: { journal: AgentChangeJournal; targets: AgentChangeTargets }): ControlDeps {
  const out: ControlDeps = { ...deps }
  if (deps.saveFlowMap) out.saveFlowMap = (map: unknown, caller?: ControlCaller) => saveAgentFlowMap(t.flowMaps, map, journal, whoOf(t, caller?.session))
  const automations = deps.automations
  if (automations) {
    const recordAutomation = (before: Obj | null, reply: ControlReply, body: unknown) => {
      const saved = reply.body['automation']
      const id = isObj(saved) && typeof saved['id'] === 'string' ? saved['id'] : null
      const after = id ? ((t.automations.get(id) as unknown as Obj | undefined) ?? null) : null
      if (!id || !after) return
      const who = whoOf(t, sessionOf(body))
      journal.record({ kind: 'automation', object: { id, name: String(after['name'] ?? id) }, before, after, ...who, profileId: (after['profileId'] as string | null | undefined) ?? who.profileId ?? null })
    }
    out.automations = {
      ...automations,
      async create(body, params) {
        const reply = await automations.create(body, params)
        if (okReply(reply)) recordAutomation(null, reply, body)
        return reply
      },
      async update(id, body, params) {
        const before = (t.automations.get(id) as unknown as Obj | undefined) ?? null
        const reply = await automations.update(id, body, params)
        if (okReply(reply) && before) recordAutomation(before, reply, body)
        return reply
      }
    }
  }
  const plan = deps.plan
  if (plan) {
    out.plan = {
      ...plan,
      async updateItem(id, body, params) {
        const before = t.planner.findItem(id)
        const reply = await plan.updateItem(id, body, params)
        const after = okReply(reply) ? t.planner.findItem(id) : undefined
        if (before && after) journal.record({ kind: 'inboxItem', object: { id, name: after.item.title }, before: before.item as unknown as Obj, after: after.item as unknown as Obj, ...whoOf(t, sessionOf(body)), profileId: after.profileId })
        return reply
      },
      async changeMilestone(id, method, body, params) {
        const before = id ? t.planner.findMilestone(id) : undefined
        const reply = await plan.changeMilestone(id, method, body, params)
        if (!okReply(reply) || reply.body['applied'] !== true) return reply
        const milestoneId = typeof reply.body['id'] === 'string' ? reply.body['id'] : id
        const after = milestoneId ? t.planner.findMilestone(milestoneId) : undefined
        const found = after ?? before
        if (milestoneId && found)
          journal.record({ kind: 'milestone', object: { id: milestoneId, name: found.milestone.name }, before: (before?.milestone as unknown as Obj | undefined) ?? null, after: (after?.milestone as unknown as Obj | undefined) ?? null, ...whoOf(t, sessionOf(body)), profileId: found.profileId })
        return reply
      }
    }
  }
  const addInboxItems = deps.addInboxItems
  if (addInboxItems) {
    out.addInboxItems = async (body) => {
      const r = await addInboxItems(body)
      if (r.ok)
        for (const itemId of r.added) {
          const found = t.planner.findItem(itemId)
          if (found) journal.record({ kind: 'inboxItem', object: { id: itemId, name: found.item.title }, before: null, after: found.item as unknown as Obj, ...whoOf(t, sessionOf(body)), profileId: found.profileId })
        }
      return r
    }
  }
  return out
}

/** The desktop's bridge: list, keep, revert. Not on any paired device's allowlist. */
export function registerAgentChangesIpc(ipc: IpcRegistrar, { journal, targets: t }: { journal: AgentChangeJournal; targets: AgentChangeTargets }): void {
  ipc.handle('agentChanges:list', () => journal.unreviewed())
  ipc.handle('agentChanges:keep', (_e, id: unknown): Promise<AgentChangeAnswer> | AgentChangeAnswer => (typeof id === 'string' ? keepAgentChange(journal, t, id) : { ok: false, error: 'gone' }))
  ipc.handle('agentChanges:revert', (_e, id: unknown): Promise<AgentChangeAnswer> | AgentChangeAnswer => (typeof id === 'string' ? revertAgentChange(journal, t, id) : { ok: false, error: 'gone' }))
}

export interface AgentChangesDeps {
  store: StateStore<AgentChangeState>
  changed: (unreviewed: AgentChange[]) => void
  automations: { snapshot(): { automations: readonly { definition: AutomationDefinition }[] } } & Pick<AgentChangeTargets['automations'], 'save' | 'remove'>
  flowMaps: FlowMapRows
  planner: AgentChangeTargets['planner']
  /** The open sessions: their display name, agent and profile. */
  sessions: () => readonly { id: string; label: string; agentName: string; profileId?: string | null }[]
}

/** The journal and the objects it reads and writes, from the app's services (one call in `index.ts`). */
export function createAgentChanges(deps: AgentChangesDeps): { journal: AgentChangeJournal; targets: AgentChangeTargets } {
  const journal = new AgentChangeJournal({ store: deps.store, changed: deps.changed })
  const targets: AgentChangeTargets = {
    automations: { get: (id) => deps.automations.snapshot().automations.find((s) => s.definition.id === id)?.definition, save: (a) => deps.automations.save(a), remove: (id) => deps.automations.remove(id) },
    flowMaps: deps.flowMaps,
    planner: deps.planner,
    session: (id) => {
      const s = deps.sessions().find((v) => v.id === id)
      return s ? { name: s.label, agent: s.agentName, profileId: s.profileId ?? null } : undefined
    }
  }
  return { journal, targets }
}
