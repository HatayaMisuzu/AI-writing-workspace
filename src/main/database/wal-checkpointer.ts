import { Worker } from 'node:worker_threads'
import { statSync } from 'node:fs'
import { diagMark } from '../diag/save-trace'

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
}

export interface WalCheckpointerOptions {
  retries?: number
  retryDelayMs?: number
  walWarnBytes?: number
  failWarnCount?: number
  log?: (message: string) => void
  /** 每次尝试（含重试）结束时回调；测试与诊断用 */
  onAttempt?: (attempt: { ok: boolean; ms: number; busy?: number; log?: number; checkpointed?: number; error?: string }) => void
  /** 仅测试：注入 worker 内失败 / 延迟 */
  inject?: { failWith?: string; delayMs?: number }
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { DatabaseSync } = require('node:sqlite')
let db
parentPort.on('message', (message) => {
  if (message.type === 'close') {
    try { if (db) db.close() } catch {}
    db = undefined
    parentPort.postMessage({ type: 'closed' })
    parentPort.close()
    return
  }
  const inject = workerData.inject || {}
  if (inject.delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, inject.delayMs)
  const started = performance.now()
  try {
    if (inject.failWith) throw new Error(inject.failWith)
    if (!db) { db = new DatabaseSync(workerData.path); db.exec('PRAGMA busy_timeout = 0') }
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

  constructor(private readonly path: string, private readonly options: WalCheckpointerOptions = {}) {
    this.retries = options.retries ?? 3
    this.retryDelayMs = options.retryDelayMs ?? 200
    this.walWarnBytes = options.walWarnBytes ?? 256 * 1024 * 1024
    this.failWarnCount = options.failWarnCount ?? 3
    this.log = options.log ?? ((message) => console.warn(message))
  }

  get busy(): boolean { return Boolean(this.running || this.queued) }
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

  private start(): Promise<CheckpointOutcome> {
    const tracked: Promise<CheckpointOutcome> = this.runRound().finally(() => { if (this.running === tracked) this.running = undefined })
    this.running = tracked
    return tracked
  }

  private async runRound(): Promise<CheckpointOutcome> {
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
    const outcome: CheckpointOutcome = {
      ok: complete, ms: Math.round(ms), attempts, busy: attempt.busy, log: attempt.log, checkpointed: attempt.checkpointed,
      walBytes: this.walBytes(), error: complete ? undefined : (attempt.error ?? `CHECKPOINT_INCOMPLETE:busy=${attempt.busy}:log=${attempt.log}:checkpointed=${attempt.checkpointed}`)
    }
    this.runs += 1
    this.last = outcome
    this.consecutiveFailures = complete ? 0 : this.consecutiveFailures + 1
    if (!complete) this.warn(`[wal-checkpoint] background checkpoint failed after ${attempts} attempt(s): ${outcome.error}; falling back to SQLite auto-checkpoint`)
    if (this.consecutiveFailures >= this.failWarnCount) this.warn(`[wal-checkpoint] ${this.consecutiveFailures} consecutive failures`)
    if ((outcome.walBytes ?? 0) > this.walWarnBytes) this.warn(`[wal-checkpoint] WAL file ${outcome.walBytes} bytes exceeds ${this.walWarnBytes}`)
    return outcome
  }

  private warn(message: string): void {
    this.warnings.push(message)
    try { this.log(message) } catch { /* 日志失败不影响 */ }
  }

  private attempt(): Promise<Attempt> {
    return new Promise<Attempt>((resolve) => {
      try {
        const worker = this.ensureWorker()
        this.pendingAttempt = (attempt) => { diagMark('cp:attempt-end', { ok: attempt.ok, workerMs: attempt.ms, busy: attempt.busy, log: attempt.log, checkpointed: attempt.checkpointed, error: attempt.error }); resolve(attempt) }
        diagMark('cp:attempt-start', { walBytes: this.walBytes() })
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
