// P3 PR-53 诊断（临时，合并前删除）：待回写量→退出预留段耗时；释放后首存改前/改后；定期写回触发期间保存耗时。只打日志。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase, type AppDatabaseOptions } from '../src/main/database/database'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { pendingBackfillBytes } from './helpers/wal-index'

vi.setConfig({ testTimeout: 900_000 })
const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })) })
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'inkstone-qbench-')); dirs.push(d); return d }
const log = (tag: string, data: unknown): void => { process.stdout.write(`${tag} ${process.platform} ${JSON.stringify(data)}\n`) }
const doc = (text: string): Record<string, unknown> => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const q = (f: number): number => Math.round(s[Math.min(s.length - 1, Math.ceil(f * s.length) - 1)] * 100) / 100
  return { n: s.length, median: q(0.5), p95: q(0.95), max: q(1) }
}

describe('定期写回触发期间的平时保存耗时', () => {
  const variants: Array<[string, AppDatabaseOptions]> = [
    ['off', { walMaintenance: false }], ['on-100ms', { walMaintenance: { intervalMs: 100, thresholdBytes: 0 } }], ['default', {}],
    ['on-100ms', { walMaintenance: { intervalMs: 100, thresholdBytes: 0 } }], ['off', { walMaintenance: false }], ['default', {}]
  ]
  variants.forEach(([name, options], k) => it(`${name}#${k}`, async () => {
    const path = join(tempDir(), 's.sqlite')
    const db = new AppDatabase(path, options)
    const project = new ProjectService(db).create({ title: '基准', projectType: 'novel', description: '' })
    const docs = new DocumentService(db)
    const chapter = docs.listTree(project.id).find((n) => n.type === 'chapter')!
    const save: number[] = []; const commit: number[] = []; const pend: number[] = []
    for (let i = 0; i < 160; i += 1) {
      const text = `第${i}次保存` + '林舟看见远处灯，远处灯又亮了。风从北面吹来。'.repeat(200)
      const t = performance.now()
      docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: doc(text), plainText: text })
      save.push(performance.now() - t); commit.push(db.commits.at(-1)!.commitMs)
      try { pend.push(pendingBackfillBytes(path)) } catch { /* Windows 偶发读不到 shm 头：跳过该样本 */ }
      await sleep(250)
    }
    log('MAINTBENCH', { variant: name, run: k, save: stats(save), commit: stats(commit), pendingMaxBytes: Math.max(...pend), pendingMedianBytes: stats(pend).median, maintenanceRequests: db.maintenanceRequests, checkpointerRuns: db.checkpointer?.runs ?? 0 })
    await db.closeAsync()
    expect(save).toHaveLength(160)
  }))
})
