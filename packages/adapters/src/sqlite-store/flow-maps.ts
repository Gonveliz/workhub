import type { WorkhubDb } from './db'

export interface FlowMapRow {
  id: string
  json: string
}

/** The `flow_maps` table: one map per row, its JSON as written (the app validates it on read). */
export class SqliteFlowMaps {
  constructor(private readonly db: WorkhubDb) {}

  /** Every map, by id. */
  list(): FlowMapRow[] {
    return this.db.raw.prepare('SELECT id, json FROM flow_maps ORDER BY id').all() as unknown as FlowMapRow[]
  }

  get(id: string): string | null {
    const row = this.db.raw.prepare('SELECT json FROM flow_maps WHERE id = ?').get(id) as { json: string } | undefined
    return row?.json ?? null
  }

  /** Stores (or replaces) the map with this id. */
  put(id: string, json: string): void {
    this.db.write(`flow map ${id}`, () => this.db.raw.prepare('INSERT INTO flow_maps (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at').run(id, json, Date.now()))
  }

  /** False when there was no map with this id. */
  remove(id: string): boolean {
    return (this.db.write(`flow map ${id} removal`, () => Number(this.db.raw.prepare('DELETE FROM flow_maps WHERE id = ?').run(id).changes)) ?? 0) > 0
  }
}
