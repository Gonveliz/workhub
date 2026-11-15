import { homedir } from 'node:os'
import { join } from 'node:path'
import { ConfigParseError, configSchema, parseConfig, type ConfigStore, type WorkhubConfig } from '@workhub/core'
import { readFileIfExists, SerialQueue, writeFileAtomic } from '../shared/atomic-file'

export interface JsonConfigStoreOptions {
  /** The folder a leading `~` stands for; the user's home folder when unset. */
  home?: string
}

/**
 * ConfigStore on one JSON file. The path is injected (the app passes its data folder).
 * A missing file loads as an empty config; a corrupt or newer file throws and is never
 * overwritten by `load`.
 */
export class JsonConfigStore implements ConfigStore {
  private readonly queue = new SerialQueue()

  constructor(
    readonly path: string,
    private readonly options: JsonConfigStoreOptions = {}
  ) {}

  async load(): Promise<WorkhubConfig> {
    const text = await readFileIfExists(this.path)
    if (text === null) return parseConfig(null)
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (err) {
      throw new ConfigParseError([`${this.path} is not valid JSON: ${(err as Error).message}`])
    }
    return this.expandHome(parseConfig(raw))
  }

  async save(config: WorkhubConfig): Promise<void> {
    // Validate the shape before writing, so a bad object never reaches the disk.
    const checked = configSchema.parse(config)
    await this.queue.run(() => writeFileAtomic(this.path, `${JSON.stringify(checked, null, 2)}\n`))
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
