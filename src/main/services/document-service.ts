import { createHash, randomUUID } from 'node:crypto'
import type { DocumentContent, DocumentNode, DocumentType, SearchResult, Snapshot, TextOrigin } from '../../shared/domain'
import type { AppDatabase } from '../database/database'
import { StyleSampleService } from './style-sample-service'

type NodeRow = {
  id: string; project_id: string; parent_id: string | null; type: DocumentType; title: string
  order_index: number; word_count: number | null; revision: number | null; created_at: number; updated_at: number
}
type ContentRow = {
  document_id: string; project_id: string; editor_json: string; plain_text: string
  word_count: number; revision: number; updated_at: number
}

const mapNode = (row: NodeRow): DocumentNode => ({
  id: row.id, projectId: row.project_id, parentId: row.parent_id, type: row.type, title: row.title,
  orderIndex: row.order_index, wordCount: row.word_count ?? 0, revision: row.revision ?? 0,
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

export class DocumentService {
  private readonly styleSamples: StyleSampleService
  constructor(private readonly db: AppDatabase) { this.styleSamples = new StyleSampleService(db) }

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
      this.db.raw.prepare(`INSERT INTO document_nodes
        (id, project_id, parent_id, type, title, order_index, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.projectId, input.parentId ?? null, input.type, input.title.trim(), max.value + 1, now, now)
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

  saveContent(input: { projectId: string; documentId: string; editorJson: Record<string, unknown>; plainText: string; expectedRevision?: number; styleSample?: { origin: TextOrigin; text: string } }): DocumentContent {
    const current = this.getContent(input.projectId, input.documentId)
    if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) throw new Error('REVISION_CONFLICT')
    const deletion = current.plainText.length - input.plainText.length
    if (deletion > 1000) this.createSnapshot(input.projectId, input.documentId, 'large_delete')
    const latestSnapshot = this.db.raw.prepare('SELECT created_at FROM snapshots WHERE project_id = ? AND document_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(input.projectId, input.documentId) as { created_at: number } | undefined
    if (current.revision > 0 && (!latestSnapshot || Date.now() - latestSnapshot.created_at >= 10 * 60 * 1000)) {
      this.createSnapshot(input.projectId, input.documentId, 'interval')
    }
    const now = Date.now()
    const revision = current.revision + 1
    const wordCount = countChineseWords(input.plainText)
    this.db.transaction(() => {
      this.db.raw.prepare(`UPDATE document_contents SET editor_json = ?, plain_text = ?, word_count = ?, revision = ?, updated_at = ?
        WHERE document_id = ? AND project_id = ?`)
        .run(JSON.stringify(input.editorJson), input.plainText, wordCount, revision, now, input.documentId, input.projectId)
      this.db.raw.prepare('UPDATE document_nodes SET updated_at = ? WHERE id = ? AND project_id = ?')
        .run(now, input.documentId, input.projectId)
      this.db.raw.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, input.projectId)
      this.db.raw.prepare('DELETE FROM document_fts WHERE document_id = ? AND project_id = ?').run(input.documentId, input.projectId)
      const node = this.assertNode(input.projectId, input.documentId)
      this.db.raw.prepare('INSERT INTO document_fts(project_id, document_id, title, plain_text) VALUES (?, ?, ?, ?)')
        .run(input.projectId, input.documentId, node.title, input.plainText)
      this.db.raw.prepare('UPDATE chapter_digests SET stale = 1 WHERE chapter_id = ? AND project_id = ? AND chapter_revision < ?')
        .run(input.documentId, input.projectId, revision)
      this.db.raw.prepare(`UPDATE memories SET status = 'rejected', updated_at = ?
        WHERE project_id = ? AND source_type = 'chapter' AND source_id = ? AND status = 'suggested'`)
        .run(now, input.projectId, input.documentId)
      if (input.styleSample) this.styleSamples.record({ projectId: input.projectId, documentId: input.documentId,
        origin: input.styleSample.origin, text: input.styleSample.text, sourceRevision: revision })
      else this.styleSamples.recordHumanIfSafe(input.projectId, input.documentId, input.plainText, revision)
    })
    return this.getContent(input.projectId, input.documentId)
  }

  createSnapshot(projectId: string, documentId: string, reason: Snapshot['reason'], metadata: Record<string, unknown> = {}): Snapshot {
    const current = this.getContent(projectId, documentId)
    const snapshot: Snapshot = {
      id: randomUUID(), projectId, documentId, reason, revision: current.revision,
      content: JSON.stringify(current.editorJson), plainText: current.plainText, metadata, createdAt: Date.now()
    }
    this.db.raw.prepare(`INSERT INTO snapshots
      (id, project_id, document_id, reason, revision, content, plain_text, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(snapshot.id, projectId, documentId, reason, snapshot.revision, snapshot.content, snapshot.plainText, JSON.stringify(metadata), snapshot.createdAt)
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
    this.createSnapshot(projectId, documentId, 'pre_restore', { restoredFrom: snapshotId })
    return this.saveContent({
      projectId, documentId, editorJson: JSON.parse(row.content as string) as Record<string, unknown>, plainText: row.plain_text as string
    })
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

  hashRange(text: string): string {
    return createHash('sha256').update(text).digest('hex')
  }
}
