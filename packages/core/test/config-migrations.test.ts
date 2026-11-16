import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, configSchema } from '../src/config/schema'
import { migrateConfig, parseConfig } from '../src/config/migrations'
import v0 from './fixtures/config/v0.json'
import v1 from './fixtures/config/v1.json'
import v2 from './fixtures/config/v2.json'
import v3 from './fixtures/config/v3.json'
import v4 from './fixtures/config/v4.json'
import v5 from './fixtures/config/v5.json'
import v6 from './fixtures/config/v6.json'
import v7 from './fixtures/config/v7.json'

// One minimal document per past version. When CONFIG_VERSION grows, add the new last version's
// file here: the length check below fails until you do.
const fixtures: unknown[] = [v0, v1, v2, v3, v4, v5, v6, v7]

describe('config fixtures', () => {
  it('has one document per past version, 0 up to the current one minus 1', () => {
    expect(fixtures).toHaveLength(CONFIG_VERSION)
  })

  it.each(fixtures.map((doc, v) => [v, doc] as const))('migrates the version %i document to the current schema', (v, doc) => {
    expect((doc as { version?: number }).version ?? 0).toBe(v)
    const migrated = migrateConfig(doc)
    expect(migrated['version']).toBe(CONFIG_VERSION)
    expect(configSchema.safeParse(migrated).success).toBe(true)
    expect(parseConfig(doc).profiles[0]?.id).toBe('acme')
  })
})
