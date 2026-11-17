import { agentSlashCommands, parseSlashCommand, uniqueSlashCommands, type SlashCommandInfo } from '@workhub/core'
import type { SessionView } from '@shared/api'
import type { MessageKey, Params } from '../i18n/translate'

type Translate = (key: MessageKey, params?: Params) => string
type CommandView = Pick<SessionView, 'id' | 'agentId' | 'adapter' | 'commands' | 'models' | 'modelControl'> & Partial<Pick<SessionView, 'modes'>>

/**
 * `/model` is Workhub's for agents it switches models on over ACP, so the header's picker follows.
 * Claude Code runs its own `/model` (the SDK takes slash commands as prompts), so it goes through.
 */
function ownsModel(v: CommandView): boolean {
  return v.adapter !== 'native' && v.modelControl === true && (v.models?.length ?? 0) > 0
}

/**
 * `/login` is Workhub's for Claude in the chat: Claude Code only signs in from its terminal UI (the
 * SDK answers that the command is not available), so Workhub opens the console and types it there.
 */
function ownsLogin(v: CommandView): boolean {
  return v.adapter === 'native' && (v.modes?.includes('console') ?? false)
}

/** The commands Workhub runs itself for this session, first in the menu. */
export function workhubCommands(v: CommandView, t: Translate): SlashCommandInfo[] {
  const out: SlashCommandInfo[] = [{ name: 'rename', group: 'workhub', description: t('slash.rename.description'), argumentHint: t('slash.rename.hint') }]
  if (ownsLogin(v)) out.push({ name: 'login', group: 'workhub', description: t('slash.login.description') })
  if (ownsModel(v)) out.push({ name: 'model', group: 'workhub', description: t('slash.model.description'), argumentHint: t('slash.model.hint') })
  // Claude Code's own /exit belongs to its terminal UI (the chat goes through the SDK), so Workhub closes the session.
  out.push({ name: 'exit', group: 'workhub', description: t('slash.exit.description') })
  return out
}

/** Everything the composer's menu offers: Workhub's commands, then the agent's (reported, else its known built-ins). */
export function sessionSlashCommands(v: CommandView, t: Translate): SlashCommandInfo[] {
  return uniqueSlashCommands([...workhubCommands(v, t), ...agentSlashCommands(v.agentId, v.commands)])
}

export interface WorkhubCommandActions {
  rename(sessionId: string, name: string): Promise<void>
  setModel(sessionId: string, modelId: string): Promise<void>
  /** Opens the console and types `/login`; false when the console did not come up. */
  login(sessionId: string): Promise<boolean>
  /**
   * Closes the session as its close button does: resolves once it is closed or its close dialog is
   * up (a working session, or a worktree to keep or remove), rejects when it could not be closed.
   */
  exit(sessionId: string): Promise<void>
  /** A line in the chat: what the command did, or why it did not run. */
  report(kind: 'done' | 'error', text: string): void
}

/**
 * Runs `text` when it is one of Workhub's own commands and says so; anything else (an agent's
 * command, an unknown `/text`, a plain prompt) is left for the agent, sent as typed.
 */
export function runWorkhubCommand(v: CommandView, text: string, actions: WorkhubCommandActions, t: Translate): boolean {
  const command = parseSlashCommand(text)
  if (!command) return false
  const name = command.name.toLowerCase()
  if (name === 'rename') {
    if (!command.args) {
      actions.report('error', t('slash.rename.usage'))
      return true
    }
    const newName = command.args.replace(/\s+/g, ' ')
    actions.rename(v.id, newName).then(
      () => actions.report('done', t('slash.rename.done', { name: newName })),
      (e: unknown) => actions.report('error', t('slash.rename.failed', { message: e instanceof Error ? e.message : String(e) }))
    )
    return true
  }
  if (name === 'login' && ownsLogin(v)) {
    actions.login(v.id).then(
      (typed) => actions.report(typed ? 'done' : 'error', t(typed ? 'slash.login.done' : 'slash.login.timeout')),
      (e: unknown) => actions.report('error', t('slash.login.failed', { message: e instanceof Error ? e.message : String(e) }))
    )
    return true
  }
  if (name === 'exit') {
    // Arguments are ignored; a session that closes needs no "done" line in its chat.
    actions.exit(v.id).catch((e: unknown) => actions.report('error', t('sessions.closeFailed', { message: e instanceof Error ? e.message : String(e) })))
    return true
  }
  if (name === 'model' && ownsModel(v)) {
    const models = v.models ?? []
    const list = models.map((m) => m.id).join(', ')
    if (!command.args) {
      actions.report('error', t('slash.model.usage', { models: list }))
      return true
    }
    const wanted = command.args.toLowerCase()
    const model = models.find((m) => m.id.toLowerCase() === wanted) ?? models.find((m) => m.name.toLowerCase() === wanted)
    if (!model) {
      actions.report('error', t('slash.model.unknown', { model: command.args, models: list }))
      return true
    }
    actions.setModel(v.id, model.id).then(
      () => actions.report('done', t('slash.model.done', { model: model.name })),
      (e: unknown) => actions.report('error', t('slash.model.failed', { message: e instanceof Error ? e.message : String(e) }))
    )
    return true
  }
  return false
}
