import { describe, expect, it } from 'vitest'
import { AppDatabase } from '../src/main/database/database'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService, SNAPSHOT_CAP_PER_DOCUMENT } from '../src/main/services/document-service'
import { WritingDailyService } from '../src/main/services/writing-daily-service'

// P3：每章快照上限 50（DocumentService.pruneSnapshots），main 层测试

class FaultyDocuments extends DocumentService {
  failPrune = false
  protected override onSnapshotsPruned(documentId: string, deleted: number): void {
    if (this.failPrune) throw new Error(`INJECTED_prune_${documentId}_${deleted}`)
  }
}

const doc = (text: string): Record<string, unknown> => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

function setup(text = '第一章：林舟看见远处灯，远处灯又亮了。') {
  const db = new AppDatabase(':memory:')
  const projects = new ProjectService(db)
  const docs = new FaultyDocuments(db, new WritingDailyService(db))
  const project = projects.create({ title: '快照上限', projectType: 'novel', description: '' })
  const id = docs.listTree(project.id).find((n) => n.type === 'chapter')!.id
  docs.saveContent({ projectId: project.id, documentId: id, editorJson: doc(text), plainText: text })
  return { db, docs, project, id }
}
type S = ReturnType<typeof setup>

/** 直接插入「更早」的快照：created_at 递增（1000+i，远早于 Date.now()），revision 默认 10000+i（≠ 当前正文 revision） */
const seed = (s: S, count: number, opts: { prefix?: string; reason?: string; metadata?: Record<string, unknown>; revision?: (i: number) => number; at?: number } = {}): string[] => {
  const ids: string[] = []
  const insert = s.db.raw.prepare(`INSERT INTO snapshots (id, project_id, document_id, reason, revision, content, plain_text, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (let i = 0; i < count; i += 1) {
    const id = `${opts.prefix ?? 'old'}-${i}`
    insert.run(id, s.project.id, s.id, opts.reason ?? 'interval', opts.revision ? opts.revision(i) : 10000 + i,
      JSON.stringify(doc(`旧${i}`)), `旧${i}`, JSON.stringify(opts.metadata ?? {}), (opts.at ?? 1000) + i)
    ids.push(id)
  }
  return ids
}
const ids = (s: S): string[] => (s.db.raw.prepare('SELECT id FROM snapshots WHERE project_id = ? AND document_id = ? ORDER BY created_at, rowid').all(s.project.id, s.id) as Array<{ id: string }>).map((r) => r.id)

const dumpAll = (db: AppDatabase): string => {
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
  const encode = (value: unknown): string => JSON.stringify(value,
    (_key, item: unknown) => (item instanceof Uint8Array ? Buffer.from(item).toString('base64') : typeof item === 'bigint' ? item.toString() : item))
  return encode(tables.map(({ name }) => [name, (db.raw.prepare(`SELECT * FROM "${name}"`).all() as unknown[]).map(encode).sort()]))
}

describe('每章快照上限 50', () => {
  it('上限常量为 50', () => { expect(SNAPSHOT_CAP_PER_DOCUMENT).toBe(50) })

  it('第 51 个快照写入后剩 50 个，删掉的是最旧的那个', () => {
    const s = setup()
    const old = seed(s, 50)
    expect(ids(s)).toHaveLength(50)
    const created = s.docs.createSnapshot(s.project.id, s.id, 'manual')
    const after = ids(s)
    expect(after).toHaveLength(50)
    expect(after).not.toContain(old[0])
    expect(after).toEqual([...old.slice(1), created.id])
  })

  it('当前版本（revision = 当前正文 revision）的快照即使最旧也不删，改删下一个最旧的', () => {
    const s = setup()
    const current = s.docs.getContent(s.project.id, s.id)
    const old = seed(s, 50, { revision: (i) => (i === 0 ? current.revision : 10000 + i) })
    s.docs.createSnapshot(s.project.id, s.id, 'manual')
    const after = ids(s)
    expect(after).toHaveLength(50)
    expect(after).toContain(old[0])
    expect(after).not.toContain(old[1])
    // 正文本身不受影响
    expect(s.docs.getContent(s.project.id, s.id).plainText).toBe(current.plainText)
    expect(s.docs.getContent(s.project.id, s.id).revision).toBe(current.revision)
  })

  it('整批恢复点（book_replace 快照、整批恢复前的 pre_restore）不删，修剪后整批恢复仍可用', () => {
    const original = '第一章：林舟看见远处灯，远处灯又亮了。'
    const s = setup(original)
    const before = s.docs.getContent(s.project.id, s.id)
    const replaced = original.replaceAll('远处灯', '远处星')
    const result = s.docs.replaceBatch({ projectId: s.project.id, items: [{ documentId: s.id, expectedRevision: before.revision, editorJson: doc(replaced), plainText: replaced, hits: 2 }],
      query: '远处灯', replacement: '远处星', regex: false, caseSensitive: false })
    const batchRow = s.db.raw.prepare("SELECT id FROM snapshots WHERE document_id = ? AND json_extract(metadata_json, '$.kind') = 'book_replace'").get(s.id) as { id: string }
    // 把整批恢复点挪成全章最旧
    s.db.raw.prepare('UPDATE snapshots SET created_at = 1 WHERE id = ?').run(batchRow.id)
    const old = seed(s, 50)
    s.docs.createSnapshot(s.project.id, s.id, 'manual')
    let after = ids(s)
    expect(after).toHaveLength(50)
    expect(after[0]).toBe(batchRow.id)
    expect(after).not.toContain(old[0]); expect(after).not.toContain(old[1])
    // 修剪后整批恢复仍可用
    const restored = s.docs.restoreBatch(s.project.id, result.batchId)
    expect(restored.restored).toHaveLength(1); expect(restored.skipped).toHaveLength(0)
    expect(s.docs.getContent(s.project.id, s.id).plainText).toBe(original)
    const preRestore = s.db.raw.prepare("SELECT id FROM snapshots WHERE document_id = ? AND reason = 'pre_restore' AND json_extract(metadata_json, '$.batchId') = ?").get(s.id, result.batchId) as { id: string }
    expect(preRestore).toBeTruthy()
    // 继续写入大量更新的快照：两个整批恢复相关的点仍在
    s.db.raw.prepare('UPDATE snapshots SET created_at = 2 WHERE id = ?').run(preRestore.id)
    seed(s, 60, { prefix: 'more', at: 5000 })
    s.docs.createSnapshot(s.project.id, s.id, 'manual')
    after = ids(s)
    expect(after).toHaveLength(50)
    expect(after.slice(0, 2)).toEqual([batchRow.id, preRestore.id])
  })

  it('受保护的点本身超过 50：全部保留，其余可淘汰快照全部删掉，总数 > 50', () => {
    const s = setup()
    const protectedIds = seed(s, 55, { prefix: 'batch', reason: 'manual', metadata: { kind: 'book_replace', batchId: 'b-1' } })
    const old = seed(s, 5, { at: 2000 })
    const created = s.docs.createSnapshot(s.project.id, s.id, 'manual')
    const after = ids(s)
    expect(after).toEqual([...protectedIds, created.id])
    for (const id of old) expect(after).not.toContain(id)
    expect(after.length).toBeGreaterThan(SNAPSHOT_CAP_PER_DOCUMENT)
  })

  it('未超过上限不删任何快照', () => {
    const s = setup()
    const old = seed(s, 48)
    s.docs.createSnapshot(s.project.id, s.id, 'manual')
    expect(ids(s)).toHaveLength(49)
    expect(ids(s).slice(0, 48)).toEqual(old)
  })

  it('修剪失败回滚：createSnapshot 单独调用，正文和快照逐字节不变', () => {
    const s = setup()
    seed(s, 50)
    s.docs.failPrune = true
    const before = dumpAll(s.db)
    expect(() => s.docs.createSnapshot(s.project.id, s.id, 'manual')).toThrow('INJECTED_prune')
    expect(dumpAll(s.db)).toBe(before)
    // 回滚后连接仍可正常写
    s.docs.failPrune = false
    s.docs.createSnapshot(s.project.id, s.id, 'manual')
    expect(ids(s)).toHaveLength(50)
  })

  it('修剪失败回滚：saveContent 自动快照（large_delete）修剪失败 → 整个保存回滚，正文和快照都不变', () => {
    const long = '字'.repeat(1500)
    const s = setup(long)
    seed(s, 50)
    const before = s.docs.getContent(s.project.id, s.id)
    const dump = dumpAll(s.db)
    s.docs.failPrune = true
    expect(() => s.docs.saveContent({ projectId: s.project.id, documentId: s.id, editorJson: doc('短'), plainText: '短', expectedRevision: before.revision })).toThrow('INJECTED_prune')
    expect(dumpAll(s.db)).toBe(dump)
    expect(s.docs.getContent(s.project.id, s.id).plainText).toBe(long)
    s.docs.failPrune = false
    const saved = s.docs.saveContent({ projectId: s.project.id, documentId: s.id, editorJson: doc('短'), plainText: '短', expectedRevision: before.revision })
    expect(saved.plainText).toBe('短')
    const after = ids(s)
    expect(after).toHaveLength(50)
    expect(after).not.toContain('old-0')
  })

  it('修剪失败回滚：全书替换批量路径修剪失败 → 整批回滚', () => {
    const s = setup()
    seed(s, 50)
    const current = s.docs.getContent(s.project.id, s.id)
    const dump = dumpAll(s.db)
    s.docs.failPrune = true
    expect(() => s.docs.replaceBatch({ projectId: s.project.id, items: [{ documentId: s.id, expectedRevision: current.revision, editorJson: doc('x'), plainText: 'x', hits: 1 }],
      query: '林舟', replacement: 'x', regex: false, caseSensitive: false })).toThrow('INJECTED_prune')
    expect(dumpAll(s.db)).toBe(dump)
  })
})
