import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { schema } from './schema'
import { WalCheckpointer, autoCheckpointPagesFor, parseWalIndexHeader, readShmHead, readWalIndexHeader, type WalCheckpointerOptions, type WalIndexHeader } from './wal-checkpointer'

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
  /** H-W6：进入退出时 worker 正卡在一次尝试里 → 已立即 terminate（不等 close） */
  terminatedInFlight?: boolean
}
export interface QuitResult { timedOut: boolean; ms: number; segments?: QuitSegments }

export interface AppDatabaseOptions {
  /** 后台 WAL 检查点参数；false = 不用后台检查点（批量提交后立即恢复自动检查点）。:memory: 库总是不用。 */
  checkpointer?: WalCheckpointerOptions | false
  /** P3 PR-44：批量提交后等「安静的完整检查点」释放暂停的上限；超过则降级（恢复 autocheckpoint）并告警 */
  release?: { maxRounds?: number; maxMs?: number }
  /** P3（wal-restart ④）仅测试：注入 -shm 头读取（喂坏头）与时钟（兜底超时），见 RestartWaitDiagnostics */
  restartWait?: {
    readShmHead?: () => Buffer | undefined
    now?: () => number
    timers?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
  }
}

/** P3（wal-restart ④）：等待态下待回写超过此值 → 兜底恢复 wal_autocheckpoint */
export const RESTART_WAIT_MAX_PENDING_BYTES = 6 * 1024 * 1024
/** P3（wal-restart ④）：等待态持续 ≥ 此值（在下一次提交时判断）→ 兜底恢复 wal_autocheckpoint */
export const RESTART_WAIT_MAX_MS = 30_000

/**
 * P3（wal-restart ④）诊断：批量释放时 WAL 未回文件头 → 进入等待态（wal_autocheckpoint 保持 0，普通写由 worker 1MB 触发 PASSIVE），
 * 之后某次普通写自然走 walRestartLog（wal.c:3976）回到文件头（-shm mxFrame 变小）才恢复。
 * - waits：进入等待态次数；restored：因 WAL 回文件头而恢复的次数；
 * - fallbackCount / fallbacks：兜底恢复次数与原因（pending = 待回写 > 6MB；timeout = 等待 ≥ 30s；bad-header = -shm 头读取/校验失败；
 *   worker = 后台检查点关闭/缺席/失败）。正常路径 fallbackCount 应为 0。
 */
export interface RestartWaitDiagnostics {
  waits: number; restored: number; fallbackCount: number
  fallbacks: Array<{ reason: RestartWaitFallbackReason; at: number; pendingBytes?: number; waitedMs?: number }>
  waiting: boolean
}

/** P3 PR-44：一次暂停释放过程的结果（诊断与测试用） */
export interface ReleaseRecord {
  /** 释放原因：quiet = 某轮 checkpointed == log 且期间主连接无新写入；limit-rounds / limit-ms = 达上限降级；failed = 后台检查点失败；closed = 已关闭 */
  reason: 'quiet' | 'limit-rounds' | 'limit-ms' | 'failed' | 'closed'
  rounds: number
  ms: number
  writesDuringHold: number
  at: number
  /**
   * P3（wal-restart ④）：wal_autocheckpoint 何时真正恢复。'restored-now' = 释放时立即恢复（非 quiet / WAL 已在文件头 / 无 checkpointer）；
   * 'waiting' = 进入等待态（WAL 未回文件头）；之后改写为 'restored-after-restart'（某次普通写回到文件头）或 'fallback-<原因>'（兜底）
   * 或 'superseded'（新的批量暂停接管）。释放完成的明确信号 = autoCheckpointRestore ≠ 'waiting'（e2e 用）。
   */
  autoCheckpointRestore?: 'restored-now' | 'waiting' | 'restored-after-restart' | 'superseded' | `fallback-${RestartWaitFallbackReason}`
}

export type RestartWaitFallbackReason = 'pending' | 'timeout' | 'bad-header' | 'worker'

/**
 * 主连接最近的写事务 COMMIT 耗时（墙钟 ms），诊断与测试用。
 * autoCheckpoint 只等于 !held（当时不在批量暂停中），不代表 SQLite 真的做了检查点。
 * P3（wal-restart）诊断字段：COMMIT 前后各读一次 -shm 的 WAL-index 头（readWalIndexHeader，在 COMMIT 计时之外读；只进诊断记录）。
 * - mxFrameBefore / mxFrameAfter：WalIndexHdr.mxFrame（wal.c:328）。
 * - nBackfillBefore / nBackfillAfter：WalCkptInfo.nBackfill（wal.c:395）。
 * - walRestarted：mxFrameAfter < mxFrameBefore，即本次提交的帧从 WAL 文件头写起（walRestartLog 成功，wal.c:3976-3997）。
 * - backfilledInCommit：nBackfillAfter ≠ nBackfillBefore。若提交期间后台 worker 不在跑（checkpointerBusy=false），
 *   说明 COMMIT 里同步做了检查点回写（wal_autocheckpoint 的默认 hook）。
 * - checkpointerBusy：COMMIT 前后台检查点是否有运行中/排队的轮次（为 true 时 nBackfill 变化可能来自 worker）。
 * 读不到 -shm 时这些字段缺省。
 */
export interface CommitRecord {
  at: number; commitMs: number; autoCheckpoint: boolean; held: boolean
  mxFrameBefore?: number; mxFrameAfter?: number; nBackfillBefore?: number; nBackfillAfter?: number
  walRestarted?: boolean; backfilledInCommit?: boolean; checkpointerBusy?: boolean
}

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
  /** P3（wal-restart ④）：等待 WAL 回文件头（since = 进入时刻，lastMxFrame = 最近一次读到的 mxFrame）；undefined = 不在等待态 */
  private restartWait?: { since: number; lastMxFrame: number; record?: ReleaseRecord; timer?: unknown; token?: object }
  private readonly timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
  private readonly shmHeadReader: () => Buffer | undefined
  private readonly clock: () => number
  readonly restartWaitDiag: RestartWaitDiagnostics = { waits: 0, restored: 0, fallbackCount: 0, fallbacks: [], waiting: false }

  constructor(path: string, options: AppDatabaseOptions = {}) {
    this.path = path
    this.shmHeadReader = options.restartWait?.readShmHead ?? (() => readShmHead(path))
    this.clock = options.restartWait?.now ?? (() => Date.now())
    this.timers = options.restartWait?.timers ?? {
      set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    }
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
      // H-W6：wal_autocheckpoint 只作保底，阈值 ≈ 6MB 帧（上界 = 6MB + 一次提交），按实际 page_size 计算（见 wal-checkpointer.ts 顶部注释）
      if (this.checkpointer.triggerBytes !== undefined) {
        const pageSize = Number((this.raw.prepare('PRAGMA page_size').get() as { page_size: number }).page_size)
        this.raw.exec(`PRAGMA wal_autocheckpoint = ${autoCheckpointPagesFor(pageSize)}`)
      }
    }
  }

  /** 诊断：读 -shm 的 WAL-index 头（:memory: 库或读不到时 undefined）。只读前 100 字节，不开连接。 */
  private readWalIndex(): WalIndexHeader | undefined {
    if (this.path === ':memory:') return undefined
    try { return readWalIndexHeader(this.path, 1) } catch { return undefined }
  }

  private walFileBytes(): number {
    try { return statSync(`${this.path}-wal`).size } catch { return 0 }
  }

  get closed(): boolean { return this.isClosed }

  /** 同步关闭（兼容旧调用）：通知后台检查点 worker 关闭（不等待），再关主连接。 */
  close(): void {
    if (this.isClosed) return
    this.isClosed = true
    this.endRestartWait()
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
    let timedOut = false
    // H-W6 方案①：worker 正卡在一次尝试里（未回消息）→ 立即 terminate，不再等 close() 的 2s；
    // 没回写完的部分由下面的 TRUNCATE 重做。terminate 打断不了正在执行的原生 SQLite 调用：若 worker 仍在底层检查点里持 CKPT 锁，
    // TRUNCATE 立即返回 busy=1（不调 busy handler，主连接 busy_timeout=0），只记录；随后 close：仅当 worker 连接尚未释放时才不做检查点（拿不到排他锁）；若最后一个连接是主连接，SQLite 会在 close 里以 PASSIVE 把 WAL 回写（sqlite3WalClose，见 wal.c）（依据 wal.c 阅读，未单测）。
    // 前一种情况下已提交数据留在 WAL，下次打开由 SQLite 恢复。
    const terminatedInFlight = Boolean(this.checkpointer?.attemptInFlight)
    if (terminatedInFlight) this.checkpointer?.terminate()
    else {
      timedOut = await Promise.race([
        (this.checkpointer?.close() ?? Promise.resolve()).then(() => false, () => false),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), workerLimitMs) })
      ])
      if (timer) clearTimeout(timer)
      if (timedOut) this.checkpointer?.terminate()
    }
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
      walBytesBeforeCheckpoint, walBytesBeforeClose, checkpointOk, workerLimitMs, terminatedInFlight
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
      // ④ 等待态中 wal_autocheckpoint 已是 0，原值仍在 autoCheckpointSaved：不覆盖；新的暂停接管，等待态结束（由新的释放重新判断）
      if (this.restartWait) this.endRestartWait('superseded')
      else this.autoCheckpointSaved = this.autoCheckpoint
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
    // ④：只有安静释放才可能进入等待态；failed / closed / limit-* 照旧立即恢复
    this.releaseAutoCheckpoint(holds, reason === 'quiet', record)
  }

  /**
   * waitForRestart（④，仅安静释放）：WAL 还没回到文件头（-shm mxFrame > 0）时不恢复 wal_autocheckpoint，进入等待态；
   * 恢复后第一次保存的 mxFrame 会接在旧帧之后、超过阈值，COMMIT 里同步回写（run 41188304434 save2 commitMs 183ms）。
   * -shm 头读不到 / 校验不过 → 立即恢复（退回原行为）并记日志。
   */
  private releaseAutoCheckpoint(count: number, waitForRestart = false, record?: ReleaseRecord): void {
    this.autoCheckpointHolds = Math.max(0, this.autoCheckpointHolds - count)
    if (this.autoCheckpointHolds > 0 || this.isClosed) return
    if (waitForRestart && this.path !== ':memory:') {
      const h = parseWalIndexHeader(this.shmHeadReader())
      if (!h) { this.restartWait = { since: this.clock(), lastMxFrame: 0, record }; this.restartWaitFallback('bad-header'); return }
      if (h.mxFrame > 0) {
        // 30s 兜底定时器：没有任何写入时也会到点恢复；unref 不拖住进程退出；close / 结束等待时清掉
        const token = {}
        const timer = this.timers.set(() => {
          const w = this.restartWait
          if (w && w.token === token && !this.isClosed) this.restartWaitFallback('timeout', { waitedMs: this.clock() - w.since })
        }, RESTART_WAIT_MAX_MS)
        this.restartWait = { since: this.clock(), lastMxFrame: h.mxFrame, record, timer, token }
        if (record) record.autoCheckpointRestore = 'waiting'
        this.restartWaitDiag.waits += 1
        this.restartWaitDiag.waiting = true
        return
      }
    }
    if (record) record.autoCheckpointRestore = 'restored-now'
    this.restoreAutoCheckpoint()
  }

  /** 仅诊断/测试：等待态 30s 兜底定时器是否存在 */
  get restartWaitTimerActive(): boolean { return this.restartWait?.timer !== undefined }

  private restoreAutoCheckpoint(outcome?: ReleaseRecord['autoCheckpointRestore']): void {
    this.endRestartWait(outcome)
    if (this.isClosed) return
    try { this.raw.exec(`PRAGMA wal_autocheckpoint = ${Math.trunc(this.autoCheckpointSaved)}`) } catch (error) {
      console.warn(`[wal-checkpoint] restore wal_autocheckpoint failed: ${(error as Error).message}`)
    }
  }

  private endRestartWait(outcome?: ReleaseRecord['autoCheckpointRestore']): void {
    const wait = this.restartWait
    if (wait?.timer !== undefined) this.timers.clear(wait.timer)
    if (wait?.record && outcome) wait.record.autoCheckpointRestore = outcome
    this.restartWait = undefined
    this.restartWaitDiag.waiting = false
  }

  /** ④ 兜底：恢复 wal_autocheckpoint 并记日志；下一次 COMMIT 可能在主线程同步回写 ≤ 6MB + fsync（可能超过 50ms）。 */
  private restartWaitFallback(reason: RestartWaitFallbackReason, extra: { pendingBytes?: number; waitedMs?: number } = {}): void {
    this.restartWaitDiag.fallbackCount += 1
    this.restartWaitDiag.fallbacks.push({ reason, at: Date.now(), ...extra })
    if (this.restartWaitDiag.fallbacks.length > 50) this.restartWaitDiag.fallbacks.splice(0, this.restartWaitDiag.fallbacks.length - 50)
    const message = `[wal-checkpoint] restart-wait fallback (${reason}) ${JSON.stringify(extra)}; restoring wal_autocheckpoint, next save may run a synchronous checkpoint`
    this.checkpointer?.warnings.push(message)
    console.warn(message)
    this.restoreAutoCheckpoint(`fallback-${reason}`)
  }

  /**
   * ④：等待态下每次普通写 COMMIT 之后调用（在 COMMIT 计时之外，主线程同步，只读 -shm 头 100 字节）。
   * mxFrame 变小 = 本次写走了 walRestartLog、WAL 已回文件头 → 恢复；否则检查兜底（待回写 > 6MB / 等待 ≥ 30s / worker 不可用）。
   */
  private checkRestartWait(): void {
    const wait = this.restartWait
    if (!wait || this.isClosed) return
    const cp = this.checkpointer
    if (!cp || cp.closed || cp.consecutiveFailures > 0) { this.restartWaitFallback('worker'); return }
    const h = parseWalIndexHeader(this.shmHeadReader())
    if (!h) { this.restartWaitFallback('bad-header'); return }
    if (h.mxFrame < wait.lastMxFrame) {
      this.restartWaitDiag.restored += 1
      this.restoreAutoCheckpoint('restored-after-restart')
      return
    }
    wait.lastMxFrame = h.mxFrame
    const pendingBytes = Math.max(0, h.mxFrame - h.nBackfill) * (h.pageSize + 24)
    if (pendingBytes > RESTART_WAIT_MAX_PENDING_BYTES) { this.restartWaitFallback('pending', { pendingBytes }); return }
    const waitedMs = this.clock() - wait.since
    if (waitedMs >= RESTART_WAIT_MAX_MS) this.restartWaitFallback('timeout', { waitedMs, pendingBytes })
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      const held = this.autoCheckpointHolds > 0
      // 诊断：COMMIT 前读 WAL-index 头（在计时之外）
      const checkpointerBusy = this.checkpointer ? this.checkpointer.busy : undefined
      const before = this.readWalIndex()
      const started = performance.now()
      this.raw.exec('COMMIT')
      const commitMs = Math.round((performance.now() - started) * 100) / 100
      const after = before ? this.readWalIndex() : undefined
      const record: CommitRecord = { at: Date.now(), commitMs, autoCheckpoint: !held, held }
      if (before && after) {
        Object.assign(record, {
          mxFrameBefore: before.mxFrame, mxFrameAfter: after.mxFrame, nBackfillBefore: before.nBackfill, nBackfillAfter: after.nBackfill,
          walRestarted: after.mxFrame < before.mxFrame,
          // restart 时 walRestartHdr 把 nBackfill 清 0（wal.c:2235），不算回写；此时只有 nBackfill > 0 才说明提交后又做了回写
          backfilledInCommit: after.mxFrame < before.mxFrame ? after.nBackfill > 0 : after.nBackfill !== before.nBackfill,
          checkpointerBusy
        })
      }
      this.commits.push(record)
      if (this.commits.length > 50) this.commits.splice(0, this.commits.length - 50)
      // 暂停期间（释放循环进行中）的每次写入：请求补做一轮检查点，合并进现有队列
      if (held && this.releaseLoop && this.checkpointer && !this.checkpointer.closed) {
        this.writesDuringHold += 1
        void this.checkpointer.request()
      }
      // H-W6：普通写入后按待回写量请求后台 PASSIVE（批量暂停期间由释放循环负责）
      // ④ 等待态：COMMIT 已结束、计时之外，读 -shm 头判断是否已回文件头 / 是否兜底
      if (!held && this.restartWait) this.checkRestartWait()
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
