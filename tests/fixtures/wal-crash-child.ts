// P3 PR-2b 崩溃测试子进程（tests/wal-checkpoint-p3.test.ts 直接以 node 运行本 TS 文件及其导入的产品源码，然后强杀）。
// 用法：node --experimental-transform-types --import ./tests/fixtures/ts-resolve-hook.mjs tests/fixtures/wal-crash-child.ts <dbPath> <before|during|after> <chapters>
// 输出一行 `READY {json}` 后保持存活等待被杀。
// P3 PR-42 退出上限：mode = quit-stuck（worker 卡在检查点里不回消息）/ quit-dead（worker 线程已死）时，
// READY 之后直接走 will-quit 同一个 AppDatabase.closeForQuit(QUIT_CLOSE_LIMIT_MS)（P3 PR-53：worker 段硬上限 + 退出前检查点 + close），输出 `CLOSED {json}` 后 process.exit(0)（同 app.quit）。
import { DatabaseSync } from 'node:sqlite'
import { AppDatabase, QUIT_CLOSE_LIMIT_MS } from '../../src/main/database/database'
import { ProjectService } from '../../src/main/services/project-service'
import { DocumentService } from '../../src/main/services/document-service'
import { WritingDailyService } from '../../src/main/services/writing-daily-service'
import { chapterHashes } from './wal-hash'
import { pendingBackfillBytes } from '../helpers/wal-index'

const [dbPath, mode, countArg] = process.argv.slice(2)
const count = Number(countArg)
const doc = (text: string): Record<string, unknown> => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const attempts: Array<{ ok: boolean; log?: number; checkpointed?: number; busy?: number }> = []
let resolvePartial: (() => void) | undefined
const partial = new Promise<void>((resolve) => { resolvePartial = resolve })

const db = new AppDatabase(dbPath, {
  checkpointer: mode === 'quit-stuck' || mode === 'quit-dead'
    ? { inject: { delayMs: 600_000 }, retries: 0 }
    : mode === 'before'
    ? { inject: { delayMs: 600_000 } }
    : mode === 'during'
      ? { retries: 1_000, retryDelayMs: 100, onAttempt: (a) => { attempts.push(a); if (a.ok && (a.checkpointed ?? 0) > 0 && (a.checkpointed ?? 0) < (a.log ?? 0)) resolvePartial?.() } }
      : {}
})
const projects = new ProjectService(db)
const docs = new DocumentService(db, new WritingDailyService(db))
const project = projects.create({ title: '崩溃书', projectType: 'novel', description: '' })
const tree = docs.listTree(project.id)
const volume = tree.find((n) => n.type === 'volume')!
const ids = [tree.find((n) => n.type === 'chapter')!.id]
for (let i = 1; i < count; i += 1) ids.push(docs.createNode({ projectId: project.id, parentId: volume.id, type: 'chapter', title: `第${i + 1}章` }).id)
const body = (i: number): string => `第${i + 1}章：` + '林舟看见远处灯，远处灯又亮了。风从北面吹来。'.repeat(120)
ids.forEach((id, i) => docs.saveContent({ projectId: project.id, documentId: id, editorJson: doc(body(i)), plainText: body(i) }))
db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
const items = (): Array<{ documentId: string; expectedRevision: number; editorJson: Record<string, unknown>; plainText: string; hits: number }> => ids.map((id) => {
  const current = docs.getContent(project.id, id)
  const text = current.plainText.replaceAll('远处灯', '远处星')
  return { documentId: id, expectedRevision: current.revision, editorJson: doc(text), plainText: text, hits: 240 }
})
const meta = { query: '远处灯', replacement: '远处星', regex: false, caseSensitive: false }

const main = async (): Promise<void> => {
  let reader: DatabaseSync | undefined
  const first = docs.replaceBatch({ projectId: project.id, items: items(), ...meta })
  if (mode === 'during') {
    // 另开一个读连接钉住「第一批之后」的快照，再提交第二批：PASSIVE 只能回写到读者标记处 → 主库处于回写了一半的状态
    reader = new DatabaseSync(dbPath)
    reader.exec('BEGIN')
    reader.prepare('SELECT COUNT(*) AS n FROM document_contents').get()
    docs.restoreBatch(project.id, first.batchId)
    await partial
  } else if (mode === 'after') {
    await db.checkpointIdle()
  } else if (mode === 'quit-dead') {
    // worker 线程在检查点中途死掉（这里 terminate 模拟崩溃），等它真正退出
    const worker = (db.checkpointer as unknown as { worker?: { once(event: 'exit', fn: () => void): void; terminate(): Promise<number> } }).worker
    if (!worker) throw new Error('NO_WORKER')
    await new Promise<void>((resolve) => { worker.once('exit', () => resolve()); void worker.terminate() })
  }
  const status = { mode, attempts, autoCheckpoint: db.autoCheckpoint, busy: db.checkpointer?.busy ?? false, last: db.checkpointer?.last ?? null, walBytes: db.checkpointer?.walBytes() ?? 0 }
  process.stdout.write(`READY ${JSON.stringify({ status, projectId: project.id, hashes: chapterHashes(db.raw, project.id) })}\n`)
  if (mode === 'quit-stuck' || mode === 'quit-dead') {
    // 分段计时由 closeForQuit 自己返回（P3 PR-53：worker 段 / 退出前检查点 / 主连接 close）
    const walBefore = db.checkpointer?.walBytes() ?? 0
    // 待回写量（新口径 N）：(mxFrame − nBackfill) × 帧大小
    const pendingBytesAtQuit = pendingBackfillBytes(dbPath)
    const quitStarted = performance.now()
    const result = await db.closeForQuit(QUIT_CLOSE_LIMIT_MS)
    const segments = { ...result.segments, walBytesAtQuit: walBefore, pendingBytesAtQuit }
    if (process.env.INKSTONE_QUIT_TEST_DIAG === '1') process.stderr.write(`QDIAG ${JSON.stringify({ quitStarted: Math.round(quitStarted), resolved: Math.round(performance.now()), segments })}\n`)
    process.stdout.write(`CLOSED ${JSON.stringify({ timedOut: result.timedOut, ms: result.ms, limitMs: QUIT_CLOSE_LIMIT_MS, mainClosed: db.closed, segments })}\n`)
    process.exit(0)
  }
  setInterval(() => { void reader }, 1_000)
}
void main()
