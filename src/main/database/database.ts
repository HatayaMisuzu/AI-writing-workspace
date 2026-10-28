import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { schema } from './schema'

export const CURRENT_SCHEMA_VERSION = 9

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
    if (version < 5) {
      // v5（S3 细纲）：node_outlines 表由 schema 以 IF NOT EXISTS 创建；project_notes.section 的 CHECK 约束需重建表才能接受 'outline'。
      const notesSql = (this.raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_notes'").get() as { sql: string } | undefined)?.sql ?? ''
      if (!notesSql.includes("'outline'")) {
        this.raw.exec('PRAGMA foreign_keys = OFF')
        try {
          this.transaction(() => {
            this.raw.exec(`CREATE TABLE project_notes_v5 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  section TEXT NOT NULL CHECK(section IN ('story','reference','outline')),
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`)
            this.raw.exec('INSERT INTO project_notes_v5(id,project_id,section,title,content,created_at,updated_at) SELECT id,project_id,section,title,content,created_at,updated_at FROM project_notes')
            this.raw.exec('DROP TABLE project_notes')
            this.raw.exec('ALTER TABLE project_notes_v5 RENAME TO project_notes')
            this.raw.exec('CREATE INDEX IF NOT EXISTS idx_notes_project_section ON project_notes(project_id, section, updated_at DESC)')
            this.writeVersion(5)
          })
        } finally {
          this.raw.exec('PRAGMA foreign_keys = ON')
        }
      } else {
        this.transaction(() => this.writeVersion(5))
      }
      version = 5
    }
    if (version < 6) {
      // v6（S7）：model_configs 上下文窗口/最大输出；provider_configs 可选超时。
      this.transaction(() => {
        if (!this.hasColumn('model_configs', 'context_window')) this.raw.exec('ALTER TABLE model_configs ADD COLUMN context_window INTEGER')
        if (!this.hasColumn('model_configs', 'max_output')) this.raw.exec('ALTER TABLE model_configs ADD COLUMN max_output INTEGER')
        if (!this.hasColumn('provider_configs', 'first_token_timeout_ms')) this.raw.exec('ALTER TABLE provider_configs ADD COLUMN first_token_timeout_ms INTEGER')
        if (!this.hasColumn('provider_configs', 'total_timeout_ms')) this.raw.exec('ALTER TABLE provider_configs ADD COLUMN total_timeout_ms INTEGER')
        this.writeVersion(6)
      })
      version = 6
    }
    if (version < 7) {
      // v7（S9）：writing_daily 日更统计表。目标存在 settings_json，迁移绝不预置任何默认目标值。
      this.transaction(() => {
        this.raw.exec(`
CREATE TABLE IF NOT EXISTS writing_daily (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  human_words_added INTEGER NOT NULL DEFAULT 0,
  human_words_deleted INTEGER NOT NULL DEFAULT 0,
  ai_words_accepted INTEGER NOT NULL DEFAULT 0,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, date)
);
CREATE INDEX IF NOT EXISTS idx_writing_daily_project_date ON writing_daily(project_id, date);
`)
        this.writeVersion(7)
      })
      version = 7
    }
    if (version < 8) {
      // v8（S11）：章节 status。0 字→构思(outline)，有字→草稿(draft)；绝不自动定稿。进度指针/章数目标不在迁移中预置。
      this.transaction(() => {
        if (!this.hasColumn('document_nodes', 'status')) {
          this.raw.exec(`ALTER TABLE document_nodes ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'`)
        }
        // 0 字（含无 contents 行）→ 构思；有字 → 草稿；绝不写入 final
        this.raw.exec(`
UPDATE document_nodes
SET status = 'outline'
WHERE type = 'chapter'
`)
        this.raw.exec(`
UPDATE document_nodes
SET status = 'draft'
WHERE type = 'chapter'
  AND id IN (SELECT document_id FROM document_contents WHERE word_count > 0)
`)
        this.writeVersion(8)
      })
      version = 8
    }

    if (version < 9) {
      // v9（S12）：foreshadow_meta 伏笔台账扩展；人物固定字段仍存 characters.fields_json，无新表。
      this.transaction(() => {
        this.raw.exec(`
CREATE TABLE IF NOT EXISTS foreshadow_meta (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  planned_chapter_id TEXT REFERENCES document_nodes(id) ON DELETE SET NULL,
  resolved_chapter_id TEXT REFERENCES document_nodes(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'planted' CHECK(state IN ('planted','hinting','resolved','abandoned')),
  abandon_reason TEXT NOT NULL DEFAULT '',
  character_ids_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_foreshadow_meta_project ON foreshadow_meta(project_id, state);
`)
        this.writeVersion(9)
      })
      version = 9
    }

    this.raw.prepare("UPDATE chat_messages SET status = 'error' WHERE status = 'streaming'").run()
    if (version !== CURRENT_SCHEMA_VERSION) throw new Error(`DATABASE_SCHEMA_MIGRATION_INCOMPLETE:${version}`)
  }
}
