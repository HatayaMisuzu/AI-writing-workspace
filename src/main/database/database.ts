import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { schema } from './schema'

export const CURRENT_SCHEMA_VERSION = 4

export class AppDatabase {
  readonly raw: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.raw = new DatabaseSync(path)
    this.raw.exec('PRAGMA foreign_keys = ON')
    const existingVersion = this.readExistingVersion()
    if (existingVersion > CURRENT_SCHEMA_VERSION) {
      this.raw.close()
      throw new Error(`DATABASE_SCHEMA_TOO_NEW:${existingVersion}:${CURRENT_SCHEMA_VERSION}`)
    }
    this.raw.exec(schema)
    this.migrate(existingVersion)
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

  private readExistingVersion(): number {
    const hasSettings = this.raw.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'").get()
    if (!hasSettings) return 0
    const row = this.raw.prepare("SELECT value_json FROM app_settings WHERE key = 'schema_version'").get() as { value_json: string } | undefined
    if (!row) return 0
    const version = Number(JSON.parse(row.value_json))
    if (!Number.isInteger(version) || version < 0) throw new Error('DATABASE_SCHEMA_VERSION_INVALID')
    return version
  }

  private hasColumn(table: string, column: string): boolean {
    return (this.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column)
  }

  private writeVersion(version: number): void {
    this.raw.prepare(`INSERT INTO app_settings(key, value_json, updated_at) VALUES ('schema_version', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(JSON.stringify(version), Date.now())
  }

  private migrate(existingVersion: number): void {
    let version = existingVersion
    if (version < 3) {
      this.transaction(() => {
        if (!this.hasColumn('text_patches', 'document_revision')) {
          this.raw.exec('ALTER TABLE text_patches ADD COLUMN document_revision INTEGER NOT NULL DEFAULT -1')
          this.raw.prepare("UPDATE text_patches SET status = 'stale' WHERE status = 'proposed'").run()
        }
        this.raw.prepare("UPDATE chat_messages SET status = 'error' WHERE status = 'streaming'").run()
        this.writeVersion(3)
      })
      version = 3
    }
    if (version < 4) {
      this.transaction(() => {
        if (!this.hasColumn('memories', 'source_revision')) this.raw.exec('ALTER TABLE memories ADD COLUMN source_revision INTEGER')
        if (!this.hasColumn('memories', 'source_digest_id')) this.raw.exec('ALTER TABLE memories ADD COLUMN source_digest_id TEXT REFERENCES chapter_digests(id)')
        this.raw.exec('DROP INDEX IF EXISTS idx_chat_project_thread')
        this.raw.exec('CREATE INDEX idx_chat_project_thread ON chat_messages(project_id, thread_id, created_at, id)')
        this.writeVersion(4)
      })
      version = 4
    }
    this.raw.prepare("UPDATE chat_messages SET status = 'error' WHERE status = 'streaming'").run()
    if (version !== CURRENT_SCHEMA_VERSION) throw new Error(`DATABASE_SCHEMA_MIGRATION_INCOMPLETE:${version}`)
  }
}
