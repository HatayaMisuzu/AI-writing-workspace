/**
 * P3（A）main 红 run 41186632942：P3 book-replace 替换后第一次保存 COMMIT 77.51ms（上限 50ms）。
 * 推断（/workspace/eng-logs/main-red-2/REPORT.md I1/I2）：后台 worker 只做 PASSIVE，checkpointed == log 后 WAL 没有回到文件头
 * （walRestartLog 需要 WAL_READ_LOCK(1..N-1) 排他锁，拿不到 BUSY 被吞，wal.c:3986/3999），新帧接在约 1.2 万帧之后，
 * mxFrame ≥ 主连接 wal_autocheckpoint（4096 页 → 1527 页），于是 COMMIT 里同步做检查点。
 *
 * 复现：真实临时库，批量写出远超阈值的 WAL → 在 worker PASSIVE 开始前用另一条连接开读事务占住非 0 的 read mark →
 * worker PASSIVE 收敛（checkpointed == log）→ 小保存 → 释放读连接 → 再一次小保存。
 * 修复设计（wal-checkpointer）：PASSIVE 收敛后做一次不等待的 RESTART，确认下一次写会从 WAL 文件头开始后才恢复 wal_autocheckpoint；
 * 拿不到锁（读连接仍占 read mark）时不恢复，下一轮再试。所以断言是：
 *   (a) 保存时要么 autocheckpoint 尚未恢复（=0），要么本次写从文件头开始（mxFrame 很小）；
 *   (b) COMMIT 里没有同步回写（nBackfill 前后不变，且后台 worker 不在跑）。
 * 断言不依赖计时。诊断字段见 CommitRecord（database.ts）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { Worker } from 'node:worker_threads'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase, type CommitRecord } from '../src/main/database/database'
import { autoCheckpointPagesFor, readWalIndexHeader } from '../src/main/database/wal-checkpointer'
import { ProjectService } from '../src/main/services/project-service'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 })
const dirs: string[] = []
const dbs: AppDatabase[] = []
const readers: DatabaseSync[] = []
/** 删临时目录前必须等检查点 worker 真正 'exit'（Windows 上 worker 连接未关时 unlink 会 EBUSY），同 backfill-bound-hw6 / quit-timeout-p42 */
const workers = new Set<Worker>()
const workerOf = (db: AppDatabase): Worker | undefined => (db.checkpointer as unknown as { worker?: Worker } | undefined)?.worker
const exited = (w: Worker): Promise<void> => new Promise((resolve) => { if (w.threadId < 0) resolve(); else { w.once('exit', () => resolve()); if (w.threadId < 0) resolve() } })
afterEach(async () => {
  for (const r of readers.splice(0)) { try { r.exec('COMMIT') } catch { /* 无事务 */ } try { r.close() } catch { /* ignore */ } }
  for (const db of dbs.splice(0)) {
    const w = workerOf(db); if (w) workers.add(w)
    await db.closeAsync()
  }
  for (const w of [...workers]) { await exited(w); workers.delete(w) }
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'inkstone-walrestart-')); dirs.push(d); return d }
const log = (tag: string, data: unknown): void => { process.stdout.write(`WALRESTART ${tag} ${process.platform} ${JSON.stringify(data)}\n`) }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const THRESHOLD = autoCheckpointPagesFor(4096)

function open() {
  const path = join(tempDir(), 'inkstone.sqlite')
  // worker 每次尝试前等 300ms：保证读连接在 PASSIVE 开始前拿到读快照（read mark 为非 0 槽位、值 = 批量后的 mxFrame）
  const db = new AppDatabase(path, { checkpointer: { inject: { delayMs: 300 } } }); dbs.push(db)
  new ProjectService(db).create({ title: 'WAL 复用', projectType: 'novel', description: '' })
  return { db, path, cp: db.checkpointer! }
}
type S = ReturnType<typeof open>

/** 批量写约 45MB（远超 1527 页阈值），走产品批量入口 bulkTransaction（暂停 autocheckpoint + 释放循环） */
function bulkFill(s: S): void {
  const blob = JSON.stringify('写'.repeat(10_000))
  s.db.bulkTransaction(() => {
    const st = s.db.raw.prepare('INSERT INTO app_settings(key, value_json, updated_at) VALUES (?, ?, ?)')
    for (let i = 0; i < 1500; i += 1) st.run(`wal-restart-fill-${i}`, blob, Date.now())
  })
}

/** 另一条连接开读事务：此时 nBackfill < mxFrame，读者拿非 0 的 read mark，walRestartLog 拿不到 WAL_READ_LOCK(1..N-1) */
function holdReader(s: S): DatabaseSync {
  const r = new DatabaseSync(s.path); readers.push(r)
  r.exec('BEGIN')
  r.prepare('SELECT count(*) AS n FROM app_settings').get()
  return r
}

/** 等 worker 的一轮 PASSIVE 收敛（checkpointed == log）；不等释放循环（修复后读连接占锁时释放不会发生） */
async function waitConverged(s: S, runsBefore: number): Promise<void> {
  const started = Date.now()
  while (!(s.cp.runs > runsBefore && s.cp.last?.ok && s.cp.last.checkpointed === s.cp.last.log)) {
    if (Date.now() - started > 60_000) throw new Error(`PASSIVE 未收敛: ${JSON.stringify(s.cp.last)}`)
    await sleep(20)
  }
  await sleep(50) // 让释放循环（未修复代码）有机会恢复 autocheckpoint
}

let seq = 0
/** 小保存：数据库层写事务（走 transaction()，commit 记录带诊断字段） */
function smallSave(s: S): CommitRecord {
  seq += 1
  s.db.transaction(() => {
    s.db.raw.prepare(`INSERT INTO app_settings(key, value_json, updated_at) VALUES ('wal-restart-small', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`).run(JSON.stringify(`后来加的${seq}`), Date.now())
  })
  return s.db.commits.at(-1)!
}

describe('P3 后台 PASSIVE 收敛后的第一次保存不在 COMMIT 里同步检查点', () => {
  it('读连接占住非 0 read mark：保存时要么未恢复 autocheckpoint、要么 WAL 已回文件头；释放读连接后的保存 COMMIT 内无同步回写', async () => {
    const s = open()
    const runsBefore = s.cp.runs
    bulkFill(s)
    const reader = holdReader(s)
    const afterBulk = readWalIndexHeader(s.path)
    expect(afterBulk && afterBulk.mxFrame).toBeGreaterThan(THRESHOLD * 4)
    await waitConverged(s, runsBefore)
    const autoAtSave1 = s.db.autoCheckpoint
    const shmAtSave1 = readWalIndexHeader(s.path)
    const save1 = smallSave(s)
    reader.exec('COMMIT')
    const autoAtSave2 = s.db.autoCheckpoint
    const save2 = smallSave(s)
    log('held-reader', { threshold: THRESHOLD, afterBulk, last: s.cp.last, autoAtSave1, shmAtSave1, save1, autoAtSave2, save2 })
    // (a) 修复后：读连接占锁 → RESTART 拿不到锁 → autocheckpoint 不恢复；或者本次写已从文件头开始
    expect.soft(autoAtSave1 === 0 || (save1.mxFrameAfter ?? Infinity) < THRESHOLD, `save1 autoCheckpoint=${autoAtSave1} mxFrameBefore=${save1.mxFrameBefore} mxFrameAfter=${save1.mxFrameAfter} walRestarted=${save1.walRestarted}`).toBe(true)
    // (b) COMMIT 里没有同步回写
    // checkpointerBusy 只记录不断言：修复后 save1 在暂停期间提交会请求补做一轮，worker 此时处于注入的 300ms 延迟中（未开始 PASSIVE），nBackfill 不会被它改动
    expect.soft(save2.backfilledInCommit, `save2 COMMIT 内同步回写：autoCheckpoint=${autoAtSave2} nBackfill ${save2.nBackfillBefore}→${save2.nBackfillAfter} mxFrame ${save2.mxFrameBefore}→${save2.mxFrameAfter} commitMs=${save2.commitMs}`).toBe(false)
    expect.soft(save1.backfilledInCommit, `save1 nBackfill ${save1.nBackfillBefore}→${save1.nBackfillAfter}`).toBe(false)
    // 读连接释放后：后台 PASSIVE 回写 save1/save2 的帧，一次小保存之后 autocheckpoint 已恢复（组长批准：不再要求写入前恢复），之后的保存从文件头写起
    await s.cp.request(); await s.cp.idle()
    const saveR = smallSave(s)
    log('restore-save', { mxFrameBefore: saveR.mxFrameBefore, mxFrameAfter: saveR.mxFrameAfter, saveR, autoAfter: s.db.autoCheckpoint })
    // COMMIT 内 nBackfill 不变（测试侧按原始字段判定，不依赖诊断公式：walRestartLog 会把 nBackfill 清 0（wal.c:2235 walRestartHdr），此时只要求 nBackfillAfter == 0）
    expect(saveR.walRestarted ? saveR.nBackfillAfter === 0 : saveR.nBackfillAfter === saveR.nBackfillBefore, `restore-save nBackfill ${saveR.nBackfillBefore}→${saveR.nBackfillAfter} mxFrame ${saveR.mxFrameBefore}→${saveR.mxFrameAfter}`).toBe(true)
    expect(s.db.autoCheckpoint).toBe(THRESHOLD)
    const save3 = smallSave(s)
    log('after-release', { release: s.db.releases.at(-1), save3 })
    expect(save3.backfilledInCommit).toBe(false)
    expect(save3.mxFrameAfter).toBeLessThan(THRESHOLD)
  })

  it('读连接在保存前释放：恢复 autocheckpoint 后第一次保存从 WAL 文件头写起、COMMIT 内无同步回写', async () => {
    const s = open()
    const runsBefore = s.cp.runs
    bulkFill(s)
    const reader = holdReader(s)
    await waitConverged(s, runsBefore)
    reader.exec('COMMIT')
    await s.cp.idle()
    const save = smallSave(s)
    log('released-reader', { mxFrameBefore: save.mxFrameBefore, mxFrameAfter: save.mxFrameAfter, last: s.cp.last, release: s.db.releases.at(-1), save })
    // 一次小保存之后 autocheckpoint 已恢复（组长批准：不再要求写入前恢复）
    expect(s.db.autoCheckpoint).toBe(THRESHOLD)
    expect(save.walRestarted).toBe(true)
    expect(save.mxFrameAfter).toBeLessThan(THRESHOLD)
    expect(save.backfilledInCommit).toBe(false)
  })
})
