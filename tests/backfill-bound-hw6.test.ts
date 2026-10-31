/**
 * P3 H-W6：普通保存按待回写量触发后台 PASSIVE，wal_autocheckpoint（≈8MB）只作保底。
 * 1) 连续 300 次大章保存，待回写峰值 ≤ 8MB（硬断言）；记录 COMMIT p95 / 最坏值，与同 runner 的 A1000 对照（checkpointer:false = 旧 1000 页 autocheckpoint）。
 * 2) 退出不与进行中的 PASSIVE 互卡（#51 closeForQuit 三段预算）。
 * 3) 回写失败 / worker 崩溃：保底接管，待回写仍 ≤ 8MB，重开 integrity_check ok、正文完整。
 * 待回写量用产品同一读法 readPendingBackfillBytes（只读 -shm 0..99 字节）；同时用 tests/helpers/wal-index 的 136 字节读法对照，只记失败次数。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase, QUIT_CLOSE_LIMIT_MS, QUIT_WORKER_LIMIT_MS, type AppDatabaseOptions } from '../src/main/database/database'
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
  it('300 次连续大章保存：待回写峰值 ≤ 8MB；产品读法读 -shm 零失败；保底页数 = 8MB 帧', async () => {
    const s = open()
    const cp = s.db.checkpointer!
    expect(s.db.autoCheckpoint).toBe(autoCheckpointPagesFor(4096))
    expect(s.db.autoCheckpoint).toBe(2036)
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
    // WalCheckpointer.close() 自带 2s terminate：worker 卡住时在 worker 段硬上限（3500ms）之前就被结束，closeForQuit 不必走超时分支
    expect(result.timedOut).toBe(false)
    expect(result.segments!.workerMs).toBeLessThan(QUIT_WORKER_LIMIT_MS)
    if (delayMs > 2_000) expect(result.segments!.workerMs).toBeGreaterThanOrEqual(1_900)
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
    expect(s.db.autoCheckpoint).toBe(2036)
    expect(r.unread).toBe(0)
    expect(r.peak).toBeLessThanOrEqual(BACKFILL_BOUND_BYTES)
    expect(s.docs.getContent(s.project.id, s.chapter.id).plainText).toBe(text(119))
    await s.db.closeAsync()
    const reopened = new AppDatabase(s.path, { checkpointer: false }); dbs.push(reopened)
    expect(integrity(reopened)).toBe('ok')
    expect(new DocumentService(reopened).getContent(s.project.id, s.chapter.id).plainText).toBe(text(119))
  })
})
