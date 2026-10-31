import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { schema } from './schema'
import { WalCheckpointer, autoCheckpointPagesFor, type WalCheckpointerOptions } from './wal-checkpointer'

export const CURRENT_SCHEMA_VERSION = 10
/** 退出时等后台检查点 worker 关闭的上限（ms）；超时则 terminate worker、直接关主连接后退出（P3 PR-42）。 */
export const QUIT_CLOSE_LIMIT_MS = 5_000
/**
 * P3 PR-53（A）：退出预算按「限制退出时的工作量」做。
 * - worker 段硬上限 = QUIT_CLOSE_LIMIT_MS − QUIT_FINAL_RESERVE_MS（到点 terminate worker）。
 * - 预留段：主连接在预算内主动做一次 wal_checkpoint(TRUNCATE)，再 close（照常回写，此时 WAL 已空，close 很快）。
 * - 预留段耗时与「待回写量」成正比（(mxFrame − nBackfill) × 帧大小，即 WAL 里还没回写进主库的帧；已回写完的大 -wal 文件
 *   退出时只截断、不回写）。db.close() / 检查点是同步调用、无法中途超时：只有待回写量 ≤ WAL_QUIT_BOUND_BYTES（CI 两平台实测取慢者
 *   再留余量）时保证总时长 < QUIT_CLOSE_LIMIT_MS；超过则不保证 5s，但照常回写、已提交数据安全。
 * - 平时的待回写量沿用 main 的维护方式：普通保存由 SQLite 自身 wal_autocheckpoint（1000 页）在 COMMIT 后做 PASSIVE，
 *   批量写由 WalCheckpointer 后台 PASSIVE（暂停 / 释放）。PR-51 不另加定期写回（与 autocheckpoint 功能重复，且与保存重叠时
 *   Windows 保存变慢）。不设 journal_size_limit（实测拖慢释放后首存）；-wal 靠复用不再增长，退出时 TRUNCATE 截断到 0。
 */
export const QUIT_FINAL_RESERVE_MS = 1_500
export const QUIT_WORKER_LIMIT_MS = QUIT_CLOSE_LIMIT_MS - QUIT_FINAL_RESERVE_MS
export const WAL_QUIT_BOUND_BYTES = 8 * 1024 * 1024

export interface QuitSegments {
  /** 进入 closeForQuit → worker 段结束（≤ limit − reserve） */
  workerMs: number
  /** 主连接退出前检查点耗时 */
  checkpointMs: number
  /** 主连接 close 耗时 */
  mainCloseMs: number
  walBytesBeforeCheckpoint: number
  walBytesBeforeClose: number
  checkpointOk: boolean
  workerLimitMs: number
}
export interface QuitResult { timedOut: boolean; ms: number; segments?: QuitSegments }

export interface AppDatabaseOptions {
  /** 后台 WAL 检查点参数；false = 不用后台检查点（批量提交后立即恢复自动检查点）。:memory: 库总是不用。 */
  checkpointer?: WalCheckpointerOptions | false
  /** P3 PR-44：批量提交后等「安静的完整检查点」释放暂停的上限；超过则降级（恢复 autocheckpoint）并告警 */
  release?: { maxRounds?: number; maxMs?: number }
}

/** P3 PR-44：一次暂停释放过程的结果（诊断与测试用） */
export interface ReleaseRecord {
  /** 释放原因：quiet = 某轮 checkpointed == log 且期间主连接无新写入；limit-rounds / limit-ms = 达上限降级；failed = 后台检查点失败；closed = 已关闭 */
  reason: 'quiet' | 'limit-rounds' | 'limit-ms' | 'failed' | 'closed'
  rounds: number
  ms: number
  writesDuringHold: number
  at: number
}

/** 主连接最近的写事务 COMMIT 耗时（墙钟 ms），诊断与测试用 */
export interface CommitRecord { at: number; commitMs: number; autoCheckpoint: boolean; held: boolean }

export const RELEASE_MAX_ROUNDS = 10
export const RELEASE_MAX_MS = 30_000

export class AppDatabase {
  readonly raw: DatabaseSync
  readonly path: string
  readonly checkpointer?: WalCheckpointer
  private isClosed = false
  private autoCheckpointHolds = 0
  private autoCheckpointSaved = 1000
  private readonly releaseMaxRounds: number
  private readonly releaseMaxMs: number
  private releaseLoop?: Promise<void>
  /** P3 PR-44：最近的释放记录（最多 50 条） */
  readonly releases: ReleaseRecord[] = []
  /** 最近的写事务提交记录（最多 50 条） */
  readonly commits: CommitRecord[] = []

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
    this.releaseMaxRounds = options.release?.maxRounds ?? RELEASE_MAX_ROUNDS
    this.releaseMaxMs = options.release?.maxMs ?? RELEASE_MAX_MS
    if (path !== ':memory:' && options.checkpointer !== false) {
      this.checkpointer = new WalCheckpointer(path, {
        ...(options.checkpointer ?? {}),
        generation: () => this.writeGeneration(),
        shouldTrigger: () => !this.isClosed && this.autoCheckpointHolds === 0
      })
      // H-W6：wal_autocheckpoint 只作保底，阈值 ≈ 8MB 待回写帧（见 wal-checkpointer.ts 顶部注释）
      if (this.checkpointer.triggerBytes !== undefined) {
        const pageSize = Number((this.raw.prepare('PRAGMA page_size').get() as { page_size: number }).page_size)
        this.raw.exec(`PRAGMA wal_autocheckpoint = ${autoCheckpointPagesFor(pageSize)}`)
      }
    }
  }

  private walFileBytes(): number {
    try { return statSync(`${this.path}-wal`).size } catch { return 0 }
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

  /**
   * 应用退出用（will-quit，在所有窗口关窗握手——渲染进程 flush 最后一次保存并提交——之后）。P3 PR-53：
   * 1) worker 段：等后台检查点 worker 关闭，硬上限 limitMs − reserveMs，到点 terminate（未完成的回写留在 WAL）。
   * 2) 预留段：主连接主动 wal_checkpoint(TRUNCATE)（失败/BUSY 只记录），再 close（照常回写剩余部分）。
   * 待回写量 ≤ WAL_QUIT_BOUND_BYTES 时总时长 < limitMs；更多不保证时限，但不跳过回写、不丢已提交数据。
   */
  async closeForQuit(limitMs = QUIT_CLOSE_LIMIT_MS, reserveMs = QUIT_FINAL_RESERVE_MS): Promise<QuitResult> {
    const started = performance.now()
    if (this.isClosed) return { timedOut: false, ms: 0 }
    const workerLimitMs = Math.max(0, limitMs - reserveMs)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = await Promise.race([
      (this.checkpointer?.close() ?? Promise.resolve()).then(() => false, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), workerLimitMs) })
    ])
    if (timer) clearTimeout(timer)
    if (timedOut) this.checkpointer?.terminate()
    const workerEnd = performance.now()
    const walBytesBeforeCheckpoint = this.walFileBytes()
    let checkpointOk = false
    try {
      const row = this.raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number; log: number; checkpointed: number } | undefined
      checkpointOk = Boolean(row && row.busy === 0)
    } catch (error) {
      console.warn(`[wal-checkpoint] quit checkpoint failed: ${(error as Error).message}`)
    }
    const checkpointEnd = performance.now()
    const walBytesBeforeClose = this.walFileBytes()
    this.close()
    const closeEnd = performance.now()
    const segments: QuitSegments = {
      workerMs: Math.round(workerEnd - started), checkpointMs: Math.round(checkpointEnd - workerEnd), mainCloseMs: Math.round(closeEnd - checkpointEnd),
      walBytesBeforeCheckpoint, walBytesBeforeClose, checkpointOk, workerLimitMs
    }
    return { timedOut, ms: Math.round(closeEnd - started), segments }
  }

  /** 主连接当前的 wal_autocheckpoint（页数；0 = 关闭）。 */
  get autoCheckpoint(): number {
    return Number((this.raw.prepare('PRAGMA wal_autocheckpoint').get() as { wal_autocheckpoint: number }).wal_autocheckpoint)
  }

  /** 等后台检查点（含排队的）全部结束；结束后自动检查点已恢复原值。 */
  async checkpointIdle(): Promise<void> {
    await this.checkpointer?.idle()
    while (this.releaseLoop) await this.releaseLoop
  }

  /**
   * 主连接写入代数：SQLite total_changes()（本连接累计插入/更新/删除行数，含不经 transaction() 的单条写），只增不减。
   * 后台检查点每轮开始/结束各读一次：相等 = 这一轮期间主连接没有新写入。
   */
  writeGeneration(): number {
    return Number((this.raw.prepare('SELECT total_changes() AS n').get() as { n: number }).n)
  }

  /**
   * 大批量写（全书替换 / 整批恢复）专用事务：事务前读出并把 wal_autocheckpoint 设为 0，COMMIT 不再顺带做 ~54MB 的检查点。
   * - 失败 / 抛错 / 中途取消：finally 里立即释放这次暂停。
   * - 提交成功：进入释放循环（见 runReleaseLoop）——直到某一轮后台检查点 checkpointed == log 且该轮期间主连接没有新写入，
   *   才恢复原值。只看「这一轮完整」不够（P3 PR-44，诊断 run 41055697997）：检查点期间的普通保存会把新帧追加在
   *   这一轮快照之后，WAL 没被完整回写、下一次写入无法从头复用 WAL；恢复 autocheckpoint 后第一次普通保存的 COMMIT
   *   就会在主进程同步做检查点（Windows 实测 6263ms）。
   * - 暂停期间每次写事务提交都请求一次补做（合并进现有队列）；上限 releaseMaxRounds 轮 / releaseMaxMs，超过则降级恢复并告警。
   * - 后台检查点失败：立即恢复原值（交还 SQLite 自动检查点，WAL 有界）；下一次批量退化为不暂停（见 WalCheckpointer 注释）。
   * - 多个批量重叠：引用计数 + 同一个释放循环；循环结束时释放全部已提交批量的暂停，恢复第一个批量开始前读到的原值。
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
      if (committed && cp && !cp.closed) {
        this.committedHolds += 1
        if (!this.releaseLoop) {
          const loop: Promise<void> = this.runReleaseLoop(cp).finally(() => { if (this.releaseLoop === loop) this.releaseLoop = undefined })
          this.releaseLoop = loop
        }
      } else {
        this.releaseAutoCheckpoint(1)
      }
    }
  }

  /** 已提交、等释放循环释放的批量数 */
  private committedHolds = 0
  private writesDuringHold = 0

  private async runReleaseLoop(cp: WalCheckpointer): Promise<void> {
    const started = Date.now()
    const runsAtStart = cp.runs
    this.writesDuringHold = 0
    let reason: ReleaseRecord['reason'] = 'quiet'
    for (;;) {
      if (cp.closed || this.isClosed) { reason = 'closed'; break }
      if (!cp.busy) void cp.request()
      // 只等当前这一轮（不用 idle()：持续写入时队列一直有补做轮，idle 不返回，上限也就判不到）
      const outcome = (await cp.currentRound()) ?? cp.last
      const rounds = cp.runs - runsAtStart
      if (cp.closed || this.isClosed) { reason = 'closed'; break }
      if (!outcome || !outcome.ok) { reason = 'failed'; break }
      // quiet===true 才释放：quiet===undefined（未提供 generation）不得误当作安静释放
      if (outcome.quiet === true) { reason = 'quiet'; break }
      if (rounds >= this.releaseMaxRounds) { reason = 'limit-rounds'; break }
      if (Date.now() - started >= this.releaseMaxMs) { reason = 'limit-ms'; break }
    }
    const record: ReleaseRecord = { reason, rounds: cp.runs - runsAtStart, ms: Date.now() - started, writesDuringHold: this.writesDuringHold, at: Date.now() }
    this.releases.push(record)
    if (this.releases.length > 50) this.releases.splice(0, this.releases.length - 50)
    if (reason === 'limit-rounds' || reason === 'limit-ms') {
      const message = `[wal-checkpoint] release degraded (${reason}) after ${record.rounds} round(s) / ${record.ms}ms with ${record.writesDuringHold} write(s) during hold; restoring wal_autocheckpoint, next save may run a synchronous checkpoint`
      cp.warnings.push(message)
      console.warn(message)
    }
    const holds = this.committedHolds
    this.committedHolds = 0
    this.releaseAutoCheckpoint(holds)
  }

  private releaseAutoCheckpoint(count: number): void {
    this.autoCheckpointHolds = Math.max(0, this.autoCheckpointHolds - count)
    if (this.autoCheckpointHolds > 0 || this.isClosed) return
    try { this.raw.exec(`PRAGMA wal_autocheckpoint = ${Math.trunc(this.autoCheckpointSaved)}`) } catch (error) {
      console.warn(`[wal-checkpoint] restore wal_autocheckpoint failed: ${(error as Error).message}`)
    }
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      const held = this.autoCheckpointHolds > 0
      const started = performance.now()
      this.raw.exec('COMMIT')
      this.commits.push({ at: Date.now(), commitMs: Math.round((performance.now() - started) * 100) / 100, autoCheckpoint: !held, held })
      if (this.commits.length > 50) this.commits.splice(0, this.commits.length - 50)
      // 暂停期间（释放循环进行中）的每次写入：请求补做一轮检查点，合并进现有队列
      if (held && this.releaseLoop && this.checkpointer && !this.checkpointer.closed) {
        this.writesDuringHold += 1
        void this.checkpointer.request()
      }
      // H-W6：普通写入后按待回写量请求后台 PASSIVE（批量暂停期间由释放循环负责）
      if (!held) this.checkpointer?.noteCommit()
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
