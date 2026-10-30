import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AppDatabase, type AppDatabaseOptions } from '../src/main/database/database'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { WritingDailyService } from '../src/main/services/writing-daily-service'
import { BackupService } from '../src/main/services/backup-service'
import { chapterHashes } from './fixtures/wal-hash'

// P3 PR-2b（组长 2026-10-30 批准方案 1）：批量提交暂停自动检查点 + 后台 worker PASSIVE 检查点。
// 根因（exp-commit-profile run 41037852801）：产品库是 WAL + NORMAL；千章 COMMIT 本身约 70ms，慢在 COMMIT 内自动 WAL 检查点
// （约 54MB 写回主库 + fsync），Windows C: 盘 2.7–4.1s。临时目录 tmpdir() 在 Windows runner 上就是 C:\Users\...\Temp。

type Stage = 'snapshot' | 'write'
class FaultyDocuments extends DocumentService {
  fault?: { stage: Stage; index: number; message?: string }
  protected override onBatchStep(stage: Stage, index: number): void {
    if (this.fault && this.fault.stage === stage && this.fault.index === index) throw new Error(this.fault.message ?? `INJECTED_${stage}_${index}`)
  }
}
const doc = (text: string): Record<string, unknown> => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const body = (i: number): string => `第${i + 1}章：` + '林舟看见远处灯，远处灯又亮了。风从北面吹来。'.repeat(120)
const meta = { query: '远处灯', replacement: '远处星', regex: false, caseSensitive: false }
const ORIGINAL = 777
vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 })

const dirs: string[] = []
const dbs: AppDatabase[] = []
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.closeAsync().catch(() => undefined)
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'inkstone-wal-')); dirs.push(dir); return dir }

function setup(count: number, options: AppDatabaseOptions = {}, path = join(tempDir(), 'inkstone.sqlite')) {
  const db = new AppDatabase(path, options); dbs.push(db)
  const daily = new WritingDailyService(db)
  const docs = new FaultyDocuments(db, daily)
  const project = new ProjectService(db).create({ title: '检查点书', projectType: 'novel', description: '' })
  const tree = docs.listTree(project.id)
  const volume = tree.find((n) => n.type === 'volume')!
  const ids = [tree.find((n) => n.type === 'chapter')!.id]
  for (let i = 1; i < count; i += 1) ids.push(docs.createNode({ projectId: project.id, parentId: volume.id, type: 'chapter', title: `第${i + 1}章` }).id)
  ids.forEach((id, i) => docs.saveContent({ projectId: project.id, documentId: id, editorJson: doc(body(i)), plainText: body(i) }))
  db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.raw.exec(`PRAGMA wal_autocheckpoint = ${ORIGINAL}`)
  return { db, docs, project, ids, path }
}
type S = ReturnType<typeof setup>
const items = (s: S, from = '远处灯', to = '远处星') => s.ids.map((id) => {
  const current = s.docs.getContent(s.project.id, id)
  const text = current.plainText.replaceAll(from, to)
  return { documentId: id, expectedRevision: current.revision, editorJson: doc(text), plainText: text, hits: 240 }
})
const save = (s: S, id: string, suffix: string): number => {
  const current = s.docs.getContent(s.project.id, id)
  const started = performance.now()
  s.docs.saveContent({ projectId: s.project.id, documentId: id, editorJson: doc(current.plainText + suffix), plainText: current.plainText + suffix, expectedRevision: current.revision })
  return performance.now() - started
}
const log = (line: string): void => { process.stdout.write(`P3 wal-checkpoint ${process.platform}: ${line}\n`) }

describe('A / 1：暂停自动检查点，失败路径 finally 立即恢复原值', () => {
  const faults: Array<[string, { stage: Stage; index: number; message?: string }]> = [
    ['中途章（第 3 章写完后）抛错', { stage: 'write', index: 2 }],
    ['首章写完后抛错', { stage: 'write', index: 0 }],
    ['末章写完后抛错', { stage: 'write', index: 4 }],
    ['写快照时抛错', { stage: 'snapshot', index: 2 }],
    ['中途取消（BOOK_REPLACE_CANCELLED）', { stage: 'write', index: 1, message: 'BOOK_REPLACE_CANCELLED' }]
  ]
  for (const [name, fault] of faults) it(`replaceBatch 失败注入：${name} → wal_autocheckpoint 恢复 ${ORIGINAL}，不触发后台检查点`, () => {
    const s = setup(5)
    s.docs.fault = fault
    expect(() => s.docs.replaceBatch({ projectId: s.project.id, items: items(s), ...meta })).toThrow(fault.message ?? `INJECTED_${fault.stage}_${fault.index}`)
    expect(s.db.autoCheckpoint).toBe(ORIGINAL)
    expect(s.db.checkpointer?.busy).toBe(false)
    expect(s.db.checkpointer?.runs).toBe(0)
  })
  it('replaceBatch 批量失败（revision 冲突）→ 恢复原值', () => {
    const s = setup(3)
    const list = items(s); list[1] = { ...list[1], expectedRevision: list[1].expectedRevision + 9 }
    expect(() => s.docs.replaceBatch({ projectId: s.project.id, items: list, ...meta })).toThrow('REVISION_CONFLICT')
    expect(s.db.autoCheckpoint).toBe(ORIGINAL)
  })
  for (const [name, fault] of faults) it(`restoreBatch 恢复失败：${name} → 回滚且 wal_autocheckpoint 恢复原值`, async () => {
    const s = setup(5)
    const result = s.docs.replaceBatch({ projectId: s.project.id, items: items(s), ...meta })
    await s.db.checkpointIdle()
    expect(s.db.autoCheckpoint).toBe(ORIGINAL)
    const before = chapterHashes(s.db.raw, s.project.id)
    s.docs.fault = fault
    expect(() => s.docs.restoreBatch(s.project.id, result.batchId)).toThrow()
    expect(s.db.autoCheckpoint).toBe(ORIGINAL)
    expect(chapterHashes(s.db.raw, s.project.id)).toEqual(before)
  })
  it('成功提交：检查点结束前保持 0，结束后恢复原值；:memory: 库与 checkpointer:false 立即恢复', async () => {
    const s = setup(5, { checkpointer: { inject: { delayMs: 300 } } })
    s.docs.replaceBatch({ projectId: s.project.id, items: items(s), ...meta })
    expect(s.db.autoCheckpoint).toBe(0)
    expect(s.db.checkpointer?.busy).toBe(true)
    await s.db.checkpointIdle()
    expect(s.db.autoCheckpoint).toBe(ORIGINAL)
    expect(s.db.checkpointer?.last).toMatchObject({ ok: true, busy: 0 })
    const off = setup(3, { checkpointer: false })
    off.docs.replaceBatch({ projectId: off.project.id, items: items(off), ...meta })
    expect(off.db.checkpointer).toBeUndefined()
    expect(off.db.autoCheckpoint).toBe(ORIGINAL)
  })
})

describe('B：后台检查点策略（PASSIVE、重试、一直失败的上限与告警）', () => {
  it('PASSIVE 一轮回写全部帧：checkpointed == log、busy == 0；worker 源码只用 PASSIVE', async () => {
    const s = setup(50)
    s.docs.replaceBatch({ projectId: s.project.id, items: items(s), ...meta })
    await s.db.checkpointIdle()
    const last = s.db.checkpointer!.last!
    expect(last.ok).toBe(true); expect(last.attempts).toBe(1)
    expect(last.log).toBeGreaterThan(0); expect(last.checkpointed).toBe(last.log)
    const source = readFileSync(resolve('src/main/database/wal-checkpointer.ts'), 'utf8')
    expect(source).toContain("PRAGMA wal_checkpoint(PASSIVE)")
    expect(source).not.toMatch(/wal_checkpoint\((FULL|RESTART|TRUNCATE)\)/)
  })
  it('一直失败（注入）：重试 retries 次、按间隔；只记日志不影响已提交数据；恢复原值；连续失败告警；下一次批量退化为同步检查点，WAL 有界', async () => {
    const logs: string[] = []
    const s = setup(200, { checkpointer: { inject: { failWith: 'INJECTED_CHECKPOINT_FAIL' }, retries: 2, retryDelayMs: 50, failWarnCount: 1, walWarnBytes: 1, log: (m) => logs.push(m) } })
    const started = performance.now()
    const r1 = s.docs.replaceBatch({ projectId: s.project.id, items: items(s), ...meta })
    await s.db.checkpointIdle()
    const elapsed = performance.now() - started
    const cp = s.db.checkpointer!
    expect(cp.last).toMatchObject({ ok: false, attempts: 3, error: 'INJECTED_CHECKPOINT_FAIL' })
    expect(elapsed).toBeGreaterThanOrEqual(2 * 50 - 5)
    expect(cp.consecutiveFailures).toBe(1)
    expect(logs.some((m) => m.includes('background checkpoint failed after 3 attempt(s)'))).toBe(true)
    expect(logs.some((m) => m.includes('consecutive failures'))).toBe(true)
    expect(logs.some((m) => m.includes('exceeds'))).toBe(true)
    expect(s.db.autoCheckpoint).toBe(ORIGINAL)
    s.ids.forEach((id) => expect(s.docs.getContent(s.project.id, id).plainText).toContain('远处星'))
    // 退化模式：后续批量不再暂停自动检查点 → COMMIT 内同步检查点，WAL 每次都被回写复用，不会累加
    const walAfterFirst = cp.walBytes()
    let batch = r1.batchId
    for (let round = 0; round < 4; round += 1) {
      expect(s.db.autoCheckpoint).toBe(ORIGINAL)
      batch = round % 2 === 0 ? s.docs.restoreBatch(s.project.id, batch).batchId : s.docs.replaceBatch({ projectId: s.project.id, items: items(s), ...meta }).batchId
      expect(s.db.autoCheckpoint).toBe(ORIGINAL)
      await s.db.checkpointIdle()
    }
    const walEnd = cp.walBytes()
    log(`always-fail: wal after first ${walAfterFirst}B, after 4 more batches ${walEnd}B, consecutiveFailures ${cp.consecutiveFailures}`)
    // 无上限时 5 批会累加到约 5 倍；退化模式下 WAL 在下一次写入时从头复用，最多约两批大小
    expect(walEnd).toBeLessThanOrEqual(walAfterFirst * 2.5)
    expect(cp.consecutiveFailures).toBeGreaterThanOrEqual(2)
  })
  it('worker 线程被终止后：下次批量重新拉起 worker，检查点成功并恢复原值', async () => {
    const s = setup(10)
    s.docs.replaceBatch({ projectId: s.project.id, items: items(s), ...meta })
    await s.db.checkpointIdle()
    const cp = s.db.checkpointer! as unknown as { worker?: { terminate(): Promise<number> } }
    await cp.worker!.terminate()
    s.docs.replaceBatch({ projectId: s.project.id, items: items(s, '远处星', '远处月'), ...meta })
    await s.db.checkpointIdle()
    expect(s.db.autoCheckpoint).toBe(ORIGINAL)
    expect(s.db.checkpointer!.last?.ok).toBe(true)
  })
})

describe('C / 5：后台检查点进行中继续编辑保存不卡不丢；大 WAL 下普通保存的 commit 耗时', () => {
  it('千章替换后检查点进行中：20 次保存 + 20 次切章读取各 ≤300ms，全部落库；检查点结束后保存不触发大检查点', async () => {
    const s = setup(1000, { checkpointer: { inject: { delayMs: 3_000 } } })
    const replaceStarted = performance.now()
    const result = s.docs.replaceBatch({ projectId: s.project.id, items: items(s), ...meta })
    const replaceMs = performance.now() - replaceStarted
    const cp = s.db.checkpointer!
    const walBig = cp.walBytes()
    const saves: number[] = []; const reads: number[] = []
    for (let i = 0; i < 20; i += 1) {
      saves.push(save(s, s.ids[i * 37], `·并发保存${i}`))
      const t = performance.now(); s.docs.getContent(s.project.id, s.ids[(i * 53) % 1000]); reads.push(performance.now() - t)
      await new Promise((done) => setTimeout(done, 10))
    }
    expect(cp.busy).toBe(true)
    expect(s.db.autoCheckpoint).toBe(0)
    await s.db.checkpointIdle()
    expect(s.db.autoCheckpoint).toBe(ORIGINAL)
    const afterSaves = [save(s, s.ids[1], '·检查点后1'), save(s, s.ids[2], '·检查点后2')]
    log(`1000ch replace ${Math.round(replaceMs)}ms timing ${JSON.stringify(result.timing)}; wal ${(walBig / 1048576).toFixed(1)}MB; bg checkpoint ${cp.last?.ms}ms (attempts ${cp.last?.attempts}, excl. injected 3000ms delay); during-checkpoint save max ${Math.max(...saves).toFixed(1)}ms, read max ${Math.max(...reads).toFixed(1)}ms; after-checkpoint save ${afterSaves.map((v) => v.toFixed(1)).join('/')}ms`)
    expect(Math.max(...saves)).toBeLessThanOrEqual(300)
    expect(Math.max(...reads)).toBeLessThanOrEqual(300)
    expect(Math.max(...afterSaves)).toBeLessThanOrEqual(300)
    for (let i = 0; i < 20; i += 1) expect(s.docs.getContent(s.project.id, s.ids[i * 37]).plainText).toContain(`·并发保存${i}`)
    // 重开库仍在
    const path = s.path
    await s.db.closeAsync()
    const reopened = new AppDatabase(path, { checkpointer: false }); dbs.push(reopened)
    const docs2 = new DocumentService(reopened, new WritingDailyService(reopened))
    for (let i = 0; i < 20; i += 1) expect(docs2.getContent(s.project.id, s.ids[i * 37]).plainText).toContain(`·并发保存${i}`)
    expect(docs2.getContent(s.project.id, s.ids[1]).plainText).toContain('·检查点后1')
    expect(result.chapters).toBe(1000)
  }, 240_000)
  it('真实重叠（无注入延迟）：千章替换后立即保存的耗时与后台检查点耗时；对照：不用后台检查点时下一次保存要扛下整次检查点', async () => {
    const s = setup(1000)
    const result = s.docs.replaceBatch({ projectId: s.project.id, items: items(s), ...meta })
    const cp = s.db.checkpointer!
    const busyAtSave = cp.busy
    const overlapped = save(s, s.ids[5], '·紧接着保存')
    await s.db.checkpointIdle()
    const after = save(s, s.ids[6], '·检查点后')
    const control = setup(1000, { checkpointer: false })
    const controlResult = control.docs.replaceBatch({ projectId: control.project.id, items: items(control), ...meta })
    const controlWal = statSync(`${control.path}-wal`).size
    const controlSave = save(control, control.ids[5], '·大 WAL 下保存（自动检查点已恢复）')
    log(`real overlap: replace timing ${JSON.stringify(result.timing)}; save right after commit ${overlapped.toFixed(1)}ms (checkpoint busy=${busyAtSave}); bg checkpoint ${cp.last?.ms}ms ok=${cp.last?.ok}; save after checkpoint ${after.toFixed(1)}ms | control(no bg checkpoint): replace timing ${JSON.stringify(controlResult.timing)}, wal ${(controlWal / 1048576).toFixed(1)}MB, next normal save ${controlSave.toFixed(1)}ms (record only)`)
    expect(overlapped).toBeLessThanOrEqual(300)
    expect(after).toBeLessThanOrEqual(300)
    expect(cp.last?.ok).toBe(true)
  }, 240_000)
})

describe('D：上一次后台检查点未完成就开始下一次批量 → 不等待、不取消，排队合并', () => {
  it('三次批量连发：只跑 2 轮（运行中 1 + 排队合并 1），全部结束后才恢复原值', async () => {
    const s = setup(20, { checkpointer: { inject: { delayMs: 400 } } })
    const r1 = s.docs.replaceBatch({ projectId: s.project.id, items: items(s), ...meta })
    const t = performance.now()
    s.docs.restoreBatch(s.project.id, r1.batchId)
    s.docs.replaceBatch({ projectId: s.project.id, items: items(s, '远处灯', '远处月'), ...meta })
    const secondAndThirdMs = performance.now() - t
    expect(secondAndThirdMs).toBeLessThan(400) // 不等待上一轮检查点
    expect(s.db.autoCheckpoint).toBe(0)
    await s.db.checkpointIdle()
    expect(s.db.checkpointer!.runs).toBe(2)
    expect(s.db.checkpointer!.last).toMatchObject({ ok: true })
    expect(s.db.autoCheckpoint).toBe(ORIGINAL)
  })
})

describe('E / 3：备份在大 WAL、检查点未完成时导出 → 导入新库，逐章哈希一致', () => {
  it('项目备份是经 SQLite 连接逐表读取（读得到 WAL 中已提交数据），不拷贝库文件', async () => {
    const s = setup(200, { checkpointer: { inject: { delayMs: 5_000 } } })
    s.docs.replaceBatch({ projectId: s.project.id, items: items(s), ...meta })
    s.docs.saveContent({ projectId: s.project.id, documentId: s.ids[3], editorJson: doc('只在 WAL 里的新正文'), plainText: '只在 WAL 里的新正文' })
    const cp = s.db.checkpointer!
    expect(cp.busy).toBe(true)
    const walBytes = cp.walBytes()
    expect(walBytes).toBeGreaterThan(1024 * 1024)
    const file = join(tempDir(), 'big-wal.aiwproj')
    await new BackupService(s.db).exportProject(s.project.id, file)
    expect(cp.busy).toBe(true) // 导出时检查点还没结束
    const target = new AppDatabase(join(tempDir(), 'restore.sqlite')); dbs.push(target)
    const imported = await new BackupService(target).importProject(file)
    const source = chapterHashes(s.db.raw, s.project.id)
    const restored = chapterHashes(target.raw, imported.id)
    log(`backup under ${(walBytes / 1048576).toFixed(1)}MB WAL: ${Object.keys(source).length} chapters compared`)
    expect(Object.keys(restored)).toHaveLength(200)
    expect(restored).toEqual(source)
  }, 120_000)
  it('源码守卫：src/main 里没有拷贝 .sqlite 库文件的代码', () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])
    for (const file of walk(resolve('src/main')).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(file, 'utf8')
      expect(/copyFile|createReadStream\([^)]*sqlite|cp\([^)]*sqlite/.test(text), file).toBe(false)
    }
  })
})

describe('2：worker 关闭与应用退出', () => {
  it('closeAsync 在检查点进行中：等当前检查点跑完、worker 关闭连接退出，再关主连接；重开库数据完整', async () => {
    const s = setup(20, { checkpointer: { inject: { delayMs: 300 } } })
    s.docs.replaceBatch({ projectId: s.project.id, items: items(s), ...meta })
    const expected = chapterHashes(s.db.raw, s.project.id)
    const cp = s.db.checkpointer!
    expect(cp.busy).toBe(true)
    await s.db.closeAsync()
    expect(s.db.closed).toBe(true); expect(cp.closed).toBe(true)
    expect((cp as unknown as { worker?: unknown }).worker).toBeUndefined()
    expect(cp.last?.ok).toBe(true)
    expect(await cp.request()).toMatchObject({ ok: false, error: 'CHECKPOINTER_CLOSED' })
    const reopened = new AppDatabase(s.path); dbs.push(reopened)
    expect(chapterHashes(reopened.raw, s.project.id)).toEqual(expected)
  })
  it('同步 close() 也会关闭 worker；退出钩子 will-quit 走 closeAsync', async () => {
    const s = setup(5)
    s.docs.replaceBatch({ projectId: s.project.id, items: items(s), ...meta })
    s.db.close()
    await s.db.checkpointer!.close()
    expect((s.db.checkpointer as unknown as { worker?: unknown }).worker).toBeUndefined()
    const index = readFileSync(resolve('src/main/index.ts'), 'utf8')
    expect(index).toMatch(/app\.on\('will-quit'[\s\S]*event\.preventDefault\(\)[\s\S]*closeAsync\(\)[\s\S]*app\.quit\(\)/)
  })
})

describe('F / 4：强杀子进程（kill -9 / taskkill /F）三个时机，重开后正文与快照逐章完整', () => {
  // 子进程直接用 node 运行产品 TS 源码（src/main 下的 AppDatabase / WalCheckpointer / DocumentService，未打包、未复制）：
  // Node 22 自带类型擦除 + tests/fixtures/ts-resolve-hook.mjs 解析无扩展名相对导入。不经过任何打包器。
  const child = resolve('tests/fixtures/wal-crash-child.ts')
  const nodeArgs = ['--experimental-transform-types', '--no-warnings', '--import', pathToFileURL(resolve('tests/fixtures/ts-resolve-hook.mjs')).href]
  const kill = (pid: number): void => {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(pid, 'SIGKILL')
  }
  const runAndKill = (dbPath: string, mode: string) => new Promise<{ status: Record<string, unknown>; projectId: string; hashes: ReturnType<typeof chapterHashes> }>((done, fail) => {
    const proc = spawn(process.execPath, [...nodeArgs, child, dbPath, mode, '300'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''; let err = ''
    const timer = setTimeout(() => { kill(proc.pid!); fail(new Error(`child ${mode} timeout; stderr ${err}`)) }, 150_000)
    proc.stderr.on('data', (c) => { err += c })
    proc.stdout.on('data', (c) => {
      out += c
      const line = out.split('\n').find((l) => l.startsWith('READY '))
      if (!line) return
      clearTimeout(timer)
      const parsed = JSON.parse(line.slice(6))
      proc.once('exit', (code, signal) => { log(`crash ${mode}: killed (code ${code}, signal ${signal}); status ${JSON.stringify({ ...parsed.status, attempts: (parsed.status.attempts as unknown[]).slice(0, 3) })}`); done(parsed) })
      kill(proc.pid!)
    })
    proc.once('exit', (code) => { if (!out.includes('READY ')) { clearTimeout(timer); fail(new Error(`child ${mode} exited ${code} before READY; stderr ${err}`)) } })
  })
  for (const mode of ['before', 'during', 'after']) it(`强杀时机 ${mode === 'before' ? '提交后、检查点开始前' : mode === 'during' ? '检查点回写了一半（读连接钉住快照，checkpointed < log）' : '检查点完成后'}`, async () => {
    const dbPath = join(tempDir(), 'crash.sqlite')
    const ready = await runAndKill(dbPath, mode)
    const status = ready.status as { autoCheckpoint: number; busy: boolean; last: { ok: boolean } | null; attempts: Array<{ log?: number; checkpointed?: number }> }
    if (mode === 'before') { expect(status.busy).toBe(true); expect(status.last).toBeNull(); expect(status.autoCheckpoint).toBe(0) }
    if (mode === 'during') expect(status.attempts.some((a) => (a.checkpointed ?? 0) > 0 && (a.checkpointed ?? 0) < (a.log ?? 0))).toBe(true)
    if (mode === 'after') { expect(status.busy).toBe(false); expect(status.last?.ok).toBe(true) }
    const reopened = new AppDatabase(dbPath, { checkpointer: false }); dbs.push(reopened)
    expect((reopened.raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
    const hashes = chapterHashes(reopened.raw, ready.projectId)
    expect(Object.keys(hashes)).toHaveLength(300)
    expect(hashes).toEqual(ready.hashes)
  }, 180_000)
})
