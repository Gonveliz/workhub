import { readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { CONFIG_VERSION, ConfigParseError, configSchema, parseConfig, type ConfigStore, type WorkhubConfig } from '@workhub/core'
import { readFileIfExists, SerialQueue, writeFileAtomic } from '../shared/atomic-file'

export interface JsonConfigStoreOptions {
  /** The folder a leading `~` stands for; the user's home folder when unset. */
  home?: string
}

/** How many `config.json.v<n>.bak` copies stay next to the file. */
export const CONFIG_COPIES_KEPT = 3

/**
 * ConfigStore on one JSON file. The path is injected (the app passes its data folder).
 * A missing file loads as an empty config; a corrupt or newer file throws and is never
 * overwritten by `load`.
 */
export class JsonConfigStore implements ConfigStore {
  private readonly queue = new SerialQueue()
  /** The file as read by the last load that migrated it; copied before the next save, then cleared. */
  private pendingCopy: { version: number; text: string } | null = null

  constructor(
    readonly path: string,
    private readonly options: JsonConfigStoreOptions = {}
  ) {}

  async load(): Promise<WorkhubConfig> {
    // A failed load never leaves a copy to write: only a document that parsed is worth keeping.
    this.pendingCopy = null
    const text = await readFileIfExists(this.path)
    if (text === null) return parseConfig(null)
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (err) {
      throw new ConfigParseError([`${this.path} is not valid JSON: ${(err as Error).message}`])
    }
    const config = this.expandHome(parseConfig(raw))
    const stored = typeof (raw as { version?: unknown } | null)?.version === 'number' ? (raw as { version: number }).version : 0
    if (stored < CONFIG_VERSION) this.pendingCopy = { version: stored, text }
    return config
  }

  async save(config: WorkhubConfig): Promise<void> {
    // Validate the shape before writing, so a bad object never reaches the disk.
    const checked = configSchema.parse(config)
    await this.queue.run(async () => {
      await this.keepCopy()
      await writeFileAtomic(this.path, `${JSON.stringify(checked, null, 2)}\n`)
    })
  }

  /**
   * Before the first save after a load that migrated the file, keeps the original next to it as
   * `config.json.v<old>.bak` (owner-only), so an upgrade can be undone by hand. An existing copy of
   * that version is never overwritten (it is the older, truer original); only the newest
   * `CONFIG_COPIES_KEPT` copies stay. A failure throws, so the save does not replace the original unkept.
   */
  private async keepCopy(): Promise<void> {
    const pending = this.pendingCopy
    if (!pending) return
    const target = `${this.path}.v${pending.version}.bak`
    try {
      await writeFile(target, pending.text, { flag: 'wx', mode: 0o600 })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    this.pendingCopy = null
    await this.pruneCopies()
  }

  private async pruneCopies(): Promise<void> {
    const prefix = `${basename(this.path)}.v`
    const names = (await readdir(dirname(this.path))).filter((n) => n.startsWith(prefix) && /^\d+\.bak$/.test(n.slice(prefix.length)))
    const dated = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(dirname(this.path), n))).mtimeMs })))
    dated.sort((a, b) => b.t - a.t || b.n.localeCompare(a.n))
    for (const { n } of dated.slice(CONFIG_COPIES_KEPT)) await unlink(join(dirname(this.path), n)).catch(() => {})
  }

  /**
   * An account folder typed as `~/...` reaches the agent through an environment variable
   * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), where no shell expands the `~`: it is made absolute here,
   * once, for every reader of the config.
   */
  private expandHome(config: WorkhubConfig): WorkhubConfig {
    const home = this.options.home ?? homedir()
    const expand = (dir: string): string => (dir === '~' ? home : /^~[\\/]/.test(dir) ? join(home, dir.slice(2)) : dir)
    if (!config.accounts.some((a) => a.configDir?.startsWith('~'))) return config
    return { ...config, accounts: config.accounts.map((a) => (a.configDir ? { ...a, configDir: expand(a.configDir) } : a)) }
  }
}
