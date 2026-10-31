import { createHash, randomUUID } from 'node:crypto'
import type { BookReplaceResult, BookRestoreResult, ChapterStatus, DocumentContent, DocumentNode, DocumentType, SearchResult, Snapshot, TextOrigin, NodeOutline, SerialProgress, StockpileSummary } from '../../shared/domain'
import { computeStockpile } from '../../shared/stockpile'
import type { AppDatabase } from '../database/database'
import { WritingDailyService } from './writing-daily-service'
import { StyleSampleService } from './style-sample-service'

type NodeRow = {
  id: string; project_id: string; parent_id: string | null; type: DocumentType; title: string
  order_index: number; status: ChapterStatus; word_count: number | null; revision: number | null
  created_at: number; updated_at: number
}
type ContentRow = {
  document_id: string; project_id: string; editor_json: string; plain_text: string
  word_count: number; revision: number; updated_at: number
}

const mapNode = (row: NodeRow): DocumentNode => ({
  id: row.id, projectId: row.project_id, parentId: row.parent_id, type: row.type, title: row.title,
  orderIndex: row.order_index, status: row.status ?? 'outline', wordCount: row.word_count ?? 0, revision: row.revision ?? 0,
  createdAt: row.created_at, updatedAt: row.updated_at
})

const mapContent = (row: ContentRow): DocumentContent => ({
  documentId: row.document_id, projectId: row.project_id,
  editorJson: JSON.parse(row.editor_json) as Record<string, unknown>, plainText: row.plain_text,
  wordCount: row.word_count, revision: row.revision, updatedAt: row.updated_at
})

export const countChineseWords = (text: string): number => {
  const han = text.match(/[\p{Script=Han}]/gu)?.length ?? 0
  const words = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0
  return han + words
}

/** 每章（每个文档节点）最多保留的快照数；受保护的点见 DocumentService.pruneSnapshots */
export const SNAPSHOT_CAP_PER_DOCUMENT = 50

export class DocumentService {
  private readonly styleSamples: StyleSampleService
  private readonly writingDaily: WritingDailyService
  constructor(private readonly db: AppDatabase, writingDaily?: WritingDailyService) {
    this.styleSamples = new StyleSampleService(db)
    this.writingDaily = writingDaily ?? new WritingDailyService(db)
  }

  private assertNode(projectId: string, documentId: string): NodeRow {
    const row = this.db.raw.prepare(`
      SELECT n.*, c.word_count, c.revision FROM document_nodes n
      LEFT JOIN document_contents c ON c.document_id = n.id
      WHERE n.id = ? AND n.project_id = ?
    `).get(documentId, projectId) as NodeRow | undefined
    if (!row) throw new Error('DOCUMENT_NOT_FOUND_IN_PROJECT')
    return row
  }

  listTree(projectId: string): DocumentNode[] {
    const rows = this.db.raw.prepare(`
      SELECT n.*, c.word_count, c.revision FROM document_nodes n
      LEFT JOIN document_contents c ON c.document_id = n.id
      LEFT JOIN document_nodes parent ON parent.id = n.parent_id AND parent.project_id = n.project_id
      WHERE n.project_id = ?
      ORDER BY CASE WHEN n.type = 'volume' THEN n.order_index ELSE COALESCE(parent.order_index, 2147483647) END,
        CASE WHEN n.type = 'volume' THEN 0 ELSE 1 END, n.order_index, n.created_at
    `).all(projectId) as NodeRow[]
    return rows.map(mapNode)
  }

  listOrderedChapters(projectId: string): DocumentNode[] {
    const rows = this.db.raw.prepare(`
      SELECT chapter.*, content.word_count, content.revision
      FROM document_nodes chapter
      JOIN document_nodes volume ON volume.id = chapter.parent_id AND volume.project_id = chapter.project_id
      LEFT JOIN document_contents content ON content.document_id = chapter.id
      WHERE chapter.project_id = ? AND chapter.type = 'chapter' AND volume.type = 'volume'
      ORDER BY volume.order_index, chapter.order_index, chapter.created_at
    `).all(projectId) as NodeRow[]
    return rows.map(mapNode)
  }

  setChapterStatus(projectId: string, documentId: string, status: ChapterStatus): DocumentNode {
    const node = this.assertNode(projectId, documentId)
    if (node.type !== 'chapter') throw new Error('CHAPTER_STATUS_REQUIRES_CHAPTER')
    if (!['outline', 'draft', 'final'].includes(status)) throw new Error('CHAPTER_STATUS_INVALID')
    this.db.raw.prepare('UPDATE document_nodes SET status = ?, updated_at = ? WHERE id = ? AND project_id = ?')
      .run(status, Date.now(), documentId, projectId)
    return mapNode(this.assertNode(projectId, documentId))
  }

  private readSettings(projectId: string): Record<string, unknown> {
    const row = this.db.raw.prepare('SELECT settings_json FROM projects WHERE id = ?').get(projectId) as
      | { settings_json: string } | undefined
    if (!row) throw new Error('PROJECT_NOT_FOUND')
    try {
      const parsed = JSON.parse(row.settings_json || '{}') as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch { return {} }
  }

  getSerialProgress(projectId: string): SerialProgress {
    const settings = this.readSettings(projectId)
    const id = settings.serialProgressChapterId
    return { progressChapterId: typeof id === 'string' && id.length > 0 ? id : null }
  }

  setSerialProgress(projectId: string, progressChapterId: string | null): SerialProgress {
    const settings = this.readSettings(projectId)
    if (progressChapterId) {
      const node = this.assertNode(projectId, progressChapterId)
      if (node.type !== 'chapter') throw new Error('SERIAL_PROGRESS_REQUIRES_CHAPTER')
      settings.serialProgressChapterId = progressChapterId
    } else {
      delete settings.serialProgressChapterId
    }
    this.db.raw.prepare('UPDATE projects SET settings_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(settings), Date.now(), projectId)
    return this.getSerialProgress(projectId)
  }

  getStockpile(projectId: string): StockpileSummary {
    const chapters = this.listOrderedChapters(projectId)
    const progress = this.getSerialProgress(projectId)
    const goals = this.writingDaily.getGoals(projectId)
    const computed = computeStockpile({
      chapters: chapters.map((chapter) => ({
        id: chapter.id, title: chapter.title, status: chapter.status, wordCount: chapter.wordCount
      })),
      progressChapterId: progress.progressChapterId,
      dailyChapterGoalEnabled: goals.dailyChapterGoalEnabled,
      dailyChapterGoal: goals.dailyChapterGoal
    })
    return { ...computed, progress }
  }

  getContent(projectId: string, documentId: string): DocumentContent {
    this.assertNode(projectId, documentId)
    const row = this.db.raw.prepare('SELECT * FROM document_contents WHERE document_id = ? AND project_id = ?')
      .get(documentId, projectId) as ContentRow | undefined
    if (!row) throw new Error('DOCUMENT_HAS_NO_CONTENT')
    return mapContent(row)
  }

  createNode(input: { projectId: string; parentId?: string | null; type: DocumentType; title: string }): DocumentNode {
    const parent = input.parentId ? this.assertNode(input.projectId, input.parentId) : undefined
    if (input.type === 'volume' && parent) throw new Error('VOLUME_MUST_BE_ROOT')
    if (input.type === 'chapter' && parent?.type !== 'volume') throw new Error('CHAPTER_REQUIRES_VOLUME')
    if (!input.title.trim()) throw new Error('DOCUMENT_TITLE_REQUIRED')
    const id = randomUUID()
    const now = Date.now()
    const max = this.db.raw.prepare(`
      SELECT COALESCE(MAX(order_index), -1) AS value FROM document_nodes
      WHERE project_id = ? AND parent_id IS ?
    `).get(input.projectId, input.parentId ?? null) as { value: number }
    this.db.transaction(() => {
      // 新章默认构思（0 字）；卷用 outline 占位。不自动定稿。
      const initialStatus: ChapterStatus = 'outline'
      this.db.raw.prepare(`INSERT INTO document_nodes
        (id, project_id, parent_id, type, title, order_index, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.projectId, input.parentId ?? null, input.type, input.title.trim(), max.value + 1, initialStatus, now, now)
      if (input.type !== 'volume') {
        const empty = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] })
        this.db.raw.prepare(`INSERT INTO document_contents
          (document_id, project_id, editor_json, plain_text, word_count, revision, updated_at)
          VALUES (?, ?, ?, '', 0, 0, ?)`)
          .run(id, input.projectId, empty, now)
        this.db.raw.prepare('INSERT INTO document_fts(project_id, document_id, title, plain_text) VALUES (?, ?, ?, ?)')
          .run(input.projectId, id, input.title.trim(), '')
      }
      this.db.raw.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, input.projectId)
    })
    return mapNode(this.assertNode(input.projectId, id))
  }

  rename(projectId: string, documentId: string, title: string): void {
    this.assertNode(projectId, documentId)
    if (!title.trim()) throw new Error('DOCUMENT_TITLE_REQUIRED')
    this.db.transaction(() => {
      this.db.raw.prepare('UPDATE document_nodes SET title = ?, updated_at = ? WHERE id = ? AND project_id = ?')
        .run(title.trim(), Date.now(), documentId, projectId)
      this.db.raw.prepare('UPDATE document_fts SET title = ? WHERE document_id = ? AND project_id = ?')
        .run(title.trim(), documentId, projectId)
    })
  }

  reorder(projectId: string, documentId: string, parentId: string | null, orderIndex: number): void {
    const node = this.assertNode(projectId, documentId)
    const parent = parentId ? this.assertNode(projectId, parentId) : undefined
    if (node.type === 'volume' && parent) throw new Error('VOLUME_MUST_BE_ROOT')
    if (node.type === 'chapter' && parent?.type !== 'volume') throw new Error('CHAPTER_REQUIRES_VOLUME')
    this.db.transaction(() => {
      const siblings = this.db.raw.prepare(`
        SELECT id FROM document_nodes WHERE project_id = ? AND parent_id IS ? AND id != ? ORDER BY order_index
      `).all(projectId, parentId, documentId) as { id: string }[]
      siblings.splice(Math.max(0, Math.min(orderIndex, siblings.length)), 0, { id: documentId })
      const update = this.db.raw.prepare('UPDATE document_nodes SET parent_id = ?, order_index = ?, updated_at = ? WHERE id = ? AND project_id = ?')
      siblings.forEach((item, index) => update.run(parentId, -(index + 1), Date.now(), item.id, projectId))
      siblings.forEach((item, index) => update.run(parentId, index, Date.now(), item.id, projectId))
    })
  }

  delete(projectId: string, documentId: string): void {
    this.assertNode(projectId, documentId)
    this.db.transaction(() => {
      const descendantIds = this.db.raw.prepare(`
        WITH RECURSIVE children(id) AS (
          SELECT id FROM document_nodes WHERE id = ? AND project_id = ?
          UNION ALL SELECT n.id FROM document_nodes n JOIN children c ON n.parent_id = c.id WHERE n.project_id = ?
        ) SELECT id FROM children
      `).all(documentId, projectId, projectId) as { id: string }[]
      const delFts = this.db.raw.prepare('DELETE FROM document_fts WHERE project_id = ? AND document_id = ?')
      descendantIds.forEach(({ id }) => delFts.run(projectId, id))
      this.db.raw.prepare('DELETE FROM document_nodes WHERE id = ? AND project_id = ?').run(documentId, projectId)
    })
  }

  saveContent(input: {
    projectId: string; documentId: string; editorJson: Record<string, unknown>; plainText: string
    expectedRevision?: number; styleSample?: { origin: TextOrigin; text: string }
    /** skip：快照恢复 / AI 采纳保存等，不计入人工码字（AI 字数由 PatchService.complete 记账）。 */
    writingStats?: 'human' | 'skip'
  }): DocumentContent {
    const current = this.getContent(input.projectId, input.documentId)
    if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) throw new Error('REVISION_CONFLICT')
    const deletion = current.plainText.length - input.plainText.length
    // 自动快照（含每章上限修剪）与正文写入同一事务：任一步失败整体 ROLLBACK，不会出现「旧快照删了 / 新快照或正文没写进」的中间态
    this.db.transaction(() => {
      if (deletion > 1000) this.createSnapshot(input.projectId, input.documentId, 'large_delete')
      const latestSnapshot = this.db.raw.prepare('SELECT created_at FROM snapshots WHERE project_id = ? AND document_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(input.projectId, input.documentId) as { created_at: number } | undefined
      if (current.revision > 0 && (!latestSnapshot || Date.now() - latestSnapshot.created_at >= 10 * 60 * 1000)) {
        this.createSnapshot(input.projectId, input.documentId, 'interval')
      }
      this.writeContentInTx(input, current)
    })
    return this.getContent(input.projectId, input.documentId)
  }

  /**
   * 正文写库（P3 PR-2b 从 saveContent 抽出，内容不变）：UPDATE 正文 / 节点 / 作品时间，重建 FTS，标记摘要过期，
   * 记风格样本和码字。只能在外层 db.transaction 里调用（事务不可嵌套）；revision = current.revision + 1。
   */
  private writeContentInTx(input: {
    projectId: string; documentId: string; editorJson: Record<string, unknown>; plainText: string
    styleSample?: { origin: TextOrigin; text: string }; writingStats?: 'human' | 'skip'
    /** 全书替换 / 整批恢复：机械改写不是人的文风样本，跳过（style_samples 按 document_id 查无索引，1000 章会 O(n²)） */
    styleSamples?: 'skip'
    /** 已序列化的正文 JSON（整批恢复直接用快照里的字符串，免一次 parse + stringify） */
    editorJsonText?: string
  }, current: Pick<DocumentContent, 'revision' | 'plainText'>, ftsRowids?: Map<string, number[]>): number {
    const now = Date.now()
    const revision = current.revision + 1
    const wordCount = countChineseWords(input.plainText)
    const skipHuman = input.writingStats === 'skip' || input.styleSample?.origin === 'ai'
    this.db.raw.prepare(`UPDATE document_contents SET editor_json = ?, plain_text = ?, word_count = ?, revision = ?, updated_at = ?
      WHERE document_id = ? AND project_id = ?`)
      .run(input.editorJsonText ?? JSON.stringify(input.editorJson), input.plainText, wordCount, revision, now, input.documentId, input.projectId)
    this.db.raw.prepare('UPDATE document_nodes SET updated_at = ? WHERE id = ? AND project_id = ?')
      .run(now, input.documentId, input.projectId)
    this.db.raw.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, input.projectId)
    if (ftsRowids) {
      // 批量路径：按事先一次扫描得到的 rowid 删除（FTS5 按 document_id 删除会全表扫描，1000 章即 O(n²)）
      const del = this.db.raw.prepare('DELETE FROM document_fts WHERE rowid = ?')
      for (const rowid of ftsRowids.get(input.documentId) ?? []) del.run(rowid)
    } else this.db.raw.prepare('DELETE FROM document_fts WHERE document_id = ? AND project_id = ?').run(input.documentId, input.projectId)
    const node = this.assertNode(input.projectId, input.documentId)
    this.db.raw.prepare('INSERT INTO document_fts(project_id, document_id, title, plain_text) VALUES (?, ?, ?, ?)')
      .run(input.projectId, input.documentId, node.title, input.plainText)
    this.db.raw.prepare('UPDATE chapter_digests SET stale = 1 WHERE chapter_id = ? AND project_id = ? AND chapter_revision < ?')
      .run(input.documentId, input.projectId, revision)
    if (input.styleSample) this.styleSamples.record({ projectId: input.projectId, documentId: input.documentId,
      origin: input.styleSample.origin, text: input.styleSample.text, sourceRevision: revision })
    else if (input.styleSamples !== 'skip') this.styleSamples.recordHumanIfSafe(input.projectId, input.documentId, input.plainText, revision)
    if (!skipHuman) {
      const delta = wordCount - countChineseWords(current.plainText)
      if (delta > 0) this.writingDaily.addHumanWords(input.projectId, { added: delta })
      else if (delta < 0) this.writingDaily.addHumanWords(input.projectId, { deleted: -delta })
    }
    return revision
  }

  /** 测试钩子（失败注入）：批量替换 / 恢复每章各阶段之后调用；生产里为空操作。 */
  /** 批量路径读当前正文：不解析 JSON（快照直接存原字符串）。 */
  private rawContent(projectId: string, documentId: string): { editorJsonText: string; plainText: string; revision: number } {
    const row = this.db.raw.prepare('SELECT editor_json, plain_text, revision FROM document_contents WHERE document_id = ? AND project_id = ?')
      .get(documentId, projectId) as { editor_json: string; plain_text: string; revision: number } | undefined
    if (!row) throw new Error('DOCUMENT_HAS_NO_CONTENT')
    return { editorJsonText: row.editor_json, plainText: row.plain_text, revision: row.revision }
  }

  /** 批量路径拍快照：与 createSnapshot 写同样的行，但用已读出的原字符串。 */
  private insertSnapshotRaw(projectId: string, documentId: string, reason: Snapshot['reason'], current: { editorJsonText: string; plainText: string; revision: number }, metadata: Record<string, unknown>): void {
    this.db.raw.prepare(`INSERT INTO snapshots
      (id, project_id, document_id, reason, revision, content, plain_text, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), projectId, documentId, reason, current.revision, current.editorJsonText, current.plainText, JSON.stringify(metadata), Date.now())
    this.pruneSnapshots(projectId, documentId, current.revision)
  }

  /**
   * 每章快照上限（P3）：插入新快照后、同一事务内调用。总数超过 SNAPSHOT_CAP_PER_DOCUMENT 时按 created_at（同毫秒按 rowid）删最旧的「可淘汰」快照。
   * 受保护（计入总数但永不淘汰）：
   * - 当前版本：revision 等于当前正文 revision 的快照（含刚写入的这一条；正文本身在 document_contents，不在本表）；
   * - 整批恢复点：reason = manual 且 metadata.kind = book_replace（restoreBatch 按 batchId 读的正是这些行），
   *   以及整批恢复前打的 pre_restore（metadata 带 batchId）。
   * 受保护的点本身超过上限时全部保留，只淘汰其余可淘汰的快照（此时总数 > 上限）。
   * 失败直接抛出，由外层事务 / SAVEPOINT 回滚。
   */
  private pruneSnapshots(projectId: string, documentId: string, currentRevision: number): void {
    const { n } = this.db.raw.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE project_id = ? AND document_id = ?').get(projectId, documentId) as { n: number }
    if (n <= SNAPSHOT_CAP_PER_DOCUMENT) return
    const victims = this.db.raw.prepare(`SELECT rowid AS rowid FROM snapshots
      WHERE project_id = ? AND document_id = ? AND revision != ?
        AND NOT (reason = 'manual' AND json_extract(metadata_json, '$.kind') = 'book_replace')
        AND NOT (reason = 'pre_restore' AND json_extract(metadata_json, '$.batchId') IS NOT NULL)
      ORDER BY created_at ASC, rowid ASC LIMIT ?`).all(projectId, documentId, currentRevision, n - SNAPSHOT_CAP_PER_DOCUMENT) as Array<{ rowid: number }>
    const del = this.db.raw.prepare('DELETE FROM snapshots WHERE rowid = ?')
    for (const { rowid } of victims) del.run(rowid)
    this.onSnapshotsPruned(documentId, victims.length)
  }

  /** 测试钩子（失败注入）：修剪删除之后、事务提交之前调用；生产里为空操作。 */
  protected onSnapshotsPruned(documentId: string, deleted: number): void { void documentId; void deleted }

  /** 一次扫描本作品 FTS 行：document_id → rowid[]（只读 UNINDEXED 列，事务内调用）。 */
  private ftsRowidMap(projectId: string): Map<string, number[]> {
    const map = new Map<string, number[]>()
    const rows = this.db.raw.prepare('SELECT rowid AS rowid, document_id FROM document_fts WHERE project_id = ?').all(projectId) as Array<{ rowid: number; document_id: string }>
    for (const row of rows) { const list = map.get(row.document_id); if (list) list.push(row.rowid); else map.set(row.document_id, [row.rowid]) }
    return map
  }

  protected onBatchStep(stage: 'snapshot' | 'write', index: number): void { void stage; void index }

  /**
   * 全书替换（P3 PR-2b）：整批只开一个事务。逐章核对 expectedRevision（不符抛 REVISION_CONFLICT:{id}），
   * 先拍 manual 快照（metadata.kind = book_replace + batchId），再写正文；任何一章出错整批 ROLLBACK，一个字都不写。
   * 不做 large_delete / interval 快照判断（已有全书替换快照）；不计入码字（writingStats: skip）。
   */
  replaceBatch(input: {
    projectId: string
    items: Array<{ documentId: string; expectedRevision: number; editorJson: Record<string, unknown>; plainText: string; hits: number }>
    query: string; replacement: string; regex: boolean; caseSensitive: boolean
  }): BookReplaceResult {
    if (!input.items.length) throw new Error('BOOK_REPLACE_EMPTY')
    if (new Set(input.items.map((item) => item.documentId)).size !== input.items.length) throw new Error('BOOK_REPLACE_DUPLICATE_DOCUMENT')
    const batchId = randomUUID()
    const hits = input.items.reduce((sum, item) => sum + item.hits, 0)
    const t0 = performance.now(); let t1 = t0; let t2 = t0
    const contents = this.db.bulkTransaction(() => { const fts = this.ftsRowidMap(input.projectId); t1 = performance.now(); const out = input.items.map((item, index) => {
      const node = this.assertNode(input.projectId, item.documentId)
      if (node.type !== 'chapter' && node.type !== 'scene') throw new Error('BOOK_REPLACE_NOT_CHAPTER')
      const current = this.rawContent(input.projectId, item.documentId)
      if (current.revision !== item.expectedRevision) throw new Error(`REVISION_CONFLICT:${item.documentId}`)
      this.insertSnapshotRaw(input.projectId, item.documentId, 'manual', current, {
        kind: 'book_replace', batchId, query: input.query, replacement: input.replacement,
        regex: input.regex, caseSensitive: input.caseSensitive, hits: item.hits, batchHits: hits
      })
      this.onBatchStep('snapshot', index)
      const revision = this.writeContentInTx({ projectId: input.projectId, documentId: item.documentId, editorJson: item.editorJson, plainText: item.plainText, writingStats: 'skip', styleSamples: 'skip' }, current, fts)
      this.onBatchStep('write', index)
      return { documentId: item.documentId, revision }
    }); t2 = performance.now(); return out })
    const timing = { readMs: Math.round(t1 - t0), bodyMs: Math.round(t2 - t1), commitMs: Math.round(performance.now() - t2) }
    return { batchId, chapters: contents.length, hits, contents, timing }
  }

  /**
   * 整批恢复一次全书替换（P3 PR-2b）：找出本作品 kind=book_replace 且 batchId 匹配的快照（json_extract 全扫本书快照），
   * 一个事务内逐章：替换后又改过（当前 revision ≠ 快照 revision + 1）或章已删除 → 跳过并列出；否则先拍 pre_restore 再写回。
   */
  restoreBatch(projectId: string, batchId: string): BookRestoreResult {
    const t0 = performance.now()
    const rows = this.db.raw.prepare(`SELECT s.id, s.document_id, s.revision, s.content, s.plain_text FROM snapshots s
      WHERE s.project_id = ? AND s.reason = 'manual'
        AND json_extract(s.metadata_json, '$.kind') = 'book_replace' AND json_extract(s.metadata_json, '$.batchId') = ?
      ORDER BY s.created_at, s.rowid`).all(projectId, batchId) as Array<{ id: string; document_id: string; revision: number; content: string; plain_text: string }>
    if (!rows.length) throw new Error('BOOK_REPLACE_BATCH_NOT_FOUND')
    const t1 = performance.now(); let t2 = t1
    const result = this.db.bulkTransaction(() => {
      const fts = this.ftsRowidMap(projectId)
      const restored: Array<{ documentId: string; revision: number }> = []
      const skipped: Array<{ documentId: string; title: string; reason: 'changed' | 'deleted' }> = []
      rows.forEach((row, index) => {
        const node = this.db.raw.prepare('SELECT title FROM document_nodes WHERE id = ? AND project_id = ?').get(row.document_id, projectId) as { title: string } | undefined
        if (!node) { skipped.push({ documentId: row.document_id, title: '', reason: 'deleted' }); return }
        const current = this.rawContent(projectId, row.document_id)
        if (current.revision !== row.revision + 1) { skipped.push({ documentId: row.document_id, title: node.title, reason: 'changed' }); return }
        this.insertSnapshotRaw(projectId, row.document_id, 'pre_restore', current, { restoredFrom: row.id, batchId })
        this.onBatchStep('snapshot', index)
        const revision = this.writeContentInTx({ projectId, documentId: row.document_id,
          editorJson: {}, editorJsonText: row.content, plainText: row.plain_text, writingStats: 'skip', styleSamples: 'skip' }, current, fts)
        this.onBatchStep('write', index)
        restored.push({ documentId: row.document_id, revision })
      })
      t2 = performance.now()
      return { batchId, restored, skipped }
    })
    return { ...result, timing: { readMs: Math.round(t1 - t0), bodyMs: Math.round(t2 - t1), commitMs: Math.round(performance.now() - t2) } }
  }

  createSnapshot(projectId: string, documentId: string, reason: Snapshot['reason'], metadata: Record<string, unknown> = {}): Snapshot {
    const current = this.getContent(projectId, documentId)
    const snapshot: Snapshot = {
      id: randomUUID(), projectId, documentId, reason, revision: current.revision,
      content: JSON.stringify(current.editorJson), plainText: current.plainText, metadata, createdAt: Date.now()
    }
    // 插入 + 修剪原子化：SAVEPOINT 在外层事务内（saveContent / prepareBatch）是嵌套保存点，单独调用时（IPC / restoreSnapshot / prepare）自成一个事务
    this.db.raw.exec('SAVEPOINT snapshot_cap')
    try {
      this.db.raw.prepare(`INSERT INTO snapshots
        (id, project_id, document_id, reason, revision, content, plain_text, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(snapshot.id, projectId, documentId, reason, snapshot.revision, snapshot.content, snapshot.plainText, JSON.stringify(metadata), snapshot.createdAt)
      this.pruneSnapshots(projectId, documentId, snapshot.revision)
      this.db.raw.exec('RELEASE snapshot_cap')
    } catch (error) {
      this.db.raw.exec('ROLLBACK TO snapshot_cap')
      this.db.raw.exec('RELEASE snapshot_cap')
      throw error
    }
    return snapshot
  }

  listSnapshots(projectId: string, documentId: string): Snapshot[] {
    this.assertNode(projectId, documentId)
    const rows = this.db.raw.prepare('SELECT * FROM snapshots WHERE project_id = ? AND document_id = ? ORDER BY created_at DESC')
      .all(projectId, documentId) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: row.id as string, projectId: row.project_id as string, documentId: row.document_id as string,
      reason: row.reason as Snapshot['reason'], revision: row.revision as number, content: row.content as string,
      plainText: row.plain_text as string, metadata: JSON.parse(row.metadata_json as string) as Record<string, unknown>,
      createdAt: row.created_at as number
    }))
  }

  restoreSnapshot(projectId: string, snapshotId: string): DocumentContent {
    const row = this.db.raw.prepare('SELECT * FROM snapshots WHERE id = ? AND project_id = ?').get(snapshotId, projectId) as Record<string, unknown> | undefined
    if (!row) throw new Error('SNAPSHOT_NOT_FOUND_IN_PROJECT')
    const documentId = row.document_id as string
    const reason = row.reason as string
    let metadata: Record<string, unknown> = {}
    try { metadata = JSON.parse(String(row.metadata_json || '{}')) as Record<string, unknown> } catch { metadata = {} }
    this.createSnapshot(projectId, documentId, 'pre_restore', { restoredFrom: snapshotId })
    const content = this.saveContent({
      projectId, documentId,
      editorJson: JSON.parse(row.content as string) as Record<string, unknown>,
      plainText: row.plain_text as string,
      writingStats: 'skip'
    })
    // 撤销已采纳的 AI 补丁：回退 ai_words_accepted（不计入码字）
    if (reason === 'ai_edit' && typeof metadata.patchId === 'string') {
      const patch = this.db.raw.prepare('SELECT replacement, status FROM text_patches WHERE id = ? AND project_id = ?')
        .get(metadata.patchId, projectId) as { replacement: string; status: string } | undefined
      if (patch?.status === 'accepted') {
        const words = countChineseWords(patch.replacement)
        if (words > 0) this.writingDaily.addAiAcceptedWords(projectId, -words)
      }
    }
    return content
  }

  search(projectId: string, query: string, limit = 30): SearchResult[] {
    if (!query.trim()) return []
    const trimmed = query.trim()
    if ([...trimmed].length < 3) {
      const like = `%${trimmed.replace(/[\\%_]/g, '\\$&')}%`
      const rows = this.db.raw.prepare(`
        SELECT f.project_id, f.document_id, n.title, f.plain_text
        FROM document_fts f JOIN document_nodes n ON n.id = f.document_id
        WHERE f.project_id = ? AND (f.title LIKE ? ESCAPE '\\' OR f.plain_text LIKE ? ESCAPE '\\')
        ORDER BY n.updated_at DESC LIMIT ?
      `).all(projectId, like, like, limit) as Array<{ project_id: string; document_id: string; title: string; plain_text: string }>
      return rows.map((row) => {
        const index = row.plain_text.indexOf(trimmed)
        const start = Math.max(0, index - 24)
        const excerpt = index >= 0 ? row.plain_text.slice(start, index + trimmed.length + 48) : row.plain_text.slice(0, 72)
        return { projectId: row.project_id, documentId: row.document_id, title: row.title, snippet: excerpt.replace(trimmed, `<mark>${trimmed}</mark>`), rank: 0 }
      })
    }
    const cleaned = query.replace(/["'()*:^]/g, ' ').trim()
    if (!cleaned) return []
    const sanitized = cleaned.split(/\s+/).map((term) => `"${term}"`).join(' OR ')
    const rows = this.db.raw.prepare(`
      SELECT f.project_id, f.document_id, n.title,
        snippet(document_fts, 3, '<mark>', '</mark>', '…', 18) AS snippet,
        bm25(document_fts) AS rank
      FROM document_fts f JOIN document_nodes n ON n.id = f.document_id
      WHERE document_fts MATCH ? AND f.project_id = ?
      ORDER BY rank LIMIT ?
    `).all(sanitized, projectId, limit) as Array<{ project_id: string; document_id: string; title: string; snippet: string; rank: number }>
    return rows.map((row) => ({ projectId: row.project_id, documentId: row.document_id, title: row.title, snippet: row.snippet, rank: row.rank }))
  }

  getOutline(projectId: string, nodeId: string): NodeOutline | null {
    const row = this.db.raw.prepare('SELECT * FROM node_outlines WHERE project_id = ? AND node_id = ?').get(projectId, nodeId) as Record<string, unknown> | undefined
    return row ? mapOutline(row) : null
  }

  listOutlines(projectId: string): NodeOutline[] {
    const rows = this.db.raw.prepare('SELECT * FROM node_outlines WHERE project_id = ?').all(projectId) as Array<Record<string, unknown>>
    return rows.map(mapOutline)
  }

  saveOutline(input: { projectId: string; nodeId: string; summary?: string; beats?: string[]; hook?: string }): NodeOutline {
    const node = this.db.raw.prepare("SELECT type FROM document_nodes WHERE id = ? AND project_id = ?").get(input.nodeId, input.projectId) as { type: string } | undefined
    if (!node) throw new Error('DOCUMENT_NOT_FOUND_IN_PROJECT')
    if (node.type !== 'volume' && node.type !== 'chapter') throw new Error('OUTLINE_NODE_TYPE_INVALID')
    const existing = this.getOutline(input.projectId, input.nodeId)
    this.db.raw.prepare(`INSERT INTO node_outlines(node_id,project_id,summary,beats_json,hook,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(node_id) DO UPDATE SET summary=excluded.summary,beats_json=excluded.beats_json,hook=excluded.hook,updated_at=excluded.updated_at
      WHERE project_id=excluded.project_id`)
      .run(input.nodeId, input.projectId, input.summary ?? existing?.summary ?? '', JSON.stringify(input.beats ?? existing?.beats ?? []),
        input.hook ?? existing?.hook ?? '', Date.now())
    const saved = this.getOutline(input.projectId, input.nodeId)
    if (!saved) throw new Error('DOCUMENT_NOT_FOUND_IN_PROJECT')
    return saved
  }

  /**
   * S4：输入 N 行细纲 → 在指定卷下生成 N 个空章节（0 字=构思；status 列属 S11）并写入细纲 summary。
   * 顺序：追加在卷内已有章之后，order_index 递增。不套外层事务（createNode 自带事务）。
   */
  batchCreateChaptersFromOutlines(input: { projectId: string; volumeId: string; lines: string[] }): DocumentNode[] {
    const volume = this.assertNode(input.projectId, input.volumeId)
    if (volume.type !== 'volume') throw new Error('CHAPTER_REQUIRES_VOLUME')
    const lines = input.lines.map((line) => line.trim()).filter((line) => line.length > 0)
    if (!lines.length) throw new Error('BATCH_OUTLINE_LINES_REQUIRED')
    if (lines.length > 200) throw new Error('BATCH_OUTLINE_LINES_TOO_MANY')
    const created: DocumentNode[] = []
    for (const line of lines) {
      const existing = this.db.raw.prepare(`
        SELECT COUNT(*) AS n FROM document_nodes WHERE project_id = ? AND parent_id = ? AND type = 'chapter'
      `).get(input.projectId, input.volumeId) as { n: number }
      const title = `第${existing.n + 1}章`
      const node = this.createNode({ projectId: input.projectId, parentId: input.volumeId, type: 'chapter', title })
      this.saveOutline({ projectId: input.projectId, nodeId: node.id, summary: line, beats: [], hook: '' })
      created.push(node)
    }
    return created
  }

  hashRange(text: string): string {
    return createHash('sha256').update(text).digest('hex')
  }
}

function mapOutline(row: Record<string, unknown>): NodeOutline {
  return { nodeId: row.node_id as string, projectId: row.project_id as string, summary: row.summary as string,
    beats: JSON.parse(row.beats_json as string) as string[], hook: row.hook as string, updatedAt: row.updated_at as number }
}
