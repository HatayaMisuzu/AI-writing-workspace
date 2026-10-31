/**
 * P3（wal-restart ④）：批量释放时 WAL 未回文件头 → 等待态（wal_autocheckpoint 保持 0），普通写自然 walRestartLog 后恢复；兜底与 -shm 坏头回退。
 * 全部确定性：用 await cp.idle() / checkpointIdle()、帧数与注入的时钟/定时器，不 sleep 计时。Linux 与 Windows job 都跑，打印 mxFrame 前后值。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { Worker } from 'node:worker_threads'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase, RESTART_WAIT_MAX_MS, RESTART_WAIT_MAX_PENDING_BYTES, type AppDatabaseOptions, type CommitRecord } from '../src/main/database/database'
import { BACKFILL_TRIGGER_BYTES, autoCheckpointPagesFor, readShmHead, readWalIndexHeader } from '../src/main/database/wal-checkpointer'
import { ProjectService } from '../src/main/services/project-service'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 })
const dirs: string[] = []
const dbs: AppDatabase[] = []
const readers: DatabaseSync[] = []
const workers = new Set<Worker>()
const workerOf = (db: AppDatabase): Worker | undefined => (db.checkpointer as unknown as { worker?: Worker } | undefined)?.worker
const exited = (w: Worker): Promise<void> => new Promise((resolve) => { if (w.threadId < 0) resolve(); else { w.once('exit', () => resolve()); if (w.threadId < 0) resolve() } })
afterEach(async () => {
  vi.restoreAllMocks()
  for (const r of readers.splice(0)) { try { r.exec('COMMIT') } catch { /* 无事务 */ } try { r.close() } catch { /* ignore */ } }
  for (const db of dbs.splice(0)) { const w = workerOf(db); if (w) workers.add(w); await db.closeAsync() }
  for (const w of [...workers]) { await exited(w); workers.delete(w) }
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
const log = (tag: string, data: unknown): void => { process.stdout.write(`WALWAIT ${tag} ${process.platform} ${JSON.stringify(data)}\n`) }
const THRESHOLD = autoCheckpointPagesFor(4096)
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

function open(options: AppDatabaseOptions = {}) {
  const d = mkdtempSync(join(tmpdir(), 'inkstone-walwait-')); dirs.push(d)
  const path = join(d, 'inkstone.sqlite')
  const db = new AppDatabase(path, options); dbs.push(db)
  new ProjectService(db).create({ title: 'WAL 等待态', projectType: 'novel', description: '' })
  return { db, path, cp: db.checkpointer! }
}
type S = ReturnType<typeof open>

function bulkFill(s: S): void {
  const blob = JSON.stringify('写'.repeat(10_000))
  s.db.bulkTransaction(() => {
    const st = s.db.raw.prepare('INSERT INTO app_settings(key, value_json, updated_at) VALUES (?, ?, ?)')
    for (let i = 0; i < 1500; i += 1) st.run(`wal-wait-fill-${i}`, blob, Date.now())
  })
}
let seq = 0
function save(s: S, chars = 10): CommitRecord {
  seq += 1
  s.db.transaction(() => {
    s.db.raw.prepare(`INSERT INTO app_settings(key, value_json, updated_at) VALUES ('wal-wait-small', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`).run(JSON.stringify(`${seq}`.padEnd(chars, '字')), Date.now())
  })
  return s.db.commits.at(-1)!
}
function holdReader(s: S): DatabaseSync {
  const r = new DatabaseSync(s.path); readers.push(r)
  r.exec('BEGIN'); r.prepare('SELECT count(*) AS n FROM app_settings').get()
  return r
}
const pendingBytes = (path: string): number => { const h = readWalIndexHeader(path)!; return (h.mxFrame - h.nBackfill) * (h.pageSize + 24) }

describe('P3 ④ 等待态：WAL 回文件头后才恢复 wal_autocheckpoint', () => {
  it('T2 无读者：释放 → 等待态（释放记录 waiting）→ 一次小保存从文件头写起、COMMIT 内 nBackfill 不变 → 恢复（restored-after-restart），兜底未触发', async () => {
    const s = open()
    bulkFill(s)
    await s.db.checkpointIdle()
    const rel = s.db.releases.at(-1)!
    expect(rel.reason).toBe('quiet')
    expect(rel.autoCheckpointRestore).toBe('waiting')
    expect(s.db.autoCheckpoint).toBe(0)
    expect(s.db.restartWaitTimerActive).toBe(true)
    const r = save(s)
    log('T2-restart', { mxFrameBefore: r.mxFrameBefore, mxFrameAfter: r.mxFrameAfter, nBackfillBefore: r.nBackfillBefore, nBackfillAfter: r.nBackfillAfter, commitMs: r.commitMs })
    expect(r.walRestarted).toBe(true)
    expect(r.mxFrameAfter).toBeLessThan(THRESHOLD)
    expect(r.backfilledInCommit).toBe(false)
    expect(s.db.autoCheckpoint).toBe(THRESHOLD)
    expect(rel.autoCheckpointRestore).toBe('restored-after-restart')
    expect(s.db.restartWaitTimerActive).toBe(false)
    expect(s.db.restartWaitDiag).toMatchObject({ waits: 1, restored: 1, fallbackCount: 0, waiting: false })
  })

  it('T3 无长期读者：恢复后持续保存，-wal 文件不再增长、待回写 ≤ 1MB 触发阈值 + 单次提交（帧数口径）', async () => {
    const s = open()
    bulkFill(s)
    await s.db.checkpointIdle()
    save(s)
    expect(s.db.autoCheckpoint).toBe(THRESHOLD)
    const walAfterBulk = statSync(`${s.path}-wal`).size
    let maxCommitBytes = 0
    for (let i = 0; i < 40; i += 1) {
      const r = save(s, 60_000)
      maxCommitBytes = Math.max(maxCommitBytes, ((r.mxFrameAfter ?? 0) - (r.mxFrameBefore ?? 0)) * 4120)
      await tick(); await s.cp.idle()
      expect(pendingBytes(s.path)).toBeLessThanOrEqual(BACKFILL_TRIGGER_BYTES + maxCommitBytes)
      expect(r.backfilledInCommit).toBe(false)
    }
    const walEnd = statSync(`${s.path}-wal`).size
    log('T3-bound', { walAfterBulk, walEnd, maxCommitBytes, last: readWalIndexHeader(s.path) })
    expect(walEnd).toBeLessThanOrEqual(walAfterBulk)
    expect(s.db.restartWaitDiag.fallbackCount).toBe(0)
  })

  it('T1+T4 读者一直占 read mark：等待态下保存 COMMIT 内 nBackfill 不变，积压 = 读者之后写入的帧；超过 6MB → 兜底 pending 恢复并记日志', async () => {
    const s = open()
    bulkFill(s)
    const reader = holdReader(s)
    await s.db.checkpointIdle()
    expect(s.db.releases.at(-1)!.autoCheckpointRestore).toBe('waiting')
    const base = readWalIndexHeader(s.path)!
    expect(base.nBackfill).toBe(base.mxFrame)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // 同步连续写：noteCommit 推迟到 setImmediate，worker 不会插进来，兜底原因确定为 pending
    let n = 0
    while (s.db.restartWaitDiag.waiting) {
      const r = save(s, 200_000)
      n += 1
      expect(r.backfilledInCommit).toBe(false)
      expect(r.nBackfillAfter).toBe(base.nBackfill)
      expect(n).toBeLessThan(200)
    }
    const h = readWalIndexHeader(s.path)!
    log('T1-held', { base, now: h, saves: n, diag: s.db.restartWaitDiag })
    expect((h.mxFrame - h.nBackfill) * (h.pageSize + 24)).toBeGreaterThan(RESTART_WAIT_MAX_PENDING_BYTES)
    expect(h.nBackfill).toBe(base.nBackfill)
    expect(s.db.restartWaitDiag.fallbackCount).toBe(1)
    expect(s.db.restartWaitDiag.fallbacks[0].reason).toBe('pending')
    expect(s.db.autoCheckpoint).toBe(THRESHOLD)
    expect(s.db.releases.at(-1)!.autoCheckpointRestore).toBe('fallback-pending')
    expect(warn.mock.calls.some(([m]) => String(m).includes('restart-wait fallback (pending)'))).toBe(true)
    reader.exec('COMMIT')
  })

  it('T4b 没有任何写入：假定时器到 30s → 兜底 timeout 恢复原值（不真等）', async () => {
    let now = 1_000
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
    const s = open({ restartWait: {
      now: () => now,
      timers: { set: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t }, clear: (t) => { (t as { cleared: boolean }).cleared = true } }
    } })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    bulkFill(s)
    await s.db.checkpointIdle()
    expect(s.db.autoCheckpoint).toBe(0)
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(RESTART_WAIT_MAX_MS)
    now += RESTART_WAIT_MAX_MS
    timers[0].fn()
    expect(s.db.autoCheckpoint).toBe(THRESHOLD)
    expect(s.db.restartWaitDiag.fallbacks.map((f) => f.reason)).toEqual(['timeout'])
    expect(s.db.releases.at(-1)!.autoCheckpointRestore).toBe('fallback-timeout')
  })

  it('close / closeForQuit 清掉 30s 定时器；之后定时器回调不再碰已关闭的连接', async () => {
    for (const closer of ['close', 'closeForQuit'] as const) {
      const timers: Array<{ fn: () => void; cleared: boolean }> = []
      const s = open({ restartWait: { timers: { set: (fn) => { const t = { fn, cleared: false }; timers.push(t); return t }, clear: (t) => { (t as { cleared: boolean }).cleared = true } } } })
      bulkFill(s)
      await s.db.checkpointIdle()
      expect(s.db.restartWaitTimerActive).toBe(true)
      if (closer === 'close') { const w = workerOf(s.db); if (w) workers.add(w); s.db.close() } else await s.db.closeForQuit()
      expect(timers[0].cleared).toBe(true)
      expect(s.db.restartWaitTimerActive).toBe(false)
      expect(() => timers[0].fn()).not.toThrow()
      expect(s.db.restartWaitDiag.fallbackCount).toBe(0)
    }
  })
})

describe('P3 ④ -shm 头校验失败 → 立即恢复 autocheckpoint 并记日志', () => {
  const corruptions: Array<[string, (b: Buffer) => Buffer | undefined]> = [
    ['读文件失败', () => undefined],
    ['iVersion ≠ 3007000', (b) => { const c = Buffer.from(b); c[0] ^= 0xff; c[48] ^= 0xff; return c }],
    ['两份头副本不一致', (b) => { const c = Buffer.from(b); c[48 + 16] ^= 0x01; return c }],
    ['校验和不符（两份副本同改 mxFrame）', (b) => { const c = Buffer.from(b); c[16] ^= 0x01; c[48 + 16] ^= 0x01; return c }]
  ]
  for (const [name, corrupt] of corruptions) it(`释放时：${name}`, async () => {
    let bad = false
    let path = ''
    const s = open({ restartWait: { readShmHead: () => { const b = readShmHead(path); return bad && b ? corrupt(b) : bad ? undefined : b } } })
    path = s.path
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    bad = true
    bulkFill(s)
    await s.db.checkpointIdle()
    expect(s.db.autoCheckpoint).toBe(THRESHOLD)
    expect(s.db.restartWaitDiag.fallbacks.map((f) => f.reason)).toEqual(['bad-header'])
    expect(s.db.releases.at(-1)!.autoCheckpointRestore).toBe('fallback-bad-header')
    expect(warn.mock.calls.some(([m]) => String(m).includes('restart-wait fallback (bad-header)'))).toBe(true)
  })
  it('等待态中的 COMMIT 后：头校验失败 → 恢复并记日志', async () => {
    let bad = false
    let path = ''
    const s = open({ restartWait: { readShmHead: () => { const b = readShmHead(path); if (!bad || !b) return b; const c = Buffer.from(b); c[48 + 16] ^= 0x01; return c } } })
    path = s.path
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    bulkFill(s)
    await s.db.checkpointIdle()
    expect(s.db.autoCheckpoint).toBe(0)
    bad = true
    save(s)
    expect(s.db.autoCheckpoint).toBe(THRESHOLD)
    expect(s.db.restartWaitDiag.fallbacks.map((f) => f.reason)).toEqual(['bad-header'])
    expect(warn.mock.calls.some(([m]) => String(m).includes('restart-wait fallback (bad-header)'))).toBe(true)
  })
})
