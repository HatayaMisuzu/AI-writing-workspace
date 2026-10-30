// P3 PR-2b 崩溃测试子进程（tests/wal-checkpoint-p3.test.ts 用 esbuild 打包后以 node 运行，然后被强杀）。
// 用法：node child.mjs <dbPath> <before|during|after> <chapters>
// 输出一行 `READY {json}` 后保持存活等待被杀。
import { DatabaseSync } from 'node:sqlite'
import { AppDatabase } from '../../src/main/database/database'
import { ProjectService } from '../../src/main/services/project-service'
import { DocumentService } from '../../src/main/services/document-service'
import { WritingDailyService } from '../../src/main/services/writing-daily-service'
import { chapterHashes } from './wal-hash'

const [dbPath, mode, countArg] = process.argv.slice(2)
const count = Number(countArg)
const doc = (text: string): Record<string, unknown> => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const attempts: Array<{ ok: boolean; log?: number; checkpointed?: number; busy?: number }> = []
let resolvePartial: (() => void) | undefined
const partial = new Promise<void>((resolve) => { resolvePartial = resolve })

const db = new AppDatabase(dbPath, {
  checkpointer: mode === 'before'
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
  }
  const status = { mode, attempts, autoCheckpoint: db.autoCheckpoint, busy: db.checkpointer?.busy ?? false, last: db.checkpointer?.last ?? null, walBytes: db.checkpointer?.walBytes() ?? 0 }
  process.stdout.write(`READY ${JSON.stringify({ status, projectId: project.id, hashes: chapterHashes(db.raw, project.id) })}\n`)
  setInterval(() => { void reader }, 1_000)
}
void main()
