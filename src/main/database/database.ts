import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { schema } from './schema'
import { DIAG_SAVE, diagMark, diagNow } from '../diag/save-trace'
import { WalCheckpointer, type CheckpointOutcome, type WalCheckpointerOptions } from './wal-checkpointer'

// DIAG：WAL 文件大小
const diagWal = (path: string): number => { try { return statSync(`${path}-wal`).size } catch { return 0 } }

export const CURRENT_SCHEMA_VERSION = 10

export interface AppDatabaseOptions {
  /** 后台 WAL 检查点参数；false = 不用后台检查点（批量提交后立即恢复自动检查点）。:memory: 库总是不用。 */
  checkpointer?: WalCheckpointerOptions | false
}

export class AppDatabase {
  readonly raw: DatabaseSync
  readonly path: string
  readonly checkpointer?: WalCheckpointer
  private isClosed = false
  private autoCheckpointHolds = 0
  private autoCheckpointSaved = 1000

  constructor(path: string, options: AppDatabaseOptions = {}) {
    this.path = path
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
    if (path !== ':memory:' && options.checkpointer !== false) this.checkpointer = new WalCheckpointer(path, options.checkpointer ?? {})
  }

  get closed(): boolean { return this.isClosed }

  /** 同步关闭（兼容旧调用）：通知后台检查点 worker 关闭（不等待），再关主连接。 */
  close(): void {
    if (this.isClosed) return
    this.isClosed = true
    void this.checkpointer?.close()
    this.raw.close()
  }

  /** 应用退出用：先等后台检查点 worker 跑完当前检查点并关闭自己的连接，再关主连接。 */
  async closeAsync(): Promise<void> {
    if (this.isClosed) return
    await this.checkpointer?.close()
    this.close()
  }

  /** 主连接当前的 wal_autocheckpoint（页数；0 = 关闭）。 */
  get autoCheckpoint(): number {
    return Number((this.raw.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number }).wal_autocheckpoint)
  }

  /** 等后台检查点（含排队的）全部结束；结束后自动检查点已恢复原值。 */
  async checkpointIdle(): Promise<void> {
    await this.checkpointer?.idle()
    while (this.pendingRelease) await this.pendingRelease
  }

  private pendingRelease?: Promise<void>

  /**
   * 大批量写（全书替换 / 整批恢复）专用事务：事务前读出并把 wal_autocheckpoint 设为 0，COMMIT 不再顺带做 ~54MB 的检查点。
   * - 失败 / 抛错 / 中途取消：finally 里立即恢复原值。
   * - 提交成功：请求后台 PASSIVE 检查点，检查点（含重试）结束后才恢复原值——期间主连接普通保存不会顺带触发那次大检查点；
   *   后台检查点失败只记日志并照样恢复原值（交还 SQLite 自动检查点，WAL 不会无限增长）。
   * - 上一轮后台检查点失败：退化为不暂停（见 WalCheckpointer 注释），保证 WAL 有界。
   * - 多个批量重叠：引用计数，最后一个结束时才恢复，恢复的是第一个批量开始前读到的原值。
   */
  bulkTransaction<T>(fn: () => T): T {
    const cp = this.checkpointer
    if (cp && !cp.closed && cp.consecutiveFailures > 0) {
      // 退化模式：上一轮后台检查点失败 → 本次不暂停自动检查点（COMMIT 内同步检查点，慢但 WAL 有界），提交后再探测一次后台检查点
      const result = this.transaction(fn)
      void cp.request()
      return result
    }
    if (this.autoCheckpointHolds === 0) {
      this.autoCheckpointSaved = this.autoCheckpoint
      this.raw.exec('PRAGMA wal_autocheckpoint = 0')
    }
    this.autoCheckpointHolds += 1
    let committed = false
    try {
      const result = this.transaction(fn)
      committed = true
      return result
    } finally {
      if (committed && this.checkpointer && !this.checkpointer.closed) {
        const release = this.checkpointer.request().then((outcome: CheckpointOutcome) => { void outcome; this.releaseAutoCheckpoint() })
        const tracked: Promise<void> = release.finally(() => { if (this.pendingRelease === tracked) this.pendingRelease = undefined })
        this.pendingRelease = tracked
      } else {
        this.releaseAutoCheckpoint()
      }
    }
  }

  private releaseAutoCheckpoint(): void {
    this.autoCheckpointHolds = Math.max(0, this.autoCheckpointHolds - 1)
    if (this.autoCheckpointHolds > 0 || this.isClosed) return
    try { this.raw.exec(`PRAGMA wal_autocheckpoint = ${Math.trunc(this.autoCheckpointSaved)}`) } catch (error) {
      console.warn(`[wal-checkpoint] restore wal_autocheckpoint failed: ${(error as Error).message}`)
    }
  }

  transaction<T>(fn: () => T): T {
    // DIAG：BEGIN IMMEDIATE（取写锁；本库未设 busy_timeout，拿不到锁会直接 SQLITE_BUSY，不会等待）/ 事务体 / COMMIT（含自动检查点）分段
    const t0 = DIAG_SAVE ? diagNow() : 0
    const wal0 = DIAG_SAVE ? diagWal(this.path) : 0
    this.raw.exec('BEGIN IMMEDIATE')
    const t1 = DIAG_SAVE ? diagNow() : 0
    try {
      const result = fn()
      const t2 = DIAG_SAVE ? diagNow() : 0
      this.raw.exec('COMMIT')
      if (DIAG_SAVE) {
        const t3 = diagNow()
        diagMark('main:tx', { begin: Math.round(t0 * 10) / 10, lockMs: +(t1 - t0).toFixed(2), bodyMs: +(t2 - t1).toFixed(2), commitMs: +(t3 - t2).toFixed(2), end: Math.round(t3 * 10) / 10, walBefore: wal0, walAfter: diagWal(this.path), autoCheckpoint: this.autoCheckpoint })
      }
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

    if (version < 10) {
      // v10（P1-1 F9）：timeline_events 时间线，纯作者手动录入，不进 AI 上下文。
      this.transaction(() => {
        this.raw.exec(`
CREATE TABLE IF NOT EXISTS timeline_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  story_time_label TEXT NOT NULL DEFAULT '',
  sort_key REAL NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  chapter_id TEXT REFERENCES document_nodes(id) ON DELETE SET NULL,
  character_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timeline_events_project ON timeline_events(project_id, sort_key);
`)
        this.writeVersion(10)
      })
      version = 10
    }

    this.raw.prepare("UPDATE chat_messages SET status = 'error' WHERE status = 'streaming'").run()
    if (version !== CURRENT_SCHEMA_VERSION) throw new Error(`DATABASE_SCHEMA_MIGRATION_INCOMPLETE:${version}`)
  }
}
