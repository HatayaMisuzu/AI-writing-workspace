/**
 * P3 PR-53：定期 PASSIVE 写回（AppDatabase walMaintenance）。
 * - 触发：空闲一个间隔后请求后台 PASSIVE，把待回写量 (mxFrame − nBackfill) × 帧大小 压到 0。
 * - 只在空闲时：每个间隔内都有写入时不触发；批量暂停期间不触发；已回写完且无新写入时不空转。
 * - -wal 文件靠复用不超过历史峰值（不设 journal_size_limit）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database/database'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { pendingBackfillBytes } from './helpers/wal-index'

vi.setConfig({ testTimeout: 120_000 })
const dirs: string[] = []
const dbs: AppDatabase[] = []
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.closeAsync().catch(() => undefined)
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const doc = (text: string): Record<string, unknown> => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const log = (line: string): void => { process.stdout.write(`P53 wal-maintenance ${process.platform}: ${line}\n`) }

function setup(intervalMs: number) {
  const dir = mkdtempSync(join(tmpdir(), 'inkstone-maint-')); dirs.push(dir)
  const path = join(dir, 'm.sqlite')
  const db = new AppDatabase(path, { walMaintenance: { intervalMs, thresholdBytes: 0 } }); dbs.push(db)
  const project = new ProjectService(db).create({ title: '写回', projectType: 'novel', description: '' })
  const docs = new DocumentService(db)
  const chapterId = docs.listTree(project.id).find((n) => n.type === 'chapter')!.id
  // 关自动检查点，让待回写量只能靠定期写回下降
  db.raw.exec('PRAGMA wal_autocheckpoint = 0')
  let n = 0
  const save = (): void => { n += 1; const text = `第${n}次` + '林舟看见远处灯。'.repeat(300); docs.saveContent({ projectId: project.id, documentId: chapterId, editorJson: doc(text), plainText: text }) }
  return { db, path, save }
}

describe('定期 PASSIVE 写回', () => {
  it('空闲后触发，把待回写量压到 0；之后无新写入不再空转', async () => {
    const { db, path, save } = setup(200)
    for (let i = 0; i < 50; i += 1) save()
    const before = pendingBackfillBytes(path)
    expect(before).toBeGreaterThan(0)
    expect(db.maintenanceRequests).toBe(0)
    await sleep(1_200)
    await db.checkpointIdle()
    const after = pendingBackfillBytes(path)
    const requests = db.maintenanceRequests
    log(`trigger: pendingBefore=${before} pendingAfter=${after} requests=${requests} skippedActive=${db.maintenanceSkippedActive}`)
    expect(requests).toBeGreaterThanOrEqual(1)
    expect(after).toBe(0)
    await sleep(1_000)
    expect(db.maintenanceRequests).toBe(requests)
  })

  it('每个间隔内都有写入时不触发（只在空闲时跑）', async () => {
    const { db, save } = setup(200)
    const started = performance.now()
    while (performance.now() - started < 2_000) { save(); await sleep(40) }
    log(`active: requests=${db.maintenanceRequests} skippedActive=${db.maintenanceSkippedActive}`)
    expect(db.maintenanceRequests).toBe(0)
    expect(db.maintenanceSkippedActive).toBeGreaterThanOrEqual(5)
  })

  it('批量暂停期间不触发（交给释放循环）', async () => {
    const { db, save } = setup(100)
    for (let i = 0; i < 10; i += 1) save()
    const holder = db as unknown as { autoCheckpointHolds: number }
    holder.autoCheckpointHolds = 1
    await sleep(800)
    expect(db.maintenanceRequests).toBe(0)
    holder.autoCheckpointHolds = 0
    await sleep(500)
    expect(db.maintenanceRequests).toBeGreaterThanOrEqual(1)
  })

  it('-wal 文件靠复用不超过历史峰值（多轮写入 + 写回）', async () => {
    const { db, path, save } = setup(150)
    let peak = 0
    const sizes: number[] = []
    for (let round = 0; round < 4; round += 1) {
      for (let i = 0; i < 40; i += 1) save()
      const size = statSync(`${path}-wal`).size
      if (round === 0) peak = size
      sizes.push(size)
      await sleep(600)
      await db.checkpointIdle()
      expect(pendingBackfillBytes(path)).toBe(0)
    }
    log(`wal sizes per round: ${JSON.stringify(sizes)} peak=${peak}`)
    for (const size of sizes) expect(size).toBeLessThanOrEqual(peak)
  })
})
