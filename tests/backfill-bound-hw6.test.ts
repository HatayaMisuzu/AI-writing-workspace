/**
 * P3 H-W6：普通保存按待回写量触发后台 PASSIVE，wal_autocheckpoint（≈8MB）只作保底。
 * 1) 连续 300 次大章保存，待回写峰值 ≤ 8MB（硬断言）；记录 COMMIT p95 / 最坏值，与同 runner 的 A1000 对照（checkpointer:false = 旧 1000 页 autocheckpoint）。
 * 2) 退出不与进行中的 PASSIVE 互卡（#51 closeForQuit 三段预算）。
 * 3) 回写失败 / worker 崩溃：保底接管，待回写仍 ≤ 8MB，重开 integrity_check ok、正文完整。
 * 待回写量用产品同一读法 readPendingBackfillBytes（只读 -shm 0..99 字节）；同时用 tests/helpers/wal-index 的 136 字节读法对照，只记失败次数。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase, QUIT_CLOSE_LIMIT_MS, type AppDatabaseOptions } from '../src/main/database/database'
import { BACKFILL_BOUND_BYTES, autoCheckpointPagesFor, readPendingBackfillBytes, type WalCheckpointerOptions } from '../src/main/database/wal-checkpointer'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { readWalState } from './helpers/wal-index'

vi.setConfig({ testTimeout: 300_000 })
const dirs: string[] = []
const dbs: AppDatabase[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) { try { db.close() } catch { /* 已关闭 */ } }
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'inkstone-hw6fix-')); dirs.push(d); return d }
const log = (tag: string, data: unknown): void => { process.stdout.write(`${tag} ${process.platform} ${JSON.stringify(data)}\n`) }
const doc = (text: string): Record<string, unknown> => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const integrity = (db: AppDatabase): string => (db.raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const r2 = (x: number): number => Math.round(x * 100) / 100
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const q = (f: number): number => (s.length ? r2(s[Math.min(s.length - 1, Math.ceil(f * s.length) - 1)]) : 0)
  return { n: s.length, median: q(0.5), p95: q(0.95), max: q(1) }
}
// 与诊断分支同规格：约 4.8 万字的大章，每次整章保存
const SENT = '林舟看见远处灯，远处灯又亮了。风从北面吹来。'
const REP = 2000
const text = (i: number): string => `第${i}次保存` + SENT.repeat(REP)

function open(options: AppDatabaseOptions = {}, path = join(tempDir(), 'inkstone.sqlite')) {
  const db = new AppDatabase(path, options); dbs.push(db)
  const project = new ProjectService(db).create({ title: '大章', projectType: 'novel', description: '' })
  const docs = new DocumentService(db)
  const chapter = docs.listTree(project.id).find((n) => n.type === 'chapter')!
  return { db, docs, project, chapter, path }
}
type S = ReturnType<typeof open>

/** 每次保存模拟一条独立的 IPC 消息（之间让出事件循环）；每次提交后读待回写量 */
async function saveRun(s: S, n: number, gapMs = 0) {
  const save: number[] = []; const commit: number[] = []
  let peak = 0; let unread = 0; let helperUnread = 0; let slow = 0
  for (let i = 0; i < n; i += 1) {
    const t = performance.now()
    s.docs.saveContent({ projectId: s.project.id, documentId: s.chapter.id, editorJson: doc(text(i)), plainText: text(i) })
    save.push(performance.now() - t)
    const c = s.db.commits.at(-1)!.commitMs
    commit.push(c)
    if (c > 50) slow += 1
    const pending = readPendingBackfillBytes(s.path)
    if (pending === undefined) unread += 1; else if (pending > peak) peak = pending
    const h = readWalState(s.path, 1)
    if (!h.wal.ok || !h.shm.ok) helperUnread += 1
    if (gapMs > 0) await sleep(gapMs); else await tick()
  }
  return { save, commit, peak, unread, helperUnread, slow }
}

describe('H-W6 1：连续保存的待回写上界', () => {
  it('300 次连续大章保存：待回写峰值 ≤ 8MB；产品读法读 -shm 零失败；保底页数 = floor(7MB / 4120) = 1781', async () => {
    const s = open()
    const cp = s.db.checkpointer!
    expect(s.db.autoCheckpoint).toBe(autoCheckpointPagesFor(4096))
    expect(s.db.autoCheckpoint).toBe(1781)
    const started = performance.now()
    const r = await saveRun(s, 300)
    const totalMs = Math.round(performance.now() - started)
    await s.db.checkpointIdle()
    log('HW6FIX', {
      scenario: 'burst-300', group: 'fix', totalMs, save: stats(r.save), commit: stats(r.commit), slowCommits: r.slow,
      pendingPeakBytes: r.peak, cpPendingPeakBytes: cp.pendingPeakBytes, unreadSnaps: r.unread, helper136Unread: r.helperUnread,
      backfillRequests: cp.backfillRequests, runs: cp.runs, pendingReadFailures: cp.pendingReadFailures, last: cp.last
    })
    expect(r.unread).toBe(0)
    expect(r.peak).toBeLessThanOrEqual(BACKFILL_BOUND_BYTES)
    expect(cp.pendingPeakBytes).toBeLessThanOrEqual(BACKFILL_BOUND_BYTES)
    expect(cp.backfillRequests).toBeGreaterThan(0)
    expect(s.docs.getContent(s.project.id, s.chapter.id).plainText).toBe(text(299))
  })

  it('间隔 250ms 的 120 次大章保存：待回写峰值 ≤ 8MB（记录 COMMIT 分布）', async () => {
    const s = open()
    const cp = s.db.checkpointer!
    const r = await saveRun(s, 120, 250)
    await s.db.checkpointIdle()
    log('HW6FIX', { scenario: 'gap250-120', group: 'fix', save: stats(r.save), commit: stats(r.commit), slowCommits: r.slow, pendingPeakBytes: r.peak, unreadSnaps: r.unread, helper136Unread: r.helperUnread, backfillRequests: cp.backfillRequests, runs: cp.runs })
    expect(r.unread).toBe(0)
    expect(r.peak).toBeLessThanOrEqual(BACKFILL_BOUND_BYTES)
  })

  it('对照（只记录）：同 runner 上 A1000（checkpointer:false，wal_autocheckpoint 1000 页）300 次连续保存', async () => {
    const s = open({ checkpointer: false })
    expect(s.db.autoCheckpoint).toBe(1000)
    const r = await saveRun(s, 300)
    log('HW6FIX', { scenario: 'burst-300', group: 'A-1000-control', save: stats(r.save), commit: stats(r.commit), slowCommits: r.slow, pendingPeakBytes: r.peak })
    expect(r.commit).toHaveLength(300)
  })
})

describe('H-W6 2：退出不与进行中的 PASSIVE 互卡（#51 closeForQuit 三段预算）', () => {
  for (const delayMs of [1_500, 8_000]) it(`按量 PASSIVE 进行中退出（worker 内延迟 ${delayMs}ms）：总时长 < ${QUIT_CLOSE_LIMIT_MS}ms，重开 integrity_check ok、正文完整`, async () => {
    const s = open({ checkpointer: { inject: { delayMs }, retries: 0 } })
    const r = await saveRun(s, 20)
    const cp = s.db.checkpointer!
    expect(cp.backfillRequests).toBeGreaterThan(0)
    expect(cp.busy).toBe(true)
    const result = await s.db.closeForQuit()
    log('HW6FIX-QUIT', { delayMs, peak: r.peak, result })
    expect(result.ms).toBeLessThan(QUIT_CLOSE_LIMIT_MS)
    // H-W6 方案①：worker 卡在尝试里（JS 层）→ closeForQuit 立即 terminate，等 worker 段 < 100ms
    expect(result.timedOut).toBe(false)
    expect(result.segments!.terminatedInFlight).toBe(true)
    expect(result.segments!.workerMs).toBeLessThan(100)
    expect(result.segments!.checkpointOk).toBe(true)
    const reopened = new AppDatabase(s.path, { checkpointer: false }); dbs.push(reopened)
    expect(integrity(reopened)).toBe('ok')
    expect(new DocumentService(reopened).getContent(s.project.id, s.chapter.id).plainText).toBe(text(19))
  })

  it('无注入：300 次连续保存后立刻退出（PASSIVE 可能正在 SQLite 里回写）：总时长 < 上限，数据完整', async () => {
    const s = open()
    await saveRun(s, 300)
    const busy = s.db.checkpointer!.busy
    const result = await s.db.closeForQuit()
    log('HW6FIX-QUIT', { delayMs: 0, busyAtQuit: busy, result })
    expect(result.ms).toBeLessThan(QUIT_CLOSE_LIMIT_MS)
    const reopened = new AppDatabase(s.path, { checkpointer: false }); dbs.push(reopened)
    expect(integrity(reopened)).toBe('ok')
    expect(new DocumentService(reopened).getContent(s.project.id, s.chapter.id).plainText).toBe(text(299))
  })
})

describe('H-W6 3：回写失败 / worker 崩溃 → 保底接管、数据完整', () => {
  const faults: Array<[string, WalCheckpointerOptions['inject']]> = [
    ['PASSIVE 一直失败', { failWith: 'INJECTED_BACKFILL_FAIL' }],
    ['worker 线程每次都崩溃退出', { crash: true }]
  ]
  for (const [name, inject] of faults) it(`${name}：120 次连续保存，待回写仍 ≤ 8MB（wal_autocheckpoint 保底），重开 integrity_check ok、正文完整`, async () => {
    const s = open({ checkpointer: { inject, retries: 1, retryDelayMs: 20, log: () => undefined } })
    const cp = s.db.checkpointer!
    const r = await saveRun(s, 120)
    await s.db.checkpointIdle()
    log('HW6FIX-FAULT', { fault: name, commit: stats(r.commit), pendingPeakBytes: r.peak, backfillRequests: cp.backfillRequests, runs: cp.runs, consecutiveFailures: cp.consecutiveFailures, last: cp.last })
    expect(cp.backfillRequests).toBeGreaterThan(0)
    expect(cp.last?.ok).toBe(false)
    expect(cp.consecutiveFailures).toBeGreaterThan(0)
    expect(s.db.autoCheckpoint).toBe(1781)
    expect(r.unread).toBe(0)
    expect(r.peak).toBeLessThanOrEqual(BACKFILL_BOUND_BYTES)
    expect(s.docs.getContent(s.project.id, s.chapter.id).plainText).toBe(text(119))
    await s.db.closeAsync()
    const reopened = new AppDatabase(s.path, { checkpointer: false }); dbs.push(reopened)
    expect(integrity(reopened)).toBe('ok')
    expect(new DocumentService(reopened).getContent(s.project.id, s.chapter.id).plainText).toBe(text(119))
  })
})

describe('H-W6 4：保底页数按实际 page_size 计算', () => {
  it('公式：floor(7340032 / (page_size + 24))', () => {
    expect(autoCheckpointPagesFor(4096)).toBe(1781)
    expect(autoCheckpointPagesFor(8192)).toBe(893)
    expect(autoCheckpointPagesFor(65536)).toBe(111)
  })

  it('page_size=8192 的库：启动时读 PRAGMA page_size，wal_autocheckpoint 实际为 893；回写失败时 120 次连续保存待回写 ≤ 8MB，重开数据完整', async () => {
    const path = join(tempDir(), 'p8192.sqlite')
    const pre = new DatabaseSync(path)
    pre.exec('PRAGMA page_size = 8192')
    pre.exec('CREATE TABLE _page_size_probe(x INTEGER)')
    pre.close()
    const s = open({ checkpointer: { inject: { failWith: 'INJECTED_BACKFILL_FAIL' }, retries: 1, retryDelayMs: 20, log: () => undefined } }, path)
    expect(Number((s.db.raw.prepare('PRAGMA page_size').get() as { page_size: number }).page_size)).toBe(8192)
    expect(s.db.autoCheckpoint).toBe(893)
    const cp = s.db.checkpointer!
    const r = await saveRun(s, 120)
    await s.db.checkpointIdle()
    log('HW6FIX-FAULT', { fault: 'PASSIVE 一直失败（page_size=8192）', commit: stats(r.commit), pendingPeakBytes: r.peak, backfillRequests: cp.backfillRequests, runs: cp.runs })
    expect(cp.last?.ok).toBe(false)
    expect(r.unread).toBe(0)
    expect(r.peak).toBeLessThanOrEqual(BACKFILL_BOUND_BYTES)
    expect(s.db.autoCheckpoint).toBe(893)
    await s.db.closeAsync()
    const reopened = new AppDatabase(s.path, { checkpointer: false }); dbs.push(reopened)
    expect(integrity(reopened)).toBe('ok')
    expect(new DocumentService(reopened).getContent(s.project.id, s.chapter.id).plainText).toBe(text(119))
  })
})

describe('H-W6 5：退出时 worker 卡在原生 SQLite 调用里（terminate 打断不了）', () => {
  it('worker 正在执行耗时的原生语句（持 WAL 读快照）：立即 terminate，退出 < 5s；TRUNCATE 若 busy 只记录（checkpointOk=false），close 不做检查点、WAL 保留；重开 integrity_check ok、最后一次保存在', async () => {
    const s = open({ checkpointer: { inject: { nativeSpinRows: 30_000_000 }, retries: 0, backfill: false } })
    // 主连接 busy_timeout = 0：TRUNCATE 遇到 CKPT 锁 / 读者不会等待
    expect(Number((s.db.raw.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout)).toBe(0)
    for (let i = 0; i < 20; i += 1) s.docs.saveContent({ projectId: s.project.id, documentId: s.chapter.id, editorJson: doc(text(i)), plainText: text(i) })
    const cp = s.db.checkpointer!
    const worker = () => (cp as unknown as { worker?: { once(e: 'exit', f: () => void): void } }).worker
    void cp.request()
    // 等 worker 起来并进入原生语句（线程启动 + 开连接）
    await sleep(500)
    expect(cp.attemptInFlight).toBe(true)
    const w = worker()!
    let exitedAt = 0
    const exited = new Promise<void>((r) => w.once('exit', () => { exitedAt = performance.now(); r() }))
    const quitStarted = performance.now()
    const result = await s.db.closeForQuit()
    const quitEnded = performance.now()
    // 最后一次保存在：重开（worker 线程可能仍在原生语句里、连接未关）
    const reopened = new AppDatabase(s.path, { checkpointer: false }); dbs.push(reopened)
    const integrityResult = integrity(reopened)
    const lastText = new DocumentService(reopened).getContent(s.project.id, s.chapter.id).plainText
    reopened.close()
    // 等 worker 线程真正退出再清理目录（Windows 上打开的文件删不掉）
    await Promise.race([exited, sleep(60_000)])
    log('HW6FIX-QUIT-NATIVE', { result, workerExitAfterQuitMs: exitedAt ? Math.round(exitedAt - quitStarted) : null, quitMs: Math.round(quitEnded - quitStarted) })
    expect(result.segments!.terminatedInFlight).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.segments!.workerMs).toBeLessThan(100)
    expect(result.ms).toBeLessThan(QUIT_CLOSE_LIMIT_MS)
    expect(integrityResult).toBe('ok')
    expect(lastText).toBe(text(19))
  })

  it('真实耗时 PASSIVE 进行中退出（千章级大 WAL，按量回写关闭、立即请求后退出）：退出 < 5s；记录 TRUNCATE 是否 busy；重开 integrity_check ok、最后一次保存在', async () => {
    const s = open({ checkpointer: { retries: 0, backfill: false } })
    // 约 60MB 待回写：批量写入期间暂停自动检查点（同全书替换路径）
    s.db.raw.exec('PRAGMA wal_autocheckpoint = 0')
    for (let i = 0; i < 240; i += 1) s.docs.saveContent({ projectId: s.project.id, documentId: s.chapter.id, editorJson: doc(text(i)), plainText: text(i) })
    const pending = readPendingBackfillBytes(s.path)
    const cp = s.db.checkpointer!
    void cp.request()
    // worker 起线程、开连接后开始 PASSIVE；在它回写途中退出
    await new Promise<void>((r) => { const t0 = performance.now(); const poll = () => { const p = readPendingBackfillBytes(s.path); if ((p !== undefined && pending !== undefined && p < pending) || performance.now() - t0 > 3_000) r(); else setTimeout(poll, 1) }; poll() })
    const inFlight = cp.attemptInFlight
    const w = (cp as unknown as { worker?: { once(e: 'exit', f: () => void): void } }).worker
    const exited = w ? new Promise<void>((r) => w.once('exit', () => r())) : Promise.resolve()
    const result = await s.db.closeForQuit()
    const reopened = new AppDatabase(s.path, { checkpointer: false }); dbs.push(reopened)
    const integrityResult = integrity(reopened)
    const lastText = new DocumentService(reopened).getContent(s.project.id, s.chapter.id).plainText
    reopened.close()
    await Promise.race([exited, sleep(60_000)])
    log('HW6FIX-QUIT-PASSIVE', { pendingAtStart: pending, inFlightAtQuit: inFlight, result })
    expect(result.timedOut).toBe(false)
    expect(result.segments!.workerMs).toBeLessThan(100)
    expect(result.ms).toBeLessThan(QUIT_CLOSE_LIMIT_MS)
    expect(integrityResult).toBe('ok')
    expect(lastText).toBe(text(239))
  })
})
