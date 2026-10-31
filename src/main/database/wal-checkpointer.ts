import { Worker } from 'node:worker_threads'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { endianness } from 'node:os'

/**
 * P3 H-W6（组长定案）：普通保存的 WAL 待回写量由后台 PASSIVE 按量维持，SQLite 自身 wal_autocheckpoint 只作保底。
 *
 * 诊断（diag-hw6-autocheckpoint@7115cbc，run 41154768905）：Windows 大章节连续保存的 COMMIT 长尾 250 次里 249 次落在
 * wal_autocheckpoint 在 COMMIT 内做的同步回写上；改 200 页更差；autocheckpoint=0 + worker PASSIVE 消掉长尾，但只在
 * 「worker 空闲且待回写 >1MB」时请求一次、之后不再跟进，连续保存时待回写涨到 76.5MB。
 *
 * 修法：
 * - 待回写量 = (mxFrame − nBackfill) × (szPage + 24)，主线程直接读 -shm 的 WAL-index 头（readPendingBackfillBytes，只读 0..99 字节，
 *   不开连接、不发 PRAGMA、不碰 120..135 的锁字节）。
 * - 每次普通写事务提交后（noteCommit），在下一轮事件循环检查一次：worker 空闲且待回写 > BACKFILL_TRIGGER_BYTES（1MB）→ 请求一次 PASSIVE；
 *   这一轮成功结束后若仍 > 1MB，立即再请求一次（requestIfPending 递归），直到 ≤1MB 或失败。
 * - 保底：主连接 wal_autocheckpoint = autoCheckpointPagesFor(pageSize)（约 6MB 帧对应的页数，按实际 page_size 算）。SQLite 按 WAL 帧数 mxFrame 触发，
 *   mxFrame ≥ 待回写帧数，所以待回写最迟到约 6MB 时由 COMMIT 内的同步检查点接管；worker 正常时它几乎不触发。
 *   注意：保底在「提交之后」才触发，实际上界 = 6MB + 一次提交的帧；单次提交不超过约 2MB 时在 8MB 以内。
 *   （验收员 page_size 8192、单章约 10 万字、回写失败连续保存实测：旧目标 7MB 时峰值 8,404,968B > 8MB，故降到 6MB，组长 2026-10-31。）
 * - 回写失败 / worker 崩溃：不立即重请求（避免空转），保底照常生效，数据由 SQLite 保证完整；下一次提交再按量请求。
 * - 不加 journal_size_limit，不做定时 PASSIVE。
 */
export const BACKFILL_TRIGGER_BYTES = 1024 * 1024
/** 待回写上界（测试硬断言 ≤ 此值） */
export const BACKFILL_BOUND_BYTES = 8 * 1024 * 1024
/** 保底 wal_autocheckpoint 的目标：约 6MB 帧，给上界 8MB 留 2MB 余量容纳一次提交（组长 2026-10-31，由 7MB 降到 6MB） */
export const AUTOCHECKPOINT_TARGET_BYTES = 6 * 1024 * 1024
/** 保底 wal_autocheckpoint 页数 = floor(6MB / (page_size + 24)) = floor(6291456 / (page_size + 24))，page_size 启动时由 PRAGMA page_size 读出。4096 → 1527，8192 → 765。 */
export function autoCheckpointPagesFor(pageSize: number): number {
  const size = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 4096
  return Math.max(1, Math.floor(AUTOCHECKPOINT_TARGET_BYTES / (size + 24)))
}

const SHM_READ_BYTES = 100
const SQLITE_WAL_VERSION = 3007000

function shmChecksum(buf: Buffer, bigEndian: boolean): [number, number] {
  let s1 = 0; let s2 = 0
  for (let i = 0; i + 8 <= buf.length; i += 8) {
    const x0 = bigEndian ? buf.readUInt32BE(i) : buf.readUInt32LE(i)
    const x1 = bigEndian ? buf.readUInt32BE(i + 4) : buf.readUInt32LE(i + 4)
    s1 = (s1 + x0 + s2) >>> 0
    s2 = (s2 + x1 + s1) >>> 0
  }
  return [s1, s2]
}

/** -shm WAL-index 头里与检查点相关的字段（readWalIndexHeader） */
export interface WalIndexHeader { mxFrame: number; nBackfill: number; pageSize: number }

/**
 * 只读 -shm 前 100 字节解析 WAL-index 头。依据 SQLite wal.c 的结构定义（参考源码 /workspace/eng-logs/main-red/wal.c）：
 * - struct WalIndexHdr（wal.c:321-333，48 字节，本机字节序）：0 iVersion、12 isInit、14 szPage(u16，1 表示 65536)、16 mxFrame（wal.c:328）、
 *   40 aCksum[2]；-shm 0..47 与 48..95 是两份副本，必须逐字节一致。
 * - struct WalCkptInfo（wal.c:394-400）紧跟两份头之后，起点 96：96 nBackfill（wal.c:395）。
 * 读不到 / 副本不一致 / 校验和不符时重试，仍失败返回 undefined。不开连接、不发 PRAGMA、不碰 120..135 的锁字节（见下）。
 */
export function readWalIndexHeader(dbPath: string, tries = 3): WalIndexHeader | undefined {
  const little = endianness() === 'LE'
  for (let i = 0; i < tries; i += 1) {
    let fd: number | undefined
    let buf: Buffer | undefined
    try {
      fd = openSync(`${dbPath}-shm`, 'r')
      const b = Buffer.alloc(SHM_READ_BYTES)
      buf = b.subarray(0, readSync(fd, b, 0, SHM_READ_BYTES, 0))
    } catch { buf = undefined } finally { if (fd !== undefined) try { closeSync(fd) } catch { /* ignore */ } }
    if (!buf || buf.length < SHM_READ_BYTES) continue
    const u32 = (o: number): number => (little ? buf!.readUInt32LE(o) : buf!.readUInt32BE(o))
    if (!buf.subarray(0, 48).equals(buf.subarray(48, 96))) continue
    if (u32(0) !== SQLITE_WAL_VERSION || buf[12] !== 1) continue
    const [c1, c2] = shmChecksum(buf.subarray(0, 40), !little)
    if (c1 !== u32(40) || c2 !== u32(44)) continue
    const sz = little ? buf.readUInt16LE(14) : buf.readUInt16BE(14)
    return { mxFrame: u32(16), nBackfill: u32(96), pageSize: sz === 1 ? 65536 : sz }
  }
  return undefined
}

/**
 * 读 -shm 的 WAL-index 头算待回写字节数；-wal 不存在或为空 = 0；读不到 / 两份头副本不一致 / 校验和不符时重试，仍失败返回 undefined。
 * 只读前 100 字节（两份 WalIndexHdr + WalCkptInfo.nBackfill）：Windows 上 SQLite 用 LockFileEx 锁 -shm 的 120..135 字节
 * （os_win.c WIN_SHM_BASE = 120），这是强制锁，其他句柄 ReadFile 覆盖到被独占锁住的字节会失败（ERROR_LOCK_VIOLATION）。
 */
export function readPendingBackfillBytes(dbPath: string, tries = 3): number | undefined {
  let walSize = 0
  try { walSize = statSync(`${dbPath}-wal`).size } catch { return 0 }
  if (walSize < 32) return 0
  const h = readWalIndexHeader(dbPath, tries)
  if (!h) return undefined
  return Math.max(0, h.mxFrame - h.nBackfill) * (h.pageSize + 24)
}

/**
 * P3 PR-2b（组长 2026-10-30 批准方案 1）：大批量事务提交后，把 WAL 检查点移出主线程。
 *
 * 背景（exp-commit-profile run 41037852801）：产品库是 WAL + synchronous=NORMAL；千章替换/恢复 COMMIT 本身约 70ms，
 * 慢的是 COMMIT 末尾 SQLite 自动触发的 WAL 检查点（约 54MB WAL 写回主库 + fsync），在 Windows C: 盘上 2.7–4.1s。
 *
 * 策略：
 * - 模式用 PASSIVE：不等读者/写者、不调 busy handler，主连接的读写不会被它挡住；FULL/RESTART/TRUNCATE 要等写锁和读者，
 *   会让后台检查点与主线程的普通保存互相等待。PASSIVE 完整回写后，主连接下一次写入会从头复用 WAL（文件不再增长）。
 * - BUSY / 未回写完（checkpointed < log）时重试：最多 retries 次，每次间隔 retryDelayMs。
 * - 同时只跑一个检查点；运行中再请求只排队一次（多次请求合并成一次）。
 * - 上限：重试用尽或 worker 失败只记日志，调用方随即恢复主连接 wal_autocheckpoint 原值，交还 SQLite 自身的自动检查点；
 *   上一轮失败后的下一次批量不再暂停自动检查点（退回同步检查点：慢但 WAL 有界），后台再成功一轮才恢复延后策略。
 *   WAL 文件超过 walWarnBytes 或连续失败 ≥ failWarnCount 时告警。
 */
export interface CheckpointOutcome {
  ok: boolean
  /** worker 内 PRAGMA wal_checkpoint(PASSIVE) 累计耗时（含重试，不含重试间隔） */
  ms: number
  attempts: number
  busy?: number
  log?: number
  checkpointed?: number
  walBytes?: number
  error?: string
  /** P3 PR-44：本轮开始到结束期间主连接没有新写入（写入代数未变）；未提供 generation 时为 undefined */
  quiet?: boolean
  /** 本轮起止（墙钟 ms，Date.now()），诊断用 */
  startedAt?: number
  endedAt?: number
  /**
   * P3（wal-restart）：PASSIVE 收敛后的不等待 RESTART 结果。true = 下一次写会从 WAL 文件头开始；false = 拿不到锁 / 收敛后又有新帧 / 读不到 -shm；
   * undefined = 本轮没做（未收敛、调用方未提供 restartLog、或 restartNeeded 返回 false）。
   */
  restarted?: boolean
  restart?: RestartResult
}

/** P3（wal-restart）：一次 RESTART 尝试的结果（诊断用） */
export interface RestartResult { ok: boolean; busy?: number; log?: number; checkpointed?: number; skipped?: 'empty' | 'pending' | 'unread'; error?: string }

export interface WalCheckpointerOptions {
  retries?: number
  retryDelayMs?: number
  walWarnBytes?: number
  failWarnCount?: number
  log?: (message: string) => void
  /** 每次尝试（含重试）结束时回调；测试与诊断用 */
  onAttempt?: (attempt: { ok: boolean; ms: number; busy?: number; log?: number; checkpointed?: number; error?: string }) => void
  /** P3 PR-44：主连接写入代数（每次写入递增）；每轮开始与结束各读一次，判定本轮期间是否有新写入 */
  generation?: () => number
  /** H-W6：按量后台回写；false = 关闭（只剩批量路径与 wal_autocheckpoint 保底） */
  backfill?: { triggerBytes?: number } | false
  /** H-W6：调用方判断此刻能否按量请求（如批量暂停期间、主库已关闭时返回 false） */
  shouldTrigger?: () => boolean
  /**
   * P3（wal-restart）：PASSIVE 收敛后在主线程调用一次，由调用方在主连接上执行 PRAGMA wal_checkpoint(RESTART)（busy_timeout=0，不等待）。
   * 见 tryRestart。
   */
  restartLog?: () => { busy: number; log: number; checkpointed: number }
  /** P3（wal-restart）：此刻是否需要 RESTART（如只在批量暂停、等待恢复 autocheckpoint 时）；不提供 = 总是需要 */
  restartNeeded?: () => boolean
  /** 仅测试：注入 worker 内失败 / 延迟 / 崩溃；delaySchedule[i] = 该 worker 第 i 次尝试的延迟（超出部分为 0）；crash = 每个 worker 第一次尝试时线程直接退出 */
  inject?: { failWith?: string; delayMs?: number; delaySchedule?: number[]; crash?: boolean; nativeSpinRows?: number }
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { DatabaseSync } = require('node:sqlite')
let db
let attemptIndex = 0
parentPort.on('message', (message) => {
  if (message.type === 'close') {
    try { if (db) db.close() } catch {}
    db = undefined
    parentPort.postMessage({ type: 'closed' })
    parentPort.close()
    return
  }
  const inject = workerData.inject || {}
  const delay = Array.isArray(inject.delaySchedule) ? (inject.delaySchedule[attemptIndex] || 0) : inject.delayMs
  attemptIndex += 1
  if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
  if (inject.crash) process.exit(1)
  const started = performance.now()
  try {
    if (inject.failWith) throw new Error(inject.failWith)
    if (!db) { db = new DatabaseSync(workerData.path); db.exec('PRAGMA busy_timeout = 0') }
    // 仅测试：在 PASSIVE 前跑一条耗时的原生 SQLite 语句（递归 CTE × 读表，执行期间持 WAL 读快照）；terminate 打断不了原生调用
    if (inject.nativeSpinRows) db.prepare('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c, (SELECT 1 FROM app_settings LIMIT 1)').get(inject.nativeSpinRows)
    const row = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
    parentPort.postMessage({ type: 'done', ok: true, ms: performance.now() - started, busy: row.busy, log: row.log, checkpointed: row.checkpointed })
  } catch (error) {
    parentPort.postMessage({ type: 'done', ok: false, ms: performance.now() - started, error: String((error && error.message) || error) })
  }
})
`

type Attempt = { ok: boolean; ms: number; busy?: number; log?: number; checkpointed?: number; error?: string }

export class WalCheckpointer {
  readonly retries: number
  readonly retryDelayMs: number
  readonly walWarnBytes: number
  readonly failWarnCount: number
  /** 已完成的检查点轮次（一轮含重试） */
  runs = 0
  consecutiveFailures = 0
  last?: CheckpointOutcome
  warnings: string[] = []
  private worker?: Worker
  private pendingAttempt?: (attempt: Attempt) => void
  private running?: Promise<CheckpointOutcome>
  private queued?: Promise<CheckpointOutcome>
  private closing?: Promise<void>
  private readonly log: (message: string) => void
  /** H-W6 按量回写阈值（字节）；undefined = 关闭 */
  readonly triggerBytes?: number
  /** H-W6：按量检查读到的待回写量峰值 / 最近值、读失败次数、按量请求次数（诊断与测试） */
  pendingPeakBytes = 0
  lastPendingBytes?: number
  pendingReadFailures = 0
  backfillRequests = 0
  private checkScheduled = false

  constructor(private readonly path: string, private readonly options: WalCheckpointerOptions = {}) {
    this.retries = options.retries ?? 3
    this.retryDelayMs = options.retryDelayMs ?? 200
    this.walWarnBytes = options.walWarnBytes ?? 256 * 1024 * 1024
    this.failWarnCount = options.failWarnCount ?? 3
    this.log = options.log ?? ((message) => console.warn(message))
    this.triggerBytes = options.backfill === false ? undefined : (options.backfill?.triggerBytes ?? BACKFILL_TRIGGER_BYTES)
  }

  /** 主库读待回写量（见 readPendingBackfillBytes）；同时记峰值 */
  pendingBytes(): number | undefined {
    const value = readPendingBackfillBytes(this.path)
    if (value === undefined) this.pendingReadFailures += 1
    else {
      this.lastPendingBytes = value
      if (value > this.pendingPeakBytes) this.pendingPeakBytes = value
    }
    return value
  }

  /**
   * H-W6：主连接每次普通写事务 COMMIT 后调用。检查推迟到下一轮事件循环（setImmediate，同一轮多次提交合并为一次）：
   * 不占 COMMIT 路径；同步连续写（如建库、迁移、测试 setup）结束后再看一次。
   */
  noteCommit(): void {
    if (this.triggerBytes === undefined || this.closing || this.checkScheduled) return
    this.checkScheduled = true
    setImmediate(() => { this.checkScheduled = false; this.requestIfPending() })
  }

  /** worker 空闲且待回写 > 阈值 → 请求一次 PASSIVE；该轮成功后仍 > 阈值则立即再请求。读不到待回写量时按超阈值处理（保守）。 */
  requestIfPending(): void {
    const threshold = this.triggerBytes
    if (threshold === undefined || this.closing || this.busy) return
    try { if (this.options.shouldTrigger && !this.options.shouldTrigger()) return } catch { return }
    const pending = this.pendingBytes()
    if (pending !== undefined && pending <= threshold) return
    this.backfillRequests += 1
    void this.request().then((outcome) => { if (outcome.ok) this.requestIfPending() })
  }

  get busy(): boolean { return Boolean(this.running || this.queued) }
  /** 是否有一次尝试已发给 worker、还没回消息（worker 可能卡在 JS 里，也可能在原生 SQLite 调用里） */
  get attemptInFlight(): boolean { return Boolean(this.pendingAttempt) }
  get closed(): boolean { return Boolean(this.closing) }

  /** 请求一次后台检查点：空闲则立即开始；运行中则排队一次（多次请求合并）。永不 reject。 */
  request(): Promise<CheckpointOutcome> {
    if (this.closing) return Promise.resolve({ ok: false, ms: 0, attempts: 0, error: 'CHECKPOINTER_CLOSED' })
    if (this.queued) return this.queued
    if (this.running) {
      const queued = this.running.then(() => { this.queued = undefined; return this.start() })
      this.queued = queued
      return queued
    }
    return this.start()
  }

  /** 等到没有运行中/排队的检查点。 */
  /** P3 PR-44：等当前正在跑（无则排队中）的那一轮结束并返回其结果；都没有则 undefined。不等后续排队轮，持续写入时也能逐轮返回。 */
  currentRound(): Promise<CheckpointOutcome | undefined> {
    return this.running ?? this.queued ?? Promise.resolve(undefined)
  }

  async idle(): Promise<void> {
    while (this.queued || this.running) await (this.queued ?? this.running)
  }

  walBytes(): number {
    try { return statSync(`${this.path}-wal`).size } catch { return 0 }
  }

  /** 关闭：运行中的检查点跑完后关闭 worker 的连接并退出线程；2s 内未退出则 terminate。 */
  close(): Promise<void> {
    if (this.closing) return this.closing
    const worker = this.worker
    this.closing = !worker ? Promise.resolve() : new Promise<void>((resolve) => {
      const timer = setTimeout(() => { void worker.terminate() }, 2_000)
      worker.once('exit', () => { clearTimeout(timer); resolve() })
      worker.postMessage({ type: 'close' })
    })
    return this.closing
  }

  /** 强制结束 worker（退出超时用）：不等当前检查点，未完成的回写留在 WAL，下次打开由 SQLite 恢复。 */
  terminate(): void {
    if (!this.closing) this.closing = Promise.resolve()
    const worker = this.worker
    this.worker = undefined
    this.settleAttempt({ ok: false, ms: 0, error: 'CHECKPOINT_WORKER_TERMINATED' })
    if (worker) void worker.terminate().catch(() => { /* 已退出 */ })
  }

  private start(): Promise<CheckpointOutcome> {
    const tracked: Promise<CheckpointOutcome> = this.runRound().finally(() => { if (this.running === tracked) this.running = undefined })
    this.running = tracked
    return tracked
  }

  private async runRound(): Promise<CheckpointOutcome> {
    const startedAt = Date.now()
    const generationAtStart = this.readGeneration()
    let ms = 0
    let attempt: Attempt = { ok: false, ms: 0, error: 'CHECKPOINT_NOT_RUN' }
    let attempts = 0
    for (let i = 0; i <= this.retries; i += 1) {
      if (this.closing) break
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs))
      attempt = await this.attempt()
      attempts += 1
      try { this.options.onAttempt?.(attempt) } catch { /* 回调失败不影响 */ }
      ms += attempt.ms
      const complete = attempt.ok && attempt.busy === 0 && (attempt.checkpointed ?? 0) >= (attempt.log ?? 0)
      if (complete) break
    }
    const complete = attempt.ok && attempt.busy === 0 && (attempt.checkpointed ?? 0) >= (attempt.log ?? 0)
    let restart: RestartResult | undefined
    if (complete && !this.closing && this.options.restartLog) restart = this.tryRestart()
    const outcome: CheckpointOutcome = {
      restarted: restart?.ok, restart,
      ok: complete, ms: Math.round(ms), attempts, busy: attempt.busy, log: attempt.log, checkpointed: attempt.checkpointed,
      walBytes: this.walBytes(), startedAt, endedAt: Date.now(),
      quiet: generationAtStart === undefined ? undefined : this.readGeneration() === generationAtStart,
      error: complete ? undefined : (attempt.error ?? `CHECKPOINT_INCOMPLETE:busy=${attempt.busy}:log=${attempt.log}:checkpointed=${attempt.checkpointed}`)
    }
    this.runs += 1
    this.last = outcome
    this.consecutiveFailures = complete ? 0 : this.consecutiveFailures + 1
    if (!complete) this.warn(`[wal-checkpoint] background checkpoint failed after ${attempts} attempt(s): ${outcome.error}; falling back to SQLite auto-checkpoint`)
    if (this.consecutiveFailures >= this.failWarnCount) this.warn(`[wal-checkpoint] ${this.consecutiveFailures} consecutive failures`)
    if ((outcome.walBytes ?? 0) > this.walWarnBytes) this.warn(`[wal-checkpoint] WAL file ${outcome.walBytes} bytes exceeds ${this.walWarnBytes}`)
    return outcome
  }

  /**
   * P3（wal-restart）：worker 的 PASSIVE 收敛（checkpointed == log）后，把 WAL 拉回文件头。
   * - 先读 -shm：mxFrame == 0 → 已在文件头；nBackfill < mxFrame（收敛后主连接又写了帧）→ 不做（RESTART 会在主线程同步回写这些帧），
   *   交给下一轮；读不到 → 不做。
   * - 否则由调用方在主连接上执行 PRAGMA wal_checkpoint(RESTART)。此时 nBackfill == mxFrame，没有帧要回写（wal.c walCheckpoint 中
   *   mxSafeFrame ≤ nBackfill 时不拷页、不 fsync），只尝试 WAL_WRITE_LOCK（wal.c:4459）和 WAL_READ_LOCK(1..N-1) 排他锁（wal.c:2445-2449）。
   *   busy_timeout=0：拿不到锁立即返回 busy=1，不等待。成功 = 当时没有读者占用非 0 read mark，且 nBackfill == mxFrame 后新读者只用
   *   READ_LOCK(0)，所以下一次写的 walRestartLog（wal.c:3976-3997）必然从文件头写起。
   * - 在主连接上做而不是在 worker 里做：RESTART/TRUNCATE 要拿 WAL_WRITE_LOCK，worker 持有期间主连接的 BEGIN IMMEDIATE（busy_timeout=0）
   *   会直接 SQLITE_BUSY，保存失败；主线程单线程，执行 RESTART 时主连接不可能在事务中，不会和保存抢写锁。
   */
  private tryRestart(): RestartResult | undefined {
    try { if (this.options.restartNeeded && !this.options.restartNeeded()) return undefined } catch { return undefined }
    const h = readWalIndexHeader(this.path)
    if (!h) return { ok: false, skipped: 'unread' }
    if (h.mxFrame === 0) return { ok: true, skipped: 'empty' }
    if (h.nBackfill < h.mxFrame) return { ok: false, skipped: 'pending' }
    try {
      const row = this.options.restartLog!()
      return { ok: row.busy === 0 && row.checkpointed >= row.log, busy: row.busy, log: row.log, checkpointed: row.checkpointed }
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message ?? error) }
    }
  }

  private readGeneration(): number | undefined {
    try { return this.options.generation?.() } catch { return undefined }
  }

  private warn(message: string): void {
    this.warnings.push(message)
    try { this.log(message) } catch { /* 日志失败不影响 */ }
  }

  private attempt(): Promise<Attempt> {
    return new Promise<Attempt>((resolve) => {
      try {
        const worker = this.ensureWorker()
        this.pendingAttempt = resolve
        worker.postMessage({ type: 'checkpoint' })
      } catch (error) {
        resolve({ ok: false, ms: 0, error: `CHECKPOINT_WORKER_START_FAILED:${(error as Error).message}` })
      }
    })
  }

  private settleAttempt(attempt: Attempt): void {
    const pending = this.pendingAttempt
    this.pendingAttempt = undefined
    pending?.(attempt)
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { path: this.path, inject: this.options.inject ?? {} } })
    worker.unref()
    worker.on('message', (message: { type: string } & Attempt) => {
      if (message.type === 'done') this.settleAttempt({ ok: message.ok, ms: message.ms, busy: message.busy, log: message.log, checkpointed: message.checkpointed, error: message.error })
    })
    worker.on('error', (error) => { this.settleAttempt({ ok: false, ms: 0, error: `CHECKPOINT_WORKER_ERROR:${error.message}` }) })
    worker.on('exit', () => {
      if (this.worker === worker) this.worker = undefined
      this.settleAttempt({ ok: false, ms: 0, error: 'CHECKPOINT_WORKER_EXITED' })
    })
    this.worker = worker
    return worker
  }
}
