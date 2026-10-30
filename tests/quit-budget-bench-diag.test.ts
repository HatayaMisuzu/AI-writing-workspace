// P3 PR-53 诊断（临时，合并前删除）：待回写量→退出预留段耗时；释放后首存改前/改后；定期写回触发期间保存耗时。只打日志。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase, type AppDatabaseOptions } from '../src/main/database/database'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { WritingDailyService } from '../src/main/services/writing-daily-service'
import { pendingBackfillBytes } from './helpers/wal-index'

vi.setConfig({ testTimeout: 900_000 })
const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })) })
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'inkstone-qbench-')); dirs.push(d); return d }
const log = (tag: string, data: unknown): void => { process.stdout.write(`${tag} ${process.platform} ${JSON.stringify(data)}\n`) }
const walBytes = (p: string): number => { try { return statSync(`${p}-wal`).size } catch { return 0 } }
const doc = (text: string): Record<string, unknown> => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const q = (f: number): number => Math.round(s[Math.min(s.length - 1, Math.ceil(f * s.length) - 1)] * 100) / 100
  return { n: s.length, median: q(0.5), p95: q(0.95), max: q(1) }
}

describe('待回写量 → 预留段（TRUNCATE + close）', () => {
  const sizes = [1, 2, 4, 6, 8, 12, 16, 24, 32]
  for (const mb of sizes) it(`pending ${mb}MB`, () => {
    const rows: Array<Record<string, number>> = []
    for (let rep = 0; rep < 5; rep += 1) {
      const path = join(tempDir(), 'n.sqlite')
      const db = new AppDatabase(path, { checkpointer: false })
      const project = new ProjectService(db).create({ title: '基准', projectType: 'novel', description: '' })
      const docs = new DocumentService(db)
      const chapter = docs.listTree(project.id).find((n) => n.type === 'chapter')!
      db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      db.raw.exec('PRAGMA wal_autocheckpoint = 0')
      for (let i = 0; pendingBackfillBytes(path) < mb * 1024 * 1024; i += 1) {
        const text = `第${i}版` + '林舟看见远处灯，远处灯又亮了。风从北面吹来。'.repeat(400)
        docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: doc(text), plainText: text })
      }
      const pending = pendingBackfillBytes(path)
      const t0 = performance.now(); db.raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); const t1 = performance.now(); db.close(); const t2 = performance.now()
      rows.push({ rep, pending, walBytes: pending, checkpointMs: Math.round(t1 - t0), closeMs: Math.round(t2 - t1), reserveMs: Math.round(t2 - t0) })
    }
    log('PENDBENCH', { mb, reserveMs: rows.map((r) => r.reserveMs), pending: rows[0].pending })
    expect(rows).toHaveLength(5)
  })
  it('-wal ≈45MB 但已回写完（pending 0）', async () => {
    const rows: Array<Record<string, number>> = []
    for (let rep = 0; rep < 5; rep += 1) {
      const path = join(tempDir(), 'b.sqlite')
      const db = new AppDatabase(path, { walMaintenance: false })
      const project = new ProjectService(db).create({ title: '基准', projectType: 'novel', description: '' })
      const docs = new DocumentService(db)
      const chapter = docs.listTree(project.id).find((n) => n.type === 'chapter')!
      db.raw.exec('PRAGMA wal_autocheckpoint = 0')
      for (let i = 0; walBytes(path) < 45 * 1024 * 1024; i += 1) {
        const text = `第${i}版` + '林舟看见远处灯，远处灯又亮了。风从北面吹来。'.repeat(400)
        docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: doc(text), plainText: text })
      }
      await db.checkpointer!.request()
      const wal = walBytes(path); const pending = pendingBackfillBytes(path)
      const r = await db.closeForQuit()
      rows.push({ rep, wal, pending, ms: r.ms, checkpointMs: r.segments!.checkpointMs, closeMs: r.segments!.mainCloseMs, walBytesBeforeClose: r.segments!.walBytesBeforeClose })
    }
    log('BIGWALBENCH', { rows })
    expect(rows).toHaveLength(5)
  })
})

describe('释放后首存：改前（无定期写回 = main 配置）vs 改后（默认）', () => {
  it('各 24 次，交替', async () => {
    const body = (i: number): string => `第${i + 1}章：` + '林舟看见远处灯，远处灯又亮了。风从北面吹来。'.repeat(120)
    const mk = (options: AppDatabaseOptions) => {
      const path = join(tempDir(), 'r.sqlite')
      const db = new AppDatabase(path, options)
      const docs = new DocumentService(db, new WritingDailyService(db))
      const project = new ProjectService(db).create({ title: '释放', projectType: 'novel', description: '' })
      const tree = docs.listTree(project.id)
      const volume = tree.find((n) => n.type === 'volume')!
      const ids = [tree.find((n) => n.type === 'chapter')!.id]
      for (let i = 1; i < 300; i += 1) ids.push(docs.createNode({ projectId: project.id, parentId: volume.id, type: 'chapter', title: `第${i + 1}章` }).id)
      ids.forEach((id, i) => docs.saveContent({ projectId: project.id, documentId: id, editorJson: doc(body(i)), plainText: body(i) }))
      db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      return { db, docs, project, ids, path, flip: false }
    }
    const variants = { before: mk({ walMaintenance: false }), after: mk({}) }
    const first: Record<string, number[]> = { before: [], after: [] }
    for (let rep = 0; rep < 24; rep += 1) {
      for (const name of (rep % 2 ? ['after', 'before'] : ['before', 'after']) as Array<'before' | 'after'>) {
        const s = variants[name]
        const [from, to] = s.flip ? ['远处星', '远处灯'] : ['远处灯', '远处星']
        s.flip = !s.flip
        const items = s.ids.map((id) => { const c = s.docs.getContent(s.project.id, id); const t = c.plainText.replaceAll(from, to); return { documentId: id, expectedRevision: c.revision, editorJson: doc(t), plainText: t, hits: 240 } })
        s.docs.replaceBatch({ projectId: s.project.id, items, query: from, replacement: to, regex: false, caseSensitive: false })
        await s.db.checkpointIdle()
        const c = s.docs.getContent(s.project.id, s.ids[1])
        s.docs.saveContent({ projectId: s.project.id, documentId: s.ids[1], editorJson: doc(c.plainText + '释放后'), plainText: c.plainText + '释放后', expectedRevision: c.revision })
        first[name].push(s.db.commits.at(-1)!.commitMs)
      }
    }
    log('FIRSTSAVEBENCH', { before: stats(first.before), after: stats(first.after), raw: first })
    for (const v of Object.values(variants)) await v.db.closeAsync()
    expect(first.before).toHaveLength(24)
  })
})

describe('定期写回触发期间的平时保存耗时', () => {
  const variants: Array<[string, AppDatabaseOptions]> = [
    ['off', { walMaintenance: false }], ['on-100ms', { walMaintenance: { intervalMs: 100, thresholdBytes: 0 } }],
    ['on-100ms', { walMaintenance: { intervalMs: 100, thresholdBytes: 0 } }], ['off', { walMaintenance: false }]
  ]
  variants.forEach(([name, options], k) => it(`${name}#${k}`, async () => {
    const path = join(tempDir(), 's.sqlite')
    const db = new AppDatabase(path, options)
    const project = new ProjectService(db).create({ title: '基准', projectType: 'novel', description: '' })
    const docs = new DocumentService(db)
    const chapter = docs.listTree(project.id).find((n) => n.type === 'chapter')!
    const save: number[] = []; const commit: number[] = []; const pend: number[] = []
    for (let i = 0; i < 120; i += 1) {
      const text = `第${i}次保存` + '林舟看见远处灯，远处灯又亮了。风从北面吹来。'.repeat(200)
      const t = performance.now()
      docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: doc(text), plainText: text })
      save.push(performance.now() - t); commit.push(db.commits.at(-1)!.commitMs)
      pend.push(pendingBackfillBytes(path))
      await sleep(250)
    }
    log('MAINTBENCH', { variant: name, run: k, save: stats(save), commit: stats(commit), pendingMaxBytes: Math.max(...pend), pendingMedianBytes: stats(pend).median, maintenanceRequests: db.maintenanceRequests, checkpointerRuns: db.checkpointer?.runs ?? 0 })
    await db.closeAsync()
    expect(save).toHaveLength(120)
  }))
})
