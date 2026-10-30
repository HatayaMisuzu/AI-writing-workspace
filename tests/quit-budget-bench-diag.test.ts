// P3 PR-53 诊断（临时，合并前删除）：N MB 实测 + 保存耗时改前/改后。只打日志，不断言时限。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase, type AppDatabaseOptions } from '../src/main/database/database'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'

vi.setConfig({ testTimeout: 600_000 })
const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })) })
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'inkstone-qbench-')); dirs.push(d); return d }
const log = (tag: string, data: unknown): void => { process.stdout.write(`${tag} ${process.platform} ${JSON.stringify(data)}\n`) }
const walBytes = (p: string): number => { try { return statSync(`${p}-wal`).size } catch { return 0 } }
const doc = (text: string): Record<string, unknown> => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const stats = (xs: number[]): { n: number; median: number; p95: number; max: number; mean: number } => {
  const s = [...xs].sort((a, b) => a - b)
  const q = (f: number): number => Math.round(s[Math.min(s.length - 1, Math.floor(f * s.length))] * 100) / 100
  return { n: s.length, median: q(0.5), p95: q(0.95), max: q(1), mean: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 100) / 100 }
}

describe('N MB 实测：WAL 大小 → 退出预留段（TRUNCATE 检查点 + close）耗时', () => {
  for (const mb of [1, 2, 4, 6, 8, 12, 16, 24, 32]) it(`WAL ${mb}MB`, async () => {
    const rows: Array<Record<string, number>> = []
    for (let rep = 0; rep < 3; rep += 1) {
      const path = join(tempDir(), 'n.sqlite')
      const db = new AppDatabase(path, { checkpointer: false })
      const project = new ProjectService(db).create({ title: '基准', projectType: 'novel', description: '' })
      const docs = new DocumentService(db)
      const chapter = docs.listTree(project.id).find((n) => n.type === 'chapter')!
      db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      db.raw.exec('PRAGMA wal_autocheckpoint = 0')
      let i = 0
      while (walBytes(path) < mb * 1024 * 1024) {
        const text = `第${i}版` + '林舟看见远处灯，远处灯又亮了。风从北面吹来。'.repeat(400)
        docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: doc(text), plainText: text })
        i += 1
      }
      const wal = walBytes(path)
      const t0 = performance.now()
      db.raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
      const t1 = performance.now()
      db.close()
      const t2 = performance.now()
      // 对照：不先检查点，close 自己回写
      const path2 = join(tempDir(), 'n2.sqlite')
      const db2 = new AppDatabase(path2, { checkpointer: false })
      const p2 = new ProjectService(db2).create({ title: '基准', projectType: 'novel', description: '' })
      const d2 = new DocumentService(db2)
      const c2 = d2.listTree(p2.id).find((n) => n.type === 'chapter')!
      db2.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      db2.raw.exec('PRAGMA wal_autocheckpoint = 0')
      let j = 0
      while (walBytes(path2) < mb * 1024 * 1024) {
        const text = `第${j}版` + '林舟看见远处灯，远处灯又亮了。风从北面吹来。'.repeat(400)
        d2.saveContent({ projectId: p2.id, documentId: c2.id, editorJson: doc(text), plainText: text })
        j += 1
      }
      const wal2 = walBytes(path2)
      const t3 = performance.now()
      db2.close()
      const t4 = performance.now()
      rows.push({ rep, walBytes: wal, checkpointMs: Math.round(t1 - t0), closeAfterCkptMs: Math.round(t2 - t1), reserveSegmentMs: Math.round(t2 - t0), walBytesCloseOnly: wal2, closeOnlyMs: Math.round(t4 - t3) })
    }
    log('QUITBENCH', { mb, rows, maxReserveSegmentMs: Math.max(...rows.map((r) => r.reserveSegmentMs)), maxCloseOnlyMs: Math.max(...rows.map((r) => r.closeOnlyMs)) })
    expect(rows).toHaveLength(3)
  })
})

describe('保存耗时：改前（无 journal_size_limit / 无定期写回）vs 改后（默认）', () => {
  const variants: Array<[string, AppDatabaseOptions]> = [
    ['before', { journalSizeLimitBytes: false, walMaintenance: false }],
    ['after', {}],
    ['after-stress', { walMaintenance: { intervalMs: 50, thresholdBytes: 0 } }],
    ['before', { journalSizeLimitBytes: false, walMaintenance: false }],
    ['after', {}]
  ]
  variants.forEach(([name, options], k) => it(`${name}#${k}`, async () => {
    const path = join(tempDir(), 's.sqlite')
    const db = new AppDatabase(path, options)
    const project = new ProjectService(db).create({ title: '基准', projectType: 'novel', description: '' })
    const docs = new DocumentService(db)
    const chapter = docs.listTree(project.id).find((n) => n.type === 'chapter')!
    const times: number[] = []
    const commitMs: number[] = []
    for (let i = 0; i < 600; i += 1) {
      const text = `第${i}次保存` + '林舟看见远处灯，远处灯又亮了。风从北面吹来。'.repeat(200)
      const t = performance.now()
      docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: doc(text), plainText: text })
      times.push(performance.now() - t)
      const last = db.commits.at(-1); if (last) commitMs.push(last.commitMs)
      await new Promise((r) => setTimeout(r, 5))
    }
    await db.checkpointIdle()
    log('SAVEBENCH', { variant: name, run: k, save: stats(times), commit: stats(commitMs), walBytesEnd: walBytes(path), maintenanceRequests: db.maintenanceRequests, checkpointerRuns: db.checkpointer?.runs ?? 0 })
    await db.closeForQuit()
    expect(times).toHaveLength(600)
  }))
})
