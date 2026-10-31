/**
 * P3 PR-42：will-quit 的 closeForQuit 5s 上限。
 * - 进程内：worker 关闭永不完成 → 上限到点 terminate worker、关主连接，重开库完整（确定性覆盖超时分支）。
 * - 子进程（不打包，node 直接运行产品 TS 源码，同 wal-checkpoint-p3 F 组）：worker 卡在检查点里不回消息 / worker 线程已死，
 *   待回写量（(mxFrame − nBackfill) × 帧大小）≤ WAL_QUIT_BOUND_BYTES 时总时长 < QUIT_CLOSE_LIMIT_MS（P3 PR-53：worker 段硬上限 limit − reserve + 退出前检查点 + close），
 *   重开后 integrity_check ok、正文与快照逐章哈希一致。WAL 超过 N 的用例只断言数据不丢、只记录耗时。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AppDatabase, QUIT_CLOSE_LIMIT_MS, QUIT_FINAL_RESERVE_MS, QUIT_WORKER_LIMIT_MS, WAL_QUIT_BOUND_BYTES } from '../src/main/database/database'
import { WalCheckpointer } from '../src/main/database/wal-checkpointer'
import type { Worker } from 'node:worker_threads'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { chapterHashes } from './fixtures/wal-hash'
import { pendingBackfillBytes } from './helpers/wal-index'
import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 })
// P3 PR-53：WAL 约 47KB/章（#48 记录 200 章 ≈ 9.4MB）
const CHAPTERS_WITHIN = 120
const CHAPTERS_OVER = 400
const dirs: string[] = []
const dbs: AppDatabase[] = []
/** 测试侧记录检查点 worker（含被 terminate 的）：删临时目录前等它们真正 'exit'（Windows 上 worker 连接未关时 unlink 会 EBUSY） */
const workers = new Set<Worker>()
const workerOf = (cp: WalCheckpointer | undefined): Worker | undefined => (cp as unknown as { worker?: Worker } | undefined)?.worker
const originalTerminate = WalCheckpointer.prototype.terminate
WalCheckpointer.prototype.terminate = function (this: WalCheckpointer) { const w = workerOf(this); if (w) workers.add(w); originalTerminate.call(this) }
const exited = (w: Worker): Promise<void> => new Promise((resolve) => { if (w.threadId < 0) resolve(); else { w.once('exit', () => resolve()); if (w.threadId < 0) resolve() } })
afterEach(async () => {
  for (const db of dbs.splice(0)) {
    const w = workerOf(db.checkpointer); if (w) workers.add(w)
    await db.closeAsync()
  }
  for (const w of [...workers]) { await exited(w); workers.delete(w) }
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'inkstone-quit-')); dirs.push(dir); return dir }
const log = (line: string): void => { process.stdout.write(`P42 quit-timeout ${process.platform}: ${line}\n`) }
const doc = (text: string): Record<string, unknown> => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const integrity = (db: AppDatabase): string => (db.raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check

describe('closeForQuit 上限（进程内）', () => {
  it('上限常量为 5000ms；worker 段硬上限 = 5000 − 预留', () => {
    expect(QUIT_CLOSE_LIMIT_MS).toBe(5_000)
    expect(QUIT_WORKER_LIMIT_MS).toBe(QUIT_CLOSE_LIMIT_MS - QUIT_FINAL_RESERVE_MS)
    expect(QUIT_FINAL_RESERVE_MS).toBeGreaterThan(0)
  })

  it('worker 关闭永不完成：到上限即 terminate worker、关闭主连接，重开 integrity_check ok、数据完整', async () => {
    const path = join(tempDir(), 'inkstone.sqlite')
    // H-W6 方案①后：worker 卡在尝试里会被立即 terminate（见 backfill-bound-hw6 / p42 子进程用例）；本用例改测「worker 空闲但 close 永不完成」的超时分支
    const db = new AppDatabase(path, { checkpointer: { retries: 0 } }); dbs.push(db)
    const project = new ProjectService(db).create({ title: '退出书', projectType: 'novel', description: '' })
    const docs = new DocumentService(db)
    const chapter = docs.listTree(project.id).find((n) => n.type === 'chapter')!
    const text = '退出前写入的正文。'.repeat(50)
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: doc(text), plainText: text })
    const current = docs.getContent(project.id, chapter.id)
    const replaced = text.replaceAll('正文', '内容')
    docs.replaceBatch({ projectId: project.id, items: [{ documentId: chapter.id, expectedRevision: current.revision, editorJson: doc(replaced), plainText: replaced, hits: 50 }], query: '正文', replacement: '内容', regex: false, caseSensitive: false })
    const cp = db.checkpointer!
    await db.checkpointIdle()
    expect(cp.attemptInFlight).toBe(false)
    const expected = chapterHashes(db.raw, project.id)
    const terminate = vi.spyOn(cp, 'terminate')
    cp.close = () => new Promise<void>(() => { /* 模拟 worker 永不回 closed */ })
    // limit 1800 − reserve 1500 = worker 段 300ms
    const result = await db.closeForQuit(1_800, 1_500)
    expect(result.timedOut).toBe(true)
    expect(result.segments!.workerLimitMs).toBe(300)
    expect(result.segments!.workerMs).toBeGreaterThanOrEqual(290)
    expect(result.segments!.workerMs).toBeLessThan(300 + 1_000)
    expect(result.ms).toBeLessThan(1_800)
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(db.closed).toBe(true)
    expect((cp as unknown as { worker?: unknown }).worker).toBeUndefined()
    const reopened = new AppDatabase(path, { checkpointer: false }); dbs.push(reopened)
    expect(integrity(reopened)).toBe('ok')
    expect(chapterHashes(reopened.raw, project.id)).toEqual(expected)
    expect(new DocumentService(reopened).getContent(project.id, chapter.id).plainText).toBe(replaced)
    log(`in-process never-closing worker: ${JSON.stringify(result)}`)
  })

  it('已关闭的库再次 closeForQuit 立即返回', async () => {
    const db = new AppDatabase(join(tempDir(), 'inkstone.sqlite')); dbs.push(db)
    db.close()
    expect(await db.closeForQuit()).toEqual({ timedOut: false, ms: 0 })
  })
})

describe('closeForQuit 上限（子进程，产品源码不打包）', () => {
  const child = resolve('tests/fixtures/wal-crash-child.ts')
  const nodeArgs = ['--experimental-transform-types', '--no-warnings', '--import', pathToFileURL(resolve('tests/fixtures/ts-resolve-hook.mjs')).href]
  type Ready = { status: Record<string, unknown>; projectId: string; hashes: ReturnType<typeof chapterHashes> }
  type Closed = { timedOut: boolean; ms: number; limitMs: number; mainClosed: boolean; segments: { workerMs: number; checkpointMs: number; mainCloseMs: number; walBytesBeforeCheckpoint: number; walBytesBeforeClose: number; checkpointOk: boolean; workerLimitMs: number; walBytesAtQuit: number; pendingBytesAtQuit: number } }
  const run = (dbPath: string, mode: string, chapters: number) => new Promise<{ ready: Ready; closed: Closed; exitAfterReadyMs: number; code: number | null }>((done, fail) => {
    const proc = spawn(process.execPath, [...nodeArgs, child, dbPath, mode, String(chapters)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''; let err = ''; let readyAt = 0
    const timer = setTimeout(() => { proc.kill('SIGKILL'); fail(new Error(`child ${mode} timeout; stdout ${out.slice(-500)}; stderr ${err}`)) }, 100_000)
    proc.stderr.on('data', (c) => { err += c })
    proc.stdout.on('data', (c) => { out += c; if (!readyAt && out.includes('READY ')) readyAt = performance.now() })
    proc.once('exit', (code) => {
      clearTimeout(timer)
      const exitedAt = performance.now()
      const lines = out.split('\n')
      const readyLine = lines.find((l) => l.startsWith('READY '))
      const closedLine = lines.find((l) => l.startsWith('CLOSED '))
      if (!readyLine || !closedLine) { fail(new Error(`child ${mode} exited ${code} without READY/CLOSED; stderr ${err}`)); return }
      // 日志开关 INKSTONE_QUIT_TEST_DIAG=1：只打子进程 QDIAG 时间线，不改行为
      if (process.env.INKSTONE_QUIT_TEST_DIAG === '1') log(`${mode} child QDIAG:\n${err.split('\n').filter((l) => l.startsWith('QDIAG')).join('\n')}`)
      done({ ready: JSON.parse(readyLine.slice(6)), closed: JSON.parse(closedLine.slice(7)), exitAfterReadyMs: Math.round(exitedAt - readyAt), code })
    })
  })
  // 章数 → WAL 大小（每章约 47KB WAL）：within = ≤ N（断言总时长 < 上限）；over = 超过 N（只断言数据不丢、只记录耗时）
  const cases: Array<{ mode: 'quit-stuck' | 'quit-dead'; chapters: number; bound: 'within' | 'over' }> = [
    { mode: 'quit-stuck', chapters: CHAPTERS_WITHIN, bound: 'within' },
    { mode: 'quit-dead', chapters: CHAPTERS_WITHIN, bound: 'within' },
    { mode: 'quit-stuck', chapters: CHAPTERS_OVER, bound: 'over' }
  ]
  for (const { mode, chapters, bound } of cases) it(`退出时 ${mode === 'quit-stuck' ? 'worker 卡在检查点里不回消息' : 'worker 线程已死'}（${chapters} 章，WAL ${bound === 'within' ? '≤' : '>'} N）：${bound === 'within' ? '总时长 < 上限' : '只断言数据不丢'}，重开 integrity_check ok、逐章数据完整`, async () => {
    const dbPath = join(tempDir(), 'quit.sqlite')
    const r = await run(dbPath, mode, chapters)
    log(`${mode} ${bound} ${chapters}ch: ${JSON.stringify({ closed: r.closed, exitAfterReadyMs: r.exitAfterReadyMs, code: r.code, status: { ...r.ready.status, attempts: undefined } })}`)
    expect(r.code).toBe(0)
    expect(r.closed.limitMs).toBe(5_000)
    expect(r.closed.mainClosed).toBe(true)
    log(`${mode} ${bound} segments: ${JSON.stringify(r.closed.segments)}`)
    // worker 段硬上限（设计保证）：limit − reserve；stuck 立即 terminate（H-W6 方案①），dead 立即完成，都不走超时
    expect(r.closed.timedOut).toBe(false)
    expect(r.closed.segments.workerLimitMs).toBe(QUIT_WORKER_LIMIT_MS)
    expect(r.closed.segments.workerMs).toBeLessThan(QUIT_WORKER_LIMIT_MS)
    // H-W6 方案①：worker 卡在尝试里时立即 terminate，等 worker 段 < 100ms（不再等 close() 的 2s）
    expect(r.closed.segments.workerMs).toBeLessThan(100)
    if (bound === 'within') {
      // 前提：退出时待回写量在 N 以内
      expect(r.closed.segments.pendingBytesAtQuit).toBeGreaterThan(0)
      expect(r.closed.segments.pendingBytesAtQuit).toBeLessThanOrEqual(WAL_QUIT_BOUND_BYTES)
      // 总时长（含退出前检查点 + 主连接 close）< 上限
      expect(r.closed.ms).toBeLessThan(QUIT_CLOSE_LIMIT_MS)
      expect(r.exitAfterReadyMs).toBeLessThan(QUIT_CLOSE_LIMIT_MS)
    } else {
      expect(r.closed.segments.pendingBytesAtQuit).toBeGreaterThan(WAL_QUIT_BOUND_BYTES)
      log(`over-N timing (not asserted): ms=${r.closed.ms} exitAfterReadyMs=${r.exitAfterReadyMs}`)
    }
    // 退出前 TRUNCATE 成功 → close 前 -wal 已截断到 0（-wal 文件不会跨退出保持大小）
    expect(r.closed.segments.checkpointOk).toBe(true)
    expect(r.closed.segments.walBytesBeforeClose).toBe(0)
    if (mode === 'quit-stuck') expect(r.ready.status.busy).toBe(true)
    const reopened = new AppDatabase(dbPath, { checkpointer: false }); dbs.push(reopened)
    expect(integrity(reopened)).toBe('ok')
    const hashes = chapterHashes(reopened.raw, r.ready.projectId)
    expect(Object.keys(hashes)).toHaveLength(chapters)
    expect(hashes).toEqual(r.ready.hashes)
  })
})

describe('P3 PR-53：待回写量口径的边界（进程内）', () => {
  const fill = (db: AppDatabase, mb: number): { projectId: string; chapterId: string; text: string } => {
    const project = new ProjectService(db).create({ title: '大日志', projectType: 'novel', description: '' })
    const docs = new DocumentService(db)
    const chapterId = docs.listTree(project.id).find((n) => n.type === 'chapter')!.id
    db.raw.exec('PRAGMA wal_autocheckpoint = 0')
    let text = ''
    for (let i = 0; statSync(`${db.path}-wal`).size < mb * 1024 * 1024; i += 1) {
      text = `第${i}版` + '林舟看见远处灯，远处灯又亮了。风从北面吹来。'.repeat(400)
      docs.saveContent({ projectId: project.id, documentId: chapterId, editorJson: doc(text), plainText: text })
    }
    return { projectId: project.id, chapterId, text }
  }

  it('-wal 文件约 45MB 但已回写完（待回写量 0）：退出快（< 预留），-wal 截断到 0，数据完整', async () => {
    const path = join(tempDir(), 'big.sqlite')
    const db = new AppDatabase(path); dbs.push(db)
    const { projectId, chapterId, text } = fill(db, 45)
    const outcome = await db.checkpointer!.request()
    expect(outcome.ok).toBe(true)
    const walBytes = statSync(`${path}-wal`).size
    expect(walBytes).toBeGreaterThan(40 * 1024 * 1024)
    expect(pendingBackfillBytes(path)).toBe(0)
    const result = await db.closeForQuit()
    log(`big-wal-backfilled: walBytes=${walBytes} ${JSON.stringify(result)}`)
    expect(result.segments!.checkpointOk).toBe(true)
    expect(result.segments!.walBytesBeforeClose).toBe(0)
    expect(result.segments!.checkpointMs + result.segments!.mainCloseMs).toBeLessThan(QUIT_FINAL_RESERVE_MS)
    expect(result.ms).toBeLessThan(QUIT_CLOSE_LIMIT_MS)
    const reopened = new AppDatabase(path, { checkpointer: false }); dbs.push(reopened)
    expect(integrity(reopened)).toBe('ok')
    expect(new DocumentService(reopened).getContent(projectId, chapterId).plainText).toBe(text)
  })

  it('读事务一直占着、PASSIVE 回写不完：退出不超预算（检查点 BUSY 只记录，close 非最后连接不回写），重开数据完整', async () => {
    const path = join(tempDir(), 'pinned.sqlite')
    const db = new AppDatabase(path); dbs.push(db)
    const project = new ProjectService(db).create({ title: '钉住', projectType: 'novel', description: '' })
    const docs = new DocumentService(db)
    const chapterId = docs.listTree(project.id).find((n) => n.type === 'chapter')!.id
    db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.raw.exec('PRAGMA wal_autocheckpoint = 0')
    const reader = new DatabaseSync(path)
    reader.exec('BEGIN')
    reader.prepare('SELECT COUNT(*) AS n FROM document_contents').get()
    let text = ''
    for (let i = 0; i < 300; i += 1) {
      text = `第${i}版` + '林舟看见远处灯，远处灯又亮了。风从北面吹来。'.repeat(400)
      docs.saveContent({ projectId: project.id, documentId: chapterId, editorJson: doc(text), plainText: text })
    }
    const passive = await db.checkpointer!.request()
    expect(passive.ok).toBe(false)
    const pending = pendingBackfillBytes(path)
    expect(pending).toBeGreaterThan(0)
    const result = await db.closeForQuit()
    log(`reader-pinned: pending=${pending} passive=${JSON.stringify({ ok: passive.ok, busy: passive.busy, log: passive.log, checkpointed: passive.checkpointed })} ${JSON.stringify(result)}`)
    expect(result.timedOut).toBe(false)
    expect(result.segments!.checkpointOk).toBe(false)
    expect(result.ms).toBeLessThan(QUIT_CLOSE_LIMIT_MS)
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0)
    reader.exec('COMMIT')
    reader.close()
    const reopened = new AppDatabase(path, { checkpointer: false }); dbs.push(reopened)
    expect(integrity(reopened)).toBe('ok')
    expect(new DocumentService(reopened).getContent(project.id, chapterId).plainText).toBe(text)
  })
})
