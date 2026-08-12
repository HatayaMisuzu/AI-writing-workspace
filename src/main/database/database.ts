import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { schema } from './schema'

export class AppDatabase {
  readonly raw: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.raw = new DatabaseSync(path)
    this.raw.exec('PRAGMA foreign_keys = ON')
    this.raw.exec(schema)
    this.migrate()
  }

  close(): void {
    this.raw.close()
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.raw.exec('COMMIT')
      return result
    } catch (error) {
      this.raw.exec('ROLLBACK')
      throw error
    }
  }

  private migrate(): void {
    const patchColumns = this.raw.prepare('PRAGMA table_info(text_patches)').all() as Array<{ name: string }>
    if (!patchColumns.some((column) => column.name === 'document_revision')) {
      this.raw.exec('ALTER TABLE text_patches ADD COLUMN document_revision INTEGER NOT NULL DEFAULT -1')
      this.raw.prepare("UPDATE text_patches SET status = 'stale' WHERE status = 'proposed'").run()
    }
    this.raw.prepare("UPDATE chat_messages SET status = 'error' WHERE status = 'streaming'").run()
    this.raw.prepare(`INSERT INTO app_settings(key, value_json, updated_at) VALUES ('schema_version', '3', ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`).run(Date.now())
  }
}
