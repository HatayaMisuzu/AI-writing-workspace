import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database/database'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { WritingDailyService } from '../src/main/services/writing-daily-service'
import { BackupService } from '../src/main/services/backup-service'
import { bookReplaceSchema } from '../src/main/ipc/schemas'
import { snapshotReason } from '../src/renderer/src/services/snapshot-label'

// P3 PR-2b：全书替换（documents:replaceBatch）与整批恢复（snapshots:restoreBatch）的 main 层测试

type Stage = 'snapshot' | 'write'
class FaultyDocuments extends DocumentService {
  fault?: { stage: Stage; index: number }
  protected override onBatchStep(stage: Stage, index: number): void {
    if (this.fault && this.fault.stage === stage && this.fault.index === index) throw new Error(`INJECTED_${stage}_${index}`)
  }
}

const doc = (text: string): Record<string, unknown> => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

function setup(chapterCount = 5) {
  const db = new AppDatabase(':memory:')
  const projects = new ProjectService(db)
  const daily = new WritingDailyService(db)
  const docs = new FaultyDocuments(db, daily)
  const project = projects.create({ title: '替换书', projectType: 'novel', description: '' })
  const tree = docs.listTree(project.id)
  const volume = tree.find((n) => n.type === 'volume')!
  const first = tree.find((n) => n.type === 'chapter')!
  const ids = [first.id]
  for (let i = 1; i < chapterCount; i += 1) ids.push(docs.createNode({ projectId: project.id, parentId: volume.id, type: 'chapter', title: `第${i + 1}章` }).id)
  ids.forEach((id, i) => docs.saveContent({ projectId: project.id, documentId: id, editorJson: doc(`第${i + 1}章：林舟看见远处灯，远处灯又亮了。`), plainText: `第${i + 1}章：林舟看见远处灯，远处灯又亮了。` }))
  return { db, docs, daily, project, ids }
}

/** 整库逐表逐行导出（含 FTS 影子表），用于「逐字节不变」断言。 */
const dumpAll = (db: AppDatabase): string => {
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
  const encode = (value: unknown): string => JSON.stringify(value,
    (_key, item: unknown) => (item instanceof Uint8Array ? Buffer.from(item).toString('base64') : typeof item === 'bigint' ? item.toString() : item))
  // 有的 FTS 影子表是 WITHOUT ROWID，不能 ORDER BY rowid：逐行序列化后排序
  return encode(tables.map(({ name }) => [name, (db.raw.prepare(`SELECT * FROM "${name}"`).all() as unknown[]).map(encode).sort()]))
}

const replaceItems = (s: ReturnType<typeof setup>, ids = s.ids) => ids.map((id) => {
  const current = s.docs.getContent(s.project.id, id)
  const text = current.plainText.replaceAll('远处灯', '远处星')
  return { documentId: id, expectedRevision: current.revision, editorJson: doc(text), plainText: text, hits: 2 }
})
const meta = { query: '远处灯', replacement: '远处星', regex: false, caseSensitive: false }
const countSnapshots = (s: ReturnType<typeof setup>): number => (s.db.raw.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE project_id = ?').get(s.project.id) as { n: number }).n

describe('saveContent 抽出 writeContentInTx 后行为不变', () => {
  it('revision 逐次 +1、FTS 重建、码字计入、摘要标记过期', () => {
    const s = setup(1); const id = s.ids[0]
    const before = s.docs.getContent(s.project.id, id)
    const deletedBefore = s.daily.getDay(s.project.id).humanWordsDeleted
    const saved = s.docs.saveContent({ projectId: s.project.id, documentId: id, editorJson: doc('新的正文一二三'), plainText: '新的正文一二三', expectedRevision: before.revision })
    expect(saved.revision).toBe(before.revision + 1)
    expect(saved.plainText).toBe('新的正文一二三')
    expect((s.db.raw.prepare('SELECT plain_text FROM document_fts WHERE document_id = ?').get(id) as { plain_text: string }).plain_text).toBe('新的正文一二三')
    // 原文 16 字（15 个汉字 + 「1」）→ 新文 7 字：人工删除 +9
    expect(s.daily.getDay(s.project.id).humanWordsDeleted).toBe(deletedBefore + 9)
  })
  it('expectedRevision 不符时 fail-closed：抛 REVISION_CONFLICT，库里一字不变', () => {
    const s = setup(1); const id = s.ids[0]
    const before = dumpAll(s.db)
    const revision = s.docs.getContent(s.project.id, id).revision
    expect(() => s.docs.saveContent({ projectId: s.project.id, documentId: id, editorJson: doc('x'), plainText: 'x', expectedRevision: revision + 5 })).toThrow('REVISION_CONFLICT')
    expect(dumpAll(s.db)).toBe(before)
  })
  it('writingStats: skip 不计码字；大段删除前仍自动拍 large_delete 快照', () => {
    const s = setup(1); const id = s.ids[0]
    const long = '字'.repeat(1500)
    s.docs.saveContent({ projectId: s.project.id, documentId: id, editorJson: doc(long), plainText: long })
    const day = s.daily.getDay(s.project.id)
    s.docs.saveContent({ projectId: s.project.id, documentId: id, editorJson: doc('短'), plainText: '短', writingStats: 'skip' })
    expect(s.daily.getDay(s.project.id)).toEqual(day)
    expect(s.docs.listSnapshots(s.project.id, id).some((snap) => snap.reason === 'large_delete')).toBe(true)
  })
})

describe('documents:replaceBatch', () => {
  it('这个构建的 SQLite 支持 json_extract（restoreBatch 依赖）', () => {
    const s = setup(1)
    expect((s.db.raw.prepare("SELECT json_extract('{\"kind\":\"book_replace\",\"batchId\":\"b1\"}', '$.batchId') AS v").get() as { v: string }).v).toBe('b1')
  })
  it('正常 N 章：每章 revision +1，manual 快照记 kind=book_replace + batchId，FTS 更新，不计入码字', () => {
    const s = setup(5)
    const day = s.daily.getDay(s.project.id)
    const revisions = s.ids.map((id) => s.docs.getContent(s.project.id, id).revision)
    const result = s.docs.replaceBatch({ projectId: s.project.id, items: replaceItems(s), ...meta })
    expect(result.chapters).toBe(5); expect(result.hits).toBe(10)
    s.ids.forEach((id, i) => {
      const content = s.docs.getContent(s.project.id, id)
      expect(content.revision).toBe(revisions[i] + 1)
      expect(content.plainText).toContain('远处星'); expect(content.plainText).not.toContain('远处灯')
      const snaps = s.docs.listSnapshots(s.project.id, id).filter((snap) => snap.metadata.kind === 'book_replace')
      expect(snaps).toHaveLength(1)
      expect(snaps[0]).toMatchObject({ reason: 'manual', revision: revisions[i], metadata: { batchId: result.batchId, query: '远处灯', replacement: '远处星' } })
      expect(snaps[0].plainText).toContain('远处灯')
      expect((s.db.raw.prepare('SELECT plain_text FROM document_fts WHERE document_id = ?').get(id) as { plain_text: string }).plain_text).toContain('远处星')
    })
    expect(s.daily.getDay(s.project.id)).toEqual(day)
  })
  it('任一章 revision 冲突：整批回滚，库里逐字节不变', () => {
    const s = setup(5)
    const items = replaceItems(s); items[3] = { ...items[3], expectedRevision: items[3].expectedRevision + 1 }
    const before = dumpAll(s.db)
    expect(() => s.docs.replaceBatch({ projectId: s.project.id, items, ...meta })).toThrow(`REVISION_CONFLICT:${s.ids[3]}`)
    expect(dumpAll(s.db)).toBe(before)
  })
  it('拒绝空批次、重复章节、不属于本作品的章节', () => {
    const s = setup(2)
    expect(() => s.docs.replaceBatch({ projectId: s.project.id, items: [], ...meta })).toThrow('BOOK_REPLACE_EMPTY')
    const items = replaceItems(s)
    expect(() => s.docs.replaceBatch({ projectId: s.project.id, items: [items[0], items[0]], ...meta })).toThrow('BOOK_REPLACE_DUPLICATE_DOCUMENT')
    const before = dumpAll(s.db)
    expect(() => s.docs.replaceBatch({ projectId: s.project.id, items: [items[0], { ...items[1], documentId: 'nope' }], ...meta })).toThrow('DOCUMENT_NOT_FOUND_IN_PROJECT')
    expect(dumpAll(s.db)).toBe(before)
  })

  // 失败注入（组长定的四种情形）：之后每章内容、revision、FTS、快照数、码字全部逐字节不变，没有任何一章半写
  const cases: Array<[string, { stage: Stage; index: number }]> = [
    ['批次中途（第 3 章写完后）抛错', { stage: 'write', index: 2 }],
    ['第一章写完后抛错', { stage: 'write', index: 0 }],
    ['最后一章写完后抛错', { stage: 'write', index: 4 }],
    ['写快照时（第 3 章快照落库后）抛错', { stage: 'snapshot', index: 2 }]
  ]
  for (const [name, fault] of cases) it(`失败注入：${name} → 整批回滚`, () => {
    const s = setup(5)
    const items = replaceItems(s)
    const before = dumpAll(s.db)
    const snapshotCount = countSnapshots(s)
    const day = s.daily.getDay(s.project.id)
    const contents = s.ids.map((id) => s.docs.getContent(s.project.id, id))
    s.docs.fault = fault
    expect(() => s.docs.replaceBatch({ projectId: s.project.id, items, ...meta })).toThrow(`INJECTED_${fault.stage}_${fault.index}`)
    s.docs.fault = undefined
    expect(dumpAll(s.db)).toBe(before)
    expect(countSnapshots(s)).toBe(snapshotCount)
    expect(s.daily.getDay(s.project.id)).toEqual(day)
    s.ids.forEach((id, i) => {
      const now = s.docs.getContent(s.project.id, id)
      expect(now.revision).toBe(contents[i].revision); expect(now.plainText).toBe(contents[i].plainText); expect(now.editorJson).toEqual(contents[i].editorJson)
      expect((s.db.raw.prepare('SELECT plain_text FROM document_fts WHERE document_id = ?').get(id) as { plain_text: string }).plain_text).toBe(contents[i].plainText)
    })
    // 回滚后同一批次可以正常提交（没有残留锁或半写状态）
    expect(s.docs.replaceBatch({ projectId: s.project.id, items, ...meta }).chapters).toBe(5)
  })
})

describe('snapshots:restoreBatch', () => {
  it('整批恢复：逐章先拍 pre_restore 再写回，revision +1，不计入码字', () => {
    const s = setup(4)
    const originals = s.ids.map((id) => s.docs.getContent(s.project.id, id))
    const result = s.docs.replaceBatch({ projectId: s.project.id, items: replaceItems(s), ...meta })
    const day = s.daily.getDay(s.project.id)
    const restored = s.docs.restoreBatch(s.project.id, result.batchId)
    expect(restored.restored).toHaveLength(4); expect(restored.skipped).toEqual([])
    s.ids.forEach((id, i) => {
      const content = s.docs.getContent(s.project.id, id)
      expect(content.plainText).toBe(originals[i].plainText); expect(content.editorJson).toEqual(originals[i].editorJson)
      expect(content.revision).toBe(originals[i].revision + 2)
      const pre = s.docs.listSnapshots(s.project.id, id).filter((snap) => snap.reason === 'pre_restore')
      expect(pre).toHaveLength(1); expect(pre[0].metadata.batchId).toBe(result.batchId); expect(pre[0].plainText).toContain('远处星')
    })
    expect(s.daily.getDay(s.project.id)).toEqual(day)
  })
  it('替换后又改过的章跳过并列出，其余照常恢复；跳过的章不写入、不拍快照', () => {
    const s = setup(4)
    const originals = s.ids.map((id) => s.docs.getContent(s.project.id, id))
    const result = s.docs.replaceBatch({ projectId: s.project.id, items: replaceItems(s), ...meta })
    const edited = s.docs.getContent(s.project.id, s.ids[1])
    s.docs.saveContent({ projectId: s.project.id, documentId: s.ids[1], editorJson: doc(`${edited.plainText}后来加的`), plainText: `${edited.plainText}后来加的`, expectedRevision: edited.revision })
    const snapsBefore = s.docs.listSnapshots(s.project.id, s.ids[1]).length
    const restored = s.docs.restoreBatch(s.project.id, result.batchId)
    expect(restored.skipped).toEqual([{ documentId: s.ids[1], title: '第2章', reason: 'changed' }])
    expect(restored.restored.map((item) => item.documentId)).toEqual([s.ids[0], s.ids[2], s.ids[3]])
    expect(s.docs.getContent(s.project.id, s.ids[1]).plainText).toContain('后来加的')
    expect(s.docs.listSnapshots(s.project.id, s.ids[1]).length).toBe(snapsBefore)
    expect(s.docs.getContent(s.project.id, s.ids[0]).plainText).toBe(originals[0].plainText)
  })
  it('只恢复本作品本批次；找不到批次时报错', () => {
    const s = setup(2)
    const first = s.docs.replaceBatch({ projectId: s.project.id, items: replaceItems(s, [s.ids[0]]), ...meta })
    s.docs.replaceBatch({ projectId: s.project.id, items: replaceItems(s, [s.ids[1]]), ...meta })
    const restored = s.docs.restoreBatch(s.project.id, first.batchId)
    expect(restored.restored.map((item) => item.documentId)).toEqual([s.ids[0]])
    expect(() => s.docs.restoreBatch(s.project.id, 'missing-batch')).toThrow('BOOK_REPLACE_BATCH_NOT_FOUND')
    expect(() => s.docs.restoreBatch('other-project', first.batchId)).toThrow('BOOK_REPLACE_BATCH_NOT_FOUND')
  })
  it('恢复途中抛错：整批回滚，库里逐字节不变', () => {
    const s = setup(4)
    const result = s.docs.replaceBatch({ projectId: s.project.id, items: replaceItems(s), ...meta })
    const before = dumpAll(s.db)
    s.docs.fault = { stage: 'write', index: 2 }
    expect(() => s.docs.restoreBatch(s.project.id, result.batchId)).toThrow('INJECTED_write_2')
    s.docs.fault = undefined
    expect(dumpAll(s.db)).toBe(before)
  })
})

describe('备份往返与界面文案', () => {
  const dirs: string[] = []
  afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })) })
  it('含全书替换快照的备份导出再导入：metadata.kind / batchId 保留，restoreBatch 照样可用', async () => {
    const s = setup(2)
    const result = s.docs.replaceBatch({ projectId: s.project.id, items: replaceItems(s), ...meta })
    const dir = mkdtempSync(join(tmpdir(), 'inkstone-book-replace-')); dirs.push(dir)
    const backup = new BackupService(s.db)
    await backup.exportProject(s.project.id, join(dir, 'b.aiwproj'))
    const imported = await backup.importProject(join(dir, 'b.aiwproj'))
    const chapters = s.docs.listTree(imported.id).filter((node) => node.type === 'chapter')
    const snaps = chapters.flatMap((node) => s.docs.listSnapshots(imported.id, node.id)).filter((snap) => snap.metadata.kind === 'book_replace')
    expect(snaps).toHaveLength(2); expect(snaps.every((snap) => snap.reason === 'manual' && snap.metadata.batchId === result.batchId)).toBe(true)
    const restored = s.docs.restoreBatch(imported.id, result.batchId)
    expect(restored.restored).toHaveLength(2)
    chapters.forEach((node) => expect(s.docs.getContent(imported.id, node.id).plainText).toContain('远处灯'))
  })
  it('历史页：manual + kind=book_replace 显示「全书替换前」，普通 manual 仍是「手动快照」', () => {
    expect(snapshotReason({ reason: 'manual', metadata: { kind: 'book_replace', batchId: 'b' } })).toBe('全书替换前')
    expect(snapshotReason({ reason: 'manual', metadata: {} })).toBe('手动快照')
    expect(snapshotReason({ reason: 'pre_restore', metadata: { batchId: 'b' } })).toBe('恢复前备份')
  })
  it('IPC 入参校验：空批次、超 10 万处、多余字段、缺字段都拒绝', () => {
    const item = { documentId: 'd', expectedRevision: 1, editorJson: { type: 'doc', content: [] }, plainText: '', hits: 1 }
    const base = { projectId: 'p', items: [item], query: 'a', replacement: 'b', regex: false, caseSensitive: false }
    expect(bookReplaceSchema.safeParse(base).success).toBe(true)
    expect(bookReplaceSchema.safeParse({ ...base, items: [] }).success).toBe(false)
    expect(bookReplaceSchema.safeParse({ ...base, items: [{ ...item, hits: 60_000 }, { ...item, documentId: 'e', hits: 60_000 }] }).success).toBe(false)
    expect(bookReplaceSchema.safeParse({ ...base, items: [{ ...item, reason: 'manual' }] }).success).toBe(false)
    expect(bookReplaceSchema.safeParse({ ...base, metadata: { kind: 'x' } }).success).toBe(false)
    expect(bookReplaceSchema.safeParse({ ...base, query: '' }).success).toBe(false)
    expect(bookReplaceSchema.safeParse({ ...base, items: [{ ...item, expectedRevision: undefined }] }).success).toBe(false)
  })
})

describe('1000 章计时（main 层，不跑 Electron）', () => {
  it('replaceBatch 1000 章单事务 ≤2s；restoreBatch（json_extract 全扫本书快照）计时', () => {
    const s = setup(1000)
    const items = replaceItems(s)
    const started = performance.now()
    const result = s.docs.replaceBatch({ projectId: s.project.id, items, ...meta })
    const replaceMs = performance.now() - started
    const restoreStarted = performance.now()
    const restored = s.docs.restoreBatch(s.project.id, result.batchId)
    const restoreMs = performance.now() - restoreStarted
    process.stdout.write(`P3 book-replace main 1000 chapters: replaceBatch ${Math.round(replaceMs)}ms (limit 2000ms), restoreBatch ${Math.round(restoreMs)}ms\n`)
    expect(result.chapters).toBe(1000); expect(restored.restored).toHaveLength(1000)
    expect(replaceMs).toBeLessThanOrEqual(2000)
  }, 60_000)
})
